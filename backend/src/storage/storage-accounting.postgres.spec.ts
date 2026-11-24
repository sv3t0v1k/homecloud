import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";

import { ConfigService } from "@nestjs/config";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { UserEntity } from "../entities/user.entity";
import { ShareLinkEntity } from "../entities/share-link.entity";
import { UploadSessionEntity } from "../entities/upload-session.entity";
import {
  LEGACY_UPLOAD_WORKSPACE,
  SSD_UPLOAD_WORKSPACE,
} from "../entities/upload-workspace.entity";
import { UsersService } from "../users/users.service";
import { StorageService } from "./storage.service";
import { UploadsService } from "../uploads/uploads.service";
import { SsdUploadsService } from "../uploads/ssd-uploads.service";
import { SecureFilesystem } from "../uploads/secure-filesystem";
import { PreparedSsdWorkspace } from "../uploads/prepared-ssd-workspace";
import {
  UploadWorkspaceResolver,
  UploadWorkspaceIdentity,
} from "../uploads/upload-workspace";
import { SharingService } from "../sharing/sharing.service";
import { PublicFolderService } from "../sharing/public-folder.service";
import { PublicUploadsService } from "../sharing/public-uploads.service";


import appDataSource from "../data-source";
import {
  LEGACY_UPLOAD_WORKSPACE_ID,
  SSD_UPLOAD_WORKSPACE_ID,
} from "../entities/upload-workspace.entity";
import { FileCopyAdmissionService } from "../files/file-copy-admission.service";
import { PostgresSsdFinalizationStore } from "../uploads/ssd-finalization-store";
import { LEGACY_STORAGE_ID } from "./storage-placement";
import {
  canAddStorageBytes,
  canSetStorageQuota,
  lockStorageCommitments,
  MAX_STORAGE_BYTES,
  readStorageCommitments,
} from "./storage-accounting";

const url = process.env.HOMECLOUD_TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

postgres("Shared storage accounting on migrated PostgreSQL", () => {
  const schema = `storage_accounting_${randomUUID().replace(/-/g, "")}`;
  const digest = "a".repeat(64);

  let admin: DataSource;
  let db: DataSource;
  let fixtureRoot: string;
  let root: string;
  let ssd: string;
  let oldRoot: string | undefined;
  let oldSsd: string | undefined;
  let copies: FileCopyAdmissionService;

  beforeAll(async () => {
    // Disposable storage fixture only. No checkout, worktree,
    // repository copy, or production storage directory.
    // The CI integration step runs as an unprivileged user, so the
    // fixture must live in the system temp dir, not in root-owned node_modules.
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), ".hc-accounting-"));

    root = path.join(fixtureRoot, "hdd");
    ssd = path.join(fixtureRoot, "ssd");

    fs.mkdirSync(root);
    fs.mkdirSync(path.join(root, ".tmp"));
    fs.mkdirSync(ssd);

    oldRoot = process.env.STORAGE_PATH;
    oldSsd = process.env.UPLOAD_SSD_PATH;

    process.env.STORAGE_PATH = root;
    process.env.UPLOAD_SSD_PATH = ssd;

    admin = new DataSource({
      type: "postgres",
      url,
    });

    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);

    db = new DataSource({
      type: "postgres",
      url,
      schema,
      entities: appDataSource.options.entities,
      migrations: appDataSource.options.migrations,
      synchronize: false,
      migrationsRun: false,
      logging: false,
      extra: {
        max: 8,
        connectionTimeoutMillis: 3000,
        options:
          `-c search_path=${schema} ` +
          "-c statement_timeout=12000 -c lock_timeout=8000",
      },
    });

    await db.initialize();

    const applied = await db.runMigrations();

    // Fail setup if the complete migration inventory is not
    // installed. Do not use Jest assertions outside test blocks.
    if (applied.length !== 35) {
      throw new Error(
        `Expected 35 migrations, applied ${applied.length}`,
      );
    }

    if (await db.showMigrations()) {
      throw new Error("Unexpected pending runtime migrations");
    }

    copies = new FileCopyAdmissionService(db);
  }, 30000);

  afterAll(async () => {
    try {
      if (db?.isInitialized) await db.destroy();

      if (admin?.isInitialized) {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.destroy();
      }
    } finally {
      if (fixtureRoot) {
        fs.rmSync(fixtureRoot, {
          recursive: true,
          force: true,
        });
      }

      if (oldRoot === undefined) {
        delete process.env.STORAGE_PATH;
      } else {
        process.env.STORAGE_PATH = oldRoot;
      }

      if (oldSsd === undefined) {
        delete process.env.UPLOAD_SSD_PATH;
      } else {
        process.env.UPLOAD_SSD_PATH = oldSsd;
      }
    }
  }, 30000);

  async function owner(
    quota = "1000",
    used = "0",
  ): Promise<number> {
    const [row] = await db.query(
      `INSERT INTO users (
         email, password, name,
         "storageQuota", "storageUsed"
       )
       VALUES ($1, 'fixture-not-login', 'Fixture', $2, $3)
       RETURNING id`,
      [`${randomUUID()}@example.test`, quota, used],
    );

    return row.id;
  }

  async function ordinaryFile(
    userId: number,
    bytes: number,
    deleted = false,
    relativeObjectKey = `${userId}/${randomUUID()}.bin`,
  ): Promise<number> {
    const [row] = await db.query(
      `INSERT INTO files (
         name, "userId", size, "isDeleted",
         "storageLocationId", "relativeObjectKey",
         "storagePath"
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [
        path.basename(relativeObjectKey),
        userId,
        bytes,
        deleted,
        LEGACY_STORAGE_ID,
        relativeObjectKey,
        path.join(root, relativeObjectKey),
      ],
    );

    return row.id;
  }

  async function publicBinding(userId: number) {
    const [folder] = await db.query(
      `INSERT INTO folders (name, "userId")
       VALUES ('shared', $1) RETURNING id`,
      [userId],
    );

    const [mirror] = await db.query(
      `INSERT INTO files (
         name, "userId", "isFolder", "folderId", size
       )
       VALUES ('shared', $1, true, $2, 0)
       RETURNING id`,
      [userId, folder.id],
    );

    const [share] = await db.query(
      `INSERT INTO share_links (
         token, "userId", "fileId",
         "isFolder", "allowUpload"
       )
       VALUES ($1,$2,$3,true,true)
       RETURNING id`,
      [randomUUID(), userId, mirror.id],
    );

    return {
      folderId: folder.id as number,
      shareId: share.id as number,
    };
  }

  type SessionOptions = {
    ssd?: boolean;
    completeChunks?: boolean;
    expired?: boolean;
    status?: "pending" | "uploading" | "completed" | "aborted";
    publicBinding?: {
      folderId: number;
      shareId: number;
    };
  };

  async function session(
    userId: number,
    bytes: string,
    options: SessionOptions = {},
    manager = db.manager,
  ): Promise<{ id: number; uploadId: string }> {
    const uploadId = randomUUID();
    const useSsd = options.ssd === true;
    const binding = options.publicBinding;

    const workspaceId = useSsd
      ? SSD_UPLOAD_WORKSPACE_ID
      : LEGACY_UPLOAD_WORKSPACE_ID;

    const tempPath = path.join(
      useSsd ? ssd : path.join(root, ".tmp"),
      uploadId,
    );

    const complete = options.completeChunks === true;

    const [row] = await manager.query(
      `INSERT INTO upload_sessions (
         "uploadId", filename, "userId", "totalSize",
         "workspaceId", "tempPath", status,
         "chunkSize", "totalChunks", "uploadedSize",
         "uploadedCount", "accountingInitialized",
         "expectedSha256", "expiresAt",
         origin, "parentId",
         "shareRootFolderId", "shareLinkId"
       )
       VALUES (
         $1, 'fixture.bin', $2, $3, $4, $5, $6,
         $7, 1, $8, $9, true, $10, $11,
         $12, $13, $13, $14
       )
       RETURNING id, "uploadId"`,
      [
        uploadId,
        userId,
        bytes,
        workspaceId,
        tempPath,
        options.status ?? (complete ? "uploading" : "pending"),
        complete ? Number(bytes) : 1,
        complete ? bytes : "0",
        complete ? 1 : 0,
        digest,
        options.expired
          ? new Date("2020-01-01T00:00:00Z")
          : new Date("2035-01-01T00:00:00Z"),
        binding ? "public" : "owner",
        binding?.folderId ?? null,
        binding?.shareId ?? null,
      ],
    );

    if (complete) {
      await manager.query(
        `INSERT INTO upload_chunks (
           "sessionId", "chunkIndex", "byteSize", sha256
         )
         VALUES ($1,0,$2,$3)`,
        [row.id, bytes, digest],
      );
    }

    return row;
  }

  function copyRequest(
    userId: number,
    sourceFileId: number,
    bytes = 100,
  ) {
    return {
      userId,
      sourceFileId,
      bytes,
      storageLocationId: LEGACY_STORAGE_ID,
      relativeObjectKey: `${userId}/${randomUUID()}.bin`,
    };
  }

  async function waitForBlocked(
    waitingPid: number,
    blockingPid: number,
  ): Promise<void> {
    const deadline = Date.now() + 5000;

    while (Date.now() < deadline) {
      const [row] = await db.query(
        `SELECT $2::int = ANY(pg_blocking_pids($1::int))
           AS blocked`,
        [waitingPid, blockingPid],
      );

      if (row.blocked === true) return;

      await new Promise<void>((resolve) =>
        setTimeout(resolve, 20),
      );
    }

    throw new Error("Expected PostgreSQL lock wait not observed");
  }


  // These admission tests use the actual production services,
  // repositories, SQL, migration triggers and transactions.
  //
  // Only the Linux-native filesystem capability is substituted.
  // No database accounting, owner lock, quota check, public
  // proof, receipt or session persistence is mocked.
  function admissionServices(maxTotal = 1000) {
    const temp = path.join(root, ".tmp");

    const checkPath = (target: string, base: string): string => {
      if (
        target !== base &&
        !target.startsWith(base + path.sep)
      ) {
        throw new Error("Fixture path escapes its scratch root");
      }

      if (path.resolve(target) !== target) {
        throw new Error("Noncanonical fixture path");
      }

      return target;
    };

    const nativeBoundary = (
      base: string,
    ): SecureFilesystem => ({
      stat: (target: string) =>
        fs.lstatSync(checkPath(target, base)),
      lock: jest.fn(),
      mkdir: (target: string) =>
        fs.mkdirSync(
          checkPath(target, base),
          { recursive: true, mode: 0o700 },
        ),
      sync: (target: string) => {
        const fd = fs.openSync(
          checkPath(target, base),
          fs.constants.O_RDONLY,
        );

        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      },
      close: jest.fn(),
    }) as unknown as SecureFilesystem;

    const validateIdentity = (
      record: UploadWorkspaceIdentity | null | undefined,
      expected: UploadWorkspaceIdentity,
    ): void => {
      if (
        !record ||
        record.id !== expected.id ||
        record.machineKey !== expected.machineKey ||
        record.mountKey !== expected.mountKey ||
        record.type !== expected.type
      ) {
        throw new Error("Unexpected fixture workspace identity");
      }
    };

    const legacyBoundary = nativeBoundary(temp);
    const ssdBoundary = nativeBoundary(ssd);

    const storage = {
      getTempPath: () => temp,
      getStoragePath: () => root,
      assertTrustedPath: (target: string) =>
        checkPath(target, root),
      getPreparedSsdRoot: () => ssd,
      assertPreparedSsdPath: (target: string) =>
        checkPath(target, ssd),
    } as unknown as StorageService;

    const config = new ConfigService({
      STORAGE_PATH: root,
      JWT_SECRET: "fixture-accounting-public-proof-secret",
      MAX_FILE_SIZE: 1000,
      MAX_TOTAL_SIZE: maxTotal,
      MAX_CHUNK_SIZE: 1000,
      UPLOAD_SSD_ENABLED: "true",
      NODE_ENV: "test",
    });

    const legacy = new UploadsService(
      db.getRepository(UploadSessionEntity),
      db.getRepository(FileEntity),
      db.getRepository(FolderEntity),
      storage,
      new UsersService(db.getRepository(UserEntity)),
      config,
    );

    const resolver = (
      legacy as unknown as {
        workspaceResolver: UploadWorkspaceResolver;
      }
    ).workspaceResolver;

    // Keep getWorkspace() and its real repository lookup.
    // Substitute only the descriptor-backed path adapter.
    jest.spyOn(resolver, "validate")
      .mockImplementation((record) =>
        validateIdentity(record, LEGACY_UPLOAD_WORKSPACE),
      );

    jest.spyOn(resolver, "root")
      .mockImplementation((record) => {
        resolver.validate(record);
        return temp;
      });

    jest.spyOn(resolver, "resolve")
      .mockImplementation((upload, record) => {
        resolver.validate(record);

        const expected = path.join(temp, upload.uploadId);

        if (
          upload.workspaceId !== LEGACY_UPLOAD_WORKSPACE.id ||
          upload.tempPath !== expected
        ) {
          throw new Error("Invalid legacy fixture binding");
        }

        return checkPath(expected, temp);
      });

    jest.spyOn(resolver, "assertPath")
      .mockImplementation((target) =>
        checkPath(target, temp),
      );

    jest.spyOn(resolver, "filesystem")
      .mockReturnValue(legacyBoundary);

    const ssdService = new SsdUploadsService(
      db,
      storage,
      config,
      new PostgresSsdFinalizationStore(db, "ssd"),
    );

    const prepared = (
      ssdService as unknown as {
        prepared: PreparedSsdWorkspace;
      }
    ).prepared;

    // Keep the SSD service's actual workspace lookup, root
    // FD open, capacity SQL and durable database checks.
    // Only native flock / descriptor I/O are substituted.
    jest.spyOn(prepared, "root")
      .mockImplementation((record) => {
        validateIdentity(record, SSD_UPLOAD_WORKSPACE);
        return ssd;
      });

    jest.spyOn(prepared, "filesystem")
      .mockImplementation((record) => {
        validateIdentity(record, SSD_UPLOAD_WORKSPACE);
        return ssdBoundary;
      });

    const shares = new SharingService(
      db.getRepository(ShareLinkEntity),
      db.getRepository(FileEntity),
      db.getRepository(UserEntity),
      config,
      storage,
    );

    const folders = new PublicFolderService(
      db, shares, config,
    );

    const publicUploads = new PublicUploadsService(
      db, folders, legacy,
    );

    async function publicAccess(userId: number) {
      const binding = await publicBinding(userId);

      const [share] = await db.query(
        `SELECT token FROM share_links WHERE id=$1`,
        [binding.shareId],
      );

      const token = share.token as string;
      const { proof } = await folders.authorize(token);

      return {
        ...binding,
        token,
        proof,
        create: (size: number, key = randomUUID()) =>
          publicUploads.create(token, proof, key, {
            parentId: binding.folderId,
            filename: "public.bin",
            totalSize: size,
            chunkSize: size,
            expectedSha256: digest,
          }),
      };
    }

    return {
      legacy,
      ssd: ssdService,
      publicUploads,
      publicAccess,
      legacyStart: (userId: number, bytes: number) =>
        legacy.createUploadSession(
          userId, "legacy.bin", bytes, bytes,
        ),
      ssdStart: (userId: number, bytes: number) =>
        ssdService.createUploadSession(
          userId,
          "ssd.bin",
          bytes,
          bytes,
          undefined,
          digest,
        ),
    };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function waitForAdmissionWaiters(
    gatePid: number,
    minimum: number,
    timeoutMs = 4000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const [row] = await db.query(
        `SELECT COUNT(*)::int AS count,
                COALESCE(
                  BOOL_OR($1::int=ANY(pg_blocking_pids(a.pid))),
                  false
                ) AS blocked
         FROM pg_stat_activity a
         WHERE a.datname=current_database()
           AND a.pid<>pg_backend_pid()
           AND a.wait_event_type='Lock'
           AND a.query ILIKE '%FOR UPDATE%'
           AND a.query ILIKE '%users%'`,
        [gatePid],
      );

      if (row.count >= minimum && row.blocked === true) {
        return;
      }

      await new Promise<void>((resolve) =>
        setTimeout(resolve, 10),
      );
    }

    throw new Error(
      "Expected real owner-row admission lock wait was not observed",
    );
  }

  // -------------------------------------------------------
  // REAL LEGACY / SSD / PUBLIC SHARED ACCOUNTING
  // -------------------------------------------------------

  it("admits real legacy SSD and public uploads at exact combined quota and replays the public receipt without new bytes", async () => {
    const userId = await owner("100", "20");
    const sourceId = await ordinaryFile(userId, 20);
    const services = admissionServices();
    const binding = await services.publicAccess(userId);

    const copyId = await copies.reserve(
      copyRequest(userId, sourceId, 20),
    );

    try {
      const legacy = await services.legacyStart(userId, 20);
      const ssdUpload = await services.ssdStart(userId, 20);

      expect(legacy.workspaceId)
        .toBe(LEGACY_UPLOAD_WORKSPACE_ID);

      expect(ssdUpload.workspaceId)
        .toBe(SSD_UPLOAD_WORKSPACE_ID);

      const key = randomUUID();

      const first = await binding.create(20, key);

      expect(first).toMatchObject({
        totalSize: 20,
        status: "pending",
      });

      const accounting = await readStorageCommitments(
        db.manager, userId,
      );

      expect(accounting).toMatchObject({
        used: 20n,
        uploadBytes: 60n,
        copyBytes: 20n,
        activeCopyCount: 1n,
        committedBytes: 100n,
        remainingBytes: 0n,
      });

      // Public replay must succeed at exhausted quota.
      const replay = await binding.create(20, key);

      expect(replay.uploadId).toBe(first.uploadId);

      expect(await readStorageCommitments(
        db.manager, userId,
      )).toEqual(accounting);

      await expect(
        services.legacyStart(userId, 1),
      ).rejects.toMatchObject({
        status: 403,
        message: "Storage quota exceeded",
      });

      await expect(
        services.ssdStart(userId, 1),
      ).rejects.toMatchObject({
        status: 400,
        message: "Storage quota exceeded",
      });

      await expect(
        binding.create(1),
      ).rejects.toMatchObject({
        status: 403,
        message: "Storage quota exceeded",
      });

      expect(await db.query(
        `SELECT origin, COUNT(*)::int AS count
         FROM upload_sessions
         WHERE "userId"=$1
         GROUP BY origin
         ORDER BY origin`,
        [userId],
      )).toEqual([
        { origin: "owner", count: 2 },
        { origin: "public", count: 1 },
      ]);

      expect(await db.query(
        `SELECT "resultUploadSessionId"
         FROM public_share_operations
         WHERE "shareLinkId"=$1`,
        [binding.shareId],
      )).toHaveLength(1);

      // Same key with changed input cannot allocate a
      // second reservation or replay the wrong operation.
      await expect(
        binding.create(21, key),
      ).rejects.toMatchObject({
        status: 409,
      });

      expect(await readStorageCommitments(
        db.manager, userId,
      )).toEqual(accounting);
    } finally {
      await copies.releaseAfterOwnedCleanup(
        copyId, userId, () => undefined,
      );
    }
  });

  it("keeps the active upload cap independent from real copy reservations", async () => {
    const userId = await owner("2000", "500");
    const sourceId = await ordinaryFile(userId, 500);
    const services = admissionServices(60);

    const copyId = await copies.reserve(
      copyRequest(userId, sourceId, 500),
    );

    try {
      await services.legacyStart(userId, 30);
      await services.ssdStart(userId, 30);

      expect(await readStorageCommitments(
        db.manager, userId,
      )).toMatchObject({
        used: 500n,
        copyBytes: 500n,
        uploadBytes: 60n,
        committedBytes: 1060n,
        remainingBytes: 940n,
      });

      await expect(
        services.legacyStart(userId, 1),
      ).rejects.toMatchObject({
        status: 400,
        message: "Total upload size exceeds allowed maximum",
      });

      await expect(
        services.ssdStart(userId, 1),
      ).rejects.toMatchObject({
        status: 400,
        message: "Active upload limit exceeded",
      });

      expect(await db.getRepository(
        UploadSessionEntity,
      ).countBy({ userId })).toBe(2);
    } finally {
      await copies.releaseAfterOwnedCleanup(
        copyId, userId, () => undefined,
      );
    }
  });

  it("rejects corrupt active accounting through all three real upload admission paths", async () => {
    const userId = await owner("1000");
    const services = admissionServices();
    const binding = await services.publicAccess(userId);

    await session(userId, "20");
    await session(userId, "-1");

    const results = await Promise.allSettled([
      services.legacyStart(userId, 1),
      services.ssdStart(userId, 1),
      binding.create(1),
    ]);

    for (const result of results) {
      expect(result).toMatchObject({
        status: "rejected",
        reason: {
          status: 503,
          response: {
            code: "STORAGE_ACCOUNTING_UNAVAILABLE",
          },
        },
      });
    }

    expect(await db.getRepository(
      UploadSessionEntity,
    ).countBy({ userId })).toBe(2);

    expect(await db.query(
      `SELECT id FROM public_share_operations
       WHERE "shareLinkId"=$1`,
      [binding.shareId],
    )).toEqual([]);
  });

  it("denies inactive owner admissions and denies a previously valid public proof", async () => {
    const userId = await owner("1000");
    const services = admissionServices();
    const binding = await services.publicAccess(userId);

    await db.query(
      `UPDATE users SET "isActive"=false WHERE id=$1`,
      [userId],
    );

    await expect(
      services.legacyStart(userId, 10),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      services.ssdStart(userId, 10),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      binding.create(10),
    ).rejects.toMatchObject({ status: 404 });

    expect(await db.getRepository(
      UploadSessionEntity,
    ).countBy({ userId })).toBe(0);

    expect(await db.query(
      `SELECT id FROM public_share_operations
       WHERE "shareLinkId"=$1`,
      [binding.shareId],
    )).toEqual([]);
  });

  // -------------------------------------------------------
  // REAL CONCURRENT UPLOAD AND COPY ADMISSION
  // -------------------------------------------------------

  it.each(["legacy", "ssd"] as const)(
    "serializes actual %s upload and copy admission on the same remaining quota",
    async (kind) => {
      const userId = await owner("120", "60");
      const sourceId = await ordinaryFile(userId, 60);
      const services = admissionServices();

      const gate = db.createQueryRunner();

      let uploadResult:
        Promise<PromiseSettledResult<UploadSessionEntity>[]> |
        undefined;

      let copyResult:
        Promise<PromiseSettledResult<string>[]> |
        undefined;

      let copyId: string | undefined;

      try {
        await gate.connect();
        await gate.startTransaction("READ COMMITTED");

        const [identity] = await gate.query(
          `SELECT pg_backend_pid() AS pid`,
        );

        await lockStorageCommitments(
          gate.manager, userId,
        );

        uploadResult = Promise.allSettled([
          kind === "legacy"
            ? services.legacyStart(userId, 60)
            : services.ssdStart(userId, 60),
        ]);

        await waitForAdmissionWaiters(
          identity.pid, 1,
        );

        // Copy admission has its own 1500 ms lock timeout.
        // Start it last and observe both actual lock waits
        // before immediately releasing the owner gate.
        copyResult = Promise.allSettled([
          copies.reserve(
            copyRequest(userId, sourceId, 60),
          ),
        ]);

        await waitForAdmissionWaiters(
          identity.pid, 2, 1000,
        );

        await gate.commitTransaction();

        const [upload] = await uploadResult;
        const [copy] = await copyResult;

        if (copy.status === "fulfilled") {
          copyId = copy.value;
        }

        expect(
          [upload.status, copy.status].sort(),
        ).toEqual(["fulfilled", "rejected"]);

        const accounting = await readStorageCommitments(
          db.manager, userId,
        );

        expect(accounting).toMatchObject({
          used: 60n,
          committedBytes: 120n,
          remainingBytes: 0n,
        });

        const uploadWon = upload.status === "fulfilled";

        const expectedUploadBytes = uploadWon ? 60n : 0n;
        const expectedCopyBytes = uploadWon ? 0n : 60n;

        const rejectedOperation = uploadWon ? copy : upload;

        const expectedRejectionStatus =
          uploadWon || kind === "legacy" ? 403 : 400;

        // Both race outcomes must execute every assertion.
        // A timeout or unrelated rejection cannot pass.
        expect(accounting.uploadBytes).toBe(expectedUploadBytes);
        expect(accounting.copyBytes).toBe(expectedCopyBytes);

        expect(rejectedOperation).toMatchObject({
          status: "rejected",
          reason: {
            status: expectedRejectionStatus,
            message: "Storage quota exceeded",
          },
        });

        expect(await db.getRepository(
          UploadSessionEntity,
        ).countBy({ userId })).toBe(
          upload.status === "fulfilled" ? 1 : 0,
        );
      } finally {
        if (gate.isTransactionActive) {
          await gate.rollbackTransaction();
        }

        if (uploadResult) await uploadResult;

        if (copyResult) {
          const [copy] = await copyResult;

          if (copy.status === "fulfilled") {
            copyId = copy.value;
          }
        }

        await gate.release();

        if (copyId) {
          await copies.releaseAfterOwnedCleanup(
            copyId, userId, () => undefined,
          );
        }
      }
    },
    30000,
  );

  // -------------------------------------------------------
  // QUOTA REDUCTION RACES
  // -------------------------------------------------------

  it.each(["legacy", "ssd", "public"] as const)(
    "makes real %s admission observe a concurrently reduced quota after the owner lock",
    async (kind) => {
      const userId = await owner("100");
      const services = admissionServices();
      const binding = kind === "public"
        ? await services.publicAccess(userId)
        : undefined;

      const gate = db.createQueryRunner();

      let result:
        Promise<PromiseSettledResult<unknown>[]> |
        undefined;

      try {
        await gate.connect();
        await gate.startTransaction("READ COMMITTED");

        const [identity] = await gate.query(
          `SELECT pg_backend_pid() AS pid`,
        );

        const accounting = await lockStorageCommitments(
          gate.manager, userId,
        );

        expect(canSetStorageQuota(
          accounting, 50n,
        )).toBe(true);

        // Actual quota-update locking protocol.
        // Admin HTTP PATCH remains closed until 01.5D.
        await gate.query(
          `UPDATE users SET "storageQuota"=50 WHERE id=$1`,
          [userId],
        );

        result = Promise.allSettled([
          kind === "legacy"
            ? services.legacyStart(userId, 60)
            : kind === "ssd"
              ? services.ssdStart(userId, 60)
              : binding!.create(60),
        ]);

        await waitForAdmissionWaiters(
          identity.pid, 1,
        );

        await gate.commitTransaction();

        expect(await result).toEqual([
          {
            status: "rejected",
            reason: expect.objectContaining({
              status: kind === "ssd" ? 400 : 403,
              message: "Storage quota exceeded",
            }),
          },
        ]);

        expect(await readStorageCommitments(
          db.manager, userId,
        )).toMatchObject({
          quota: 50n,
          used: 0n,
          uploadBytes: 0n,
          copyBytes: 0n,
          committedBytes: 0n,
        });

        expect(await db.getRepository(
          UploadSessionEntity,
        ).countBy({ userId })).toBe(0);

        expect(await db.query(
          `SELECT id FROM public_share_operations
           WHERE "userId"=$1`,
          [userId],
        )).toEqual([]);
      } finally {
        if (gate.isTransactionActive) {
          await gate.rollbackTransaction();
        }

        if (result) await result;

        await gate.release();
      }
    },
    30000,
  );

  it("includes legacy, SSD, public and retained copy reservations without counting terminal or foreign sessions", async () => {
    const userId = await owner("1000", "400");
    const otherId = await owner("10000");

    const sourceId = await ordinaryFile(userId, 100);
    await ordinaryFile(userId, 300, true);

    // Expired but not durably released: still reserved.
    await session(userId, "100", { expired: true });

    await session(userId, "100", {
      ssd: true,
      status: "uploading",
    });

    const binding = await publicBinding(userId);

    await session(userId, "100", {
      publicBinding: binding,
    });

    await session(userId, "2000", {
      status: "completed",
    });

    await session(userId, "3000", {
      status: "aborted",
    });

    await session(otherId, "900");

    const operationId = await copies.reserve(
      copyRequest(userId, sourceId),
    );

    try {
      const accounting = await readStorageCommitments(
        db.manager, userId,
      );

      expect(accounting).toEqual({
        userId,
        isActive: true,
        quota: 1000n,
        used: 400n,
        uploadBytes: 300n,
        copyBytes: 100n,
        activeCopyCount: 1n,
        committedBytes: 800n,
        remainingBytes: 200n,
      });

      expect(canAddStorageBytes(accounting, 200n)).toBe(true);
      expect(canAddStorageBytes(accounting, 201n)).toBe(false);
      expect(canSetStorageQuota(accounting, 800n)).toBe(true);
      expect(canSetStorageQuota(accounting, 799n)).toBe(false);

      expect((await readStorageCommitments(
        db.manager, otherId,
      )).committedBytes).toBe(900n);
    } finally {
      await copies.releaseAfterOwnedCleanup(
        operationId, userId, () => undefined,
      );
    }
  });

  it("retains cleanup_required copy bytes until durable release", async () => {
    const userId = await owner("1000", "100");
    const sourceId = await ordinaryFile(userId, 100);

    const operationId = await copies.reserve(
      copyRequest(userId, sourceId),
    );

    await expect(copies.releaseAfterOwnedCleanup(
      operationId,
      userId,
      () => {
        throw new Error("fixture cleanup failure");
      },
    )).rejects.toThrow("fixture cleanup failure");

    expect(await readStorageCommitments(
      db.manager, userId,
    )).toMatchObject({
      used: 100n,
      copyBytes: 100n,
      activeCopyCount: 1n,
      committedBytes: 200n,
    });

    const [operation] = await db.query(
      `SELECT state FROM file_copy_operations WHERE id=$1`,
      [operationId],
    );

    expect(operation.state).toBe("cleanup_required");

    await copies.releaseAfterOwnedCleanup(
      operationId, userId, () => undefined,
    );

    expect(await readStorageCommitments(
      db.manager, userId,
    )).toMatchObject({
      used: 100n,
      copyBytes: 0n,
      activeCopyCount: 0n,
      committedBytes: 100n,
    });
  });

  it("transfers a committed copy reservation into used bytes exactly once", async () => {
    const userId = await owner("1000", "100");
    const sourceId = await ordinaryFile(userId, 100);
    const placement = copyRequest(userId, sourceId);

    const operationId = await copies.reserve(placement);

    await session(userId, "200");

    const before = await readStorageCommitments(
      db.manager, userId,
    );

    expect(before.committedBytes).toBe(400n);

    await db.transaction("READ COMMITTED", async (manager) => {
      await lockStorageCommitments(manager, userId);

      const [file] = await manager.query(
        `INSERT INTO files (
           name, "userId", size,
           "storageLocationId",
           "relativeObjectKey", "storagePath"
         )
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id`,
        [
          "published-copy.bin",
          userId,
          placement.bytes,
          placement.storageLocationId,
          placement.relativeObjectKey,
          path.join(root, placement.relativeObjectKey),
        ],
      );

      await manager.query(
        `UPDATE users
         SET "storageUsed"="storageUsed"+$2::bigint
         WHERE id=$1`,
        [userId, placement.bytes],
      );

      await copies.markCommitted(
        manager, operationId, userId, file.id,
      );

      const current = await readStorageCommitments(
        manager, userId,
      );

      expect(current).toMatchObject({
        used: 200n,
        uploadBytes: 200n,
        copyBytes: 0n,
        committedBytes: 400n,
      });
    });

    expect(await readStorageCommitments(
      db.manager, userId,
    )).toMatchObject({
      used: 200n,
      uploadBytes: 200n,
      copyBytes: 0n,
      committedBytes: before.committedBytes,
    });
  });

  it("counts an SSD journal only through its active session and preserves total commitments on commit and retry", async () => {
    const userId = await owner("1000", "100");

    const sourceId = await ordinaryFile(userId, 100);
    const copyId = await copies.reserve(
      copyRequest(userId, sourceId, 100),
    );

    await session(userId, "200");

    const upload = await session(userId, "4", {
      ssd: true,
      completeChunks: true,
    });

    const store = new PostgresSsdFinalizationStore(
      db, "ssd",
    );

    const operationId = randomUUID();

    const relativeObjectKey =
      `${userId}/${operationId}.ssd-finalized`;

    const input = {
      id: operationId,
      userId,
      uploadId: upload.uploadId,
      expectedSha256: digest,
      binding: {
        sourceWorkspaceId: SSD_UPLOAD_WORKSPACE_ID,
        sourceRoot: ssd,
        sourcePath: path.join(ssd, upload.uploadId),
        sourceDevice: "1",
        sourceInode: "2",
        sourceDirectoryDevice: "1",
        sourceDirectoryInode: "3",
        targetStorageId: LEGACY_STORAGE_ID,
        targetRoot: root,
        targetDevice: "4",
        targetInode: "5",
        targetDirectoryDevice: "4",
        targetDirectoryInode: "6",
        temporaryPath: path.join(
          root, String(userId), `.${operationId}.assembling`,
        ),
        storagePath: path.join(root, relativeObjectKey),
        relativeObjectKey,
      },
    };

    const before = await readStorageCommitments(
      db.manager, userId,
    );

    expect(before.committedBytes).toBe(404n);

    await store.begin(input);

    expect(await readStorageCommitments(
      db.manager, userId,
    )).toEqual(before);

    await store.recordTarget(operationId, {
      device: "4",
      inode: "42",
    });

    await store.transition(
      operationId, "assembling", "verified",
    );

    await store.recordMimeType(
      operationId, "application/octet-stream",
    );

    await store.transition(
      operationId, "verified", "publishing",
    );

    await store.transition(
      operationId, "publishing", "published",
    );

    expect(await readStorageCommitments(
      db.manager, userId,
    )).toEqual(before);

    const file = await store.commit(operationId);

    expect(file).toMatchObject({
      size: 4,
      uploadId: upload.uploadId,
      userId,
    });

    const after = await readStorageCommitments(
      db.manager, userId,
    );

    expect(after).toMatchObject({
      used: 104n,
      uploadBytes: 200n,
      copyBytes: 100n,
      committedBytes: before.committedBytes,
    });

    expect((await store.commit(operationId)).id)
      .toBe(file.id);

    expect(await readStorageCommitments(
      db.manager, userId,
    )).toEqual(after);

    await store.finishCleanup(operationId);

    expect(await readStorageCommitments(
      db.manager, userId,
    )).toEqual(after);

    await copies.releaseAfterOwnedCleanup(
      copyId, userId, () => undefined,
    );
  });

  it("preserves PostgreSQL numeric aggregates above the safe integer limit", async () => {
    const userId = await owner(
      MAX_STORAGE_BYTES.toString(),
      MAX_STORAGE_BYTES.toString(),
    );

    await session(userId, MAX_STORAGE_BYTES.toString());
    await session(userId, "2");

    const accounting = await readStorageCommitments(
      db.manager, userId,
    );

    expect(accounting.uploadBytes)
      .toBe(9007199254740993n);

    expect(accounting.committedBytes)
      .toBe(18014398509481984n);

    expect(accounting.remainingBytes).toBe(0n);

    expect(canSetStorageQuota(
      accounting, MAX_STORAGE_BYTES,
    )).toBe(false);
  });

  it("rejects an invalid active amount even if positive rows hide it in the total", async () => {
    const userId = await owner();

    await session(userId, "200");

    // Historical malformed data is possible: the upload
    // table does not constrain every individual totalSize.
    await session(userId, "-1");

    await expect(readStorageCommitments(
      db.manager, userId,
    )).rejects.toMatchObject({
      status: 503,
      response: {
        code: "STORAGE_ACCOUNTING_UNAVAILABLE",
      },
    });

    await db.query(
      `UPDATE upload_sessions SET status='aborted'
       WHERE "userId"=$1 AND "totalSize"<0`,
      [userId],
    );

    expect((await readStorageCommitments(
      db.manager, userId,
    )).committedBytes).toBe(200n);
  });

  it.each(["commit", "rollback"] as const)(
    "reads a fresh reservation snapshot after waiting for owner lock and writer %s",
    async (outcome) => {
      const userId = await owner("1000", "100");
      const writer = db.createQueryRunner();
      const reader = db.createQueryRunner();

      let pending: Promise<
        Awaited<ReturnType<typeof lockStorageCommitments>>
      > | undefined;

      try {
        await writer.connect();
        await reader.connect();

        const [writerIdentity] = await writer.query(
          `SELECT pg_backend_pid() AS pid`,
        );

        const [readerIdentity] = await reader.query(
          `SELECT pg_backend_pid() AS pid`,
        );

        await writer.startTransaction("READ COMMITTED");
        await reader.startTransaction("READ COMMITTED");

        await lockStorageCommitments(
          writer.manager, userId,
        );

        await session(
          userId, "300", {}, writer.manager,
        );

        // An informational reader must not see an
        // uncommitted reservation.
        expect((await readStorageCommitments(
          db.manager, userId,
        )).committedBytes).toBe(100n);

        pending = lockStorageCommitments(
          reader.manager, userId,
        );

        // Observe actual PostgreSQL blocking, not timing alone.
        await waitForBlocked(
          readerIdentity.pid,
          writerIdentity.pid,
        );

        if (outcome === "commit") {
          await writer.commitTransaction();
        } else {
          await writer.rollbackTransaction();
        }

        const accounting = await pending;

        expect(accounting.committedBytes).toBe(
          outcome === "commit" ? 400n : 100n,
        );

        expect(accounting.uploadBytes).toBe(
          outcome === "commit" ? 300n : 0n,
        );

        await reader.commitTransaction();
      } finally {
        if (writer.isTransactionActive) {
          await writer.rollbackTransaction();
        }

        if (pending) {
          await pending.catch(() => undefined);
        }

        if (reader.isTransactionActive) {
          await reader.rollbackTransaction();
        }

        await writer.release();
        await reader.release();
      }
    },
    30000,
  );

  it("makes a real concurrent copy admission observe a newly reduced quota", async () => {
    const userId = await owner("1000", "100");
    const sourceId = await ordinaryFile(userId, 100);
    const gate = db.createQueryRunner();

    let pending: Promise<string> | undefined;

    try {
      await gate.connect();
      await gate.startTransaction("READ COMMITTED");

      const [identity] = await gate.query(
        `SELECT pg_backend_pid() AS pid`,
      );

      const current = await lockStorageCommitments(
        gate.manager, userId,
      );

      expect(canSetStorageQuota(current, 150n)).toBe(true);

      // Simulate the future quota mutation under its
      // actual locking protocol, without enabling Admin PATCH.
      await gate.query(
        `UPDATE users SET "storageQuota"=150
         WHERE id=$1`,
        [userId],
      );

      pending = copies.reserve(
        copyRequest(userId, sourceId, 100),
      );

      const result = Promise.allSettled([pending]);

      const deadline = Date.now() + 5000;
      let blocked = false;

      while (Date.now() < deadline) {
        const [row] = await db.query(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity a
             WHERE $1::int = ANY(pg_blocking_pids(a.pid))
               AND a.datname=current_database()
           ) AS blocked`,
          [identity.pid],
        );

        if (row.blocked === true) {
          blocked = true;
          break;
        }

        await new Promise<void>((resolve) =>
          setTimeout(resolve, 20),
        );
      }

      expect(blocked).toBe(true);

      await gate.commitTransaction();

      expect(await result).toEqual([
        {
          status: "rejected",
          reason: expect.objectContaining({
            status: 403,
            message: "Storage quota exceeded",
          }),
        },
      ]);

      expect(await readStorageCommitments(
        db.manager, userId,
      )).toMatchObject({
        quota: 150n,
        used: 100n,
        copyBytes: 0n,
        committedBytes: 100n,
        remainingBytes: 50n,
      });

      expect(await db.query(
        `SELECT id FROM file_copy_operations
         WHERE "userId"=$1`,
        [userId],
      )).toEqual([]);
    } finally {
      if (gate.isTransactionActive) {
        await gate.rollbackTransaction();
      }

      if (pending) {
        await pending.catch(() => undefined);
      }

      await gate.release();
    }
  }, 30000);
});
