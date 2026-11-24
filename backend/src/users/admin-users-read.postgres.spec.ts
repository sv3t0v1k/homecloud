import { randomUUID } from "node:crypto";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Test, TestingModule } from "@nestjs/testing";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import * as bcrypt from "bcryptjs";
import request from "supertest";

import { UsersModule } from "./users.module";
import { AdminUsersWriteService } from "./admin-users-write.service";
import { lockAdminTransactions } from "./admin-transaction-lock";
import { UserEntity, UserRole } from "../entities/user.entity";
import { LEGACY_UPLOAD_WORKSPACE_ID } from "../entities/upload-workspace.entity";
import { RefreshTokenEntity } from "../entities/refresh-token.entity";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { ShareLinkEntity } from "../entities/share-link.entity";
import { StorageLocationEntity } from "../entities/storage-location.entity";
import { UploadWorkspaceEntity } from "../entities/upload-workspace.entity";
import { UploadSessionEntity } from "../entities/upload-session.entity";
import { UploadChunkEntity } from "../entities/upload-chunk.entity";
import { UserDeletionEntity } from "../entities/user-deletion.entity";
import { AdminUserDeletionService } from "./admin-user-deletion.service";
import { HttpExceptionFilter } from "../common/errors/http-exception.filter";
import { TransformInterceptor } from "../common/interceptors/transform.interceptor";
import { StorageService } from "../storage/storage.service";

const databaseUrl = process.env.HOMECLOUD_TEST_DATABASE_URL;
const postgres = databaseUrl ? describe : describe.skip;

const ACCESS_SECRET = "admin-read-access-test-secret-not-production";
const REFRESH_SECRET = "admin-read-refresh-test-secret-not-production";
const PASSWORD = "admin-read-fixture-password";
const ENDPOINT = "/api/v1/admin/users";
const ME = "/api/v1/users/me";

postgres("Admin users real PostgreSQL HTTP contract", () => {
  const schema = `admin_read_${randomUUID().replace(/-/g, "")}`;

  let app: INestApplication;
  let testingModule: TestingModule;
  let adminConnection: DataSource;
  let db: DataSource;
  let schemaCreated = false;
  const deletePhysicalFile = jest.fn(async (_path: string) => undefined);

  let administrator: UserEntity;
  let ordinary: UserEntity;
  let literalUser: UserEntity;

  let adminToken: string;
  let userToken: string;
  let adminRefresh: string;

  async function login(email: string) {
    const response = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email, password: PASSWORD })
      .expect(200);

    const { accessToken, refreshToken } = response.body.data;

    if (
      typeof accessToken !== "string" ||
      typeof refreshToken !== "string"
    ) {
      throw new Error("Fixture login did not issue credentials");
    }

    return { accessToken, refreshToken };
  }

  async function get(
    path: string,
    token: string,
  ) {
    return request(app.getHttpServer())
      .get(path)
      .set("Authorization", `Bearer ${token}`);
  }

  beforeAll(async () => {
    adminConnection = new DataSource({
      type: "postgres",
      url: databaseUrl,
    });

    await adminConnection.initialize();

    await adminConnection.query(`CREATE SCHEMA "${schema}"`);
    // The shared storage accounting helper aggregates copy reservations.
    // That table comes from a migration, not an entity, so the
    // entity-synchronized test schema needs it added explicitly.
    await adminConnection.query(
      `CREATE TABLE IF NOT EXISTS "${schema}"."file_copy_operations" (id serial PRIMARY KEY, "userId" integer NOT NULL, state varchar(32) NOT NULL, bytes bigint NOT NULL DEFAULT 0)`,
    );
    await adminConnection.query(
      `CREATE TABLE IF NOT EXISTS "${schema}"."ssd_finalization_operations" (id serial PRIMARY KEY, "userId" integer NOT NULL)`,
    );
    await adminConnection.query(
      `CREATE TABLE IF NOT EXISTS "${schema}"."download_capabilities" ("tokenHash" varchar(64) PRIMARY KEY, "userId" integer NOT NULL, "fileId" integer NOT NULL, "expiresAt" timestamptz NOT NULL)`,
    );
    await adminConnection.query(
      `CREATE TABLE IF NOT EXISTS "${schema}"."archive_download_capabilities" (id varchar(32) PRIMARY KEY, "tokenHash" varchar(64) NOT NULL, "userId" integer NOT NULL, manifest jsonb NOT NULL, "expiresAt" timestamptz NOT NULL)`,
    );
    schemaCreated = true;

    const config = new ConfigService({
      NODE_ENV: "test",
      JWT_SECRET: ACCESS_SECRET,
      JWT_REFRESH_SECRET: REFRESH_SECRET,
      JWT_EXPIRES_IN: "15m",
      JWT_REFRESH_EXPIRES_IN: "7d",
    });

    // Use the real feature module and real dependency injection.
    // Only the isolated test database is configured here.
    testingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
        }),
        TypeOrmModule.forRoot({
          type: "postgres",
          url: databaseUrl,
          schema,
          synchronize: true,
          retryAttempts: 1,
          extra: {
            application_name: schema,
            options: [
              `-c search_path=${schema}`,
              "-c lock_timeout=15000",
              "-c statement_timeout=20000",
            ].join(" "),
          },
          entities: [
            UserEntity,
            RefreshTokenEntity,
            FileEntity,
            FolderEntity,
            ShareLinkEntity,
            StorageLocationEntity,
            UploadWorkspaceEntity,
            UploadSessionEntity,
            UploadChunkEntity,
            UserDeletionEntity,
          ],
        }),
        UsersModule,
      ],
    })
      .overrideProvider(ConfigService)
      .useValue(config)
      .overrideProvider(StorageService)
      .useValue({
        deleteFile: deletePhysicalFile,
        resolveFilePath: (file: FileEntity) => file.storagePath,
      })
      .compile();

    app = testingModule.createNestApplication();

    app.useGlobalPipes(new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }));

    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new TransformInterceptor());
    app.setGlobalPrefix("api/v1");

    await app.init();

    db = app.get(DataSource);

    const [identity] = await db.query(
      "SELECT current_schema() AS schema",
    );

    if (identity.schema !== schema) {
      throw new Error("Incorrect isolated test schema");
    }

    const password = await bcrypt.hash(PASSWORD, 12);
    const createdAt = new Date("2026-11-16T10:00:00.000Z");
    const users = db.getRepository(UserEntity);

    administrator = await users.save(users.create({
      name: "Administrator",
      email: "admin@example.test",
      password,
      role: UserRole.ADMIN,
      isActive: true,
      sessionVersion: "1",
      storageQuota: 0,
      storageUsed: 0,
      createdAt,
    }));

    ordinary = await users.save(users.create({
      name: "Alice",
      email: "alice@example.test",
      password,
      role: UserRole.USER,
      isActive: true,
      sessionVersion: "1",
      storageQuota: 1073741824,
      storageUsed: 3072,
      createdAt,
    }));

    literalUser = await users.save(users.create({
      name: "Percent%_Marker",
      email: "literal@example.test",
      password,
      role: UserRole.USER,
      isActive: false,
      sessionVersion: "1",
      storageQuota: 0,
      storageUsed: 0,
      createdAt,
    }));

    const locationId = randomUUID();

    await db.getRepository(StorageLocationEntity).insert({
      id: locationId,
      machineKey: "admin-read-fixture",
      mountKey: "admin-read-fixture",
      displayName: "Fixture storage",
      type: "local_filesystem",
    });

    // Two live files, one trashed file, one live folder,
    // one trashed folder and a different owner's file.
    // All placement constraints remain enabled.
    await db.query(`
      INSERT INTO "files" (
        name, "userId", "isFolder", "isDeleted",
        size, "storagePath", "storageLocationId", "relativeObjectKey"
      ) VALUES
        ('a.txt', $1, false, false, 1024, '/fixture/a', $3, 'a'),
        ('b.txt', $1, false, false, 1024, '/fixture/b', $3, 'b'),
        ('trash.txt', $1, false, true, 1024, '/fixture/c', $3, 'c'),
        ('folder', $1, true, false, 0, NULL, NULL, NULL),
        ('trash folder', $1, true, true, 0, NULL, NULL, NULL),
        ('other.txt', $2, false, false, 1, '/fixture/d', $3, 'd')
    `, [ordinary.id, administrator.id, locationId]);

    const a = await login(administrator.email);
    const u = await login(ordinary.email);

    adminToken = a.accessToken;
    adminRefresh = a.refreshToken;
    userToken = u.accessToken;
  }, 60000);

  afterAll(async () => {
    try {
      if (app) {
        await app.close();
      } else if (testingModule) {
        await testingModule.close();
      }
    } finally {
      if (adminConnection?.isInitialized) {
        try {
          if (schemaCreated) {
            await adminConnection.query(
              `DROP SCHEMA "${schema}" CASCADE`,
            );
          }
        } finally {
          await adminConnection.destroy();
        }
      }
    }
  }, 30000);

  it("requires real access credentials for both endpoints", async () => {
    for (const path of [ENDPOINT, `${ENDPOINT}/${ordinary.id}`]) {
      const missing = await request(app.getHttpServer()).get(path);
      expect(missing.status).toBe(401);
      expect(missing.body.code).toBe("UNAUTHORIZED");

      const invalid = await get(path, "invalid-token");
      expect(invalid.status).toBe(401);
      expect(invalid.body.code).toBe("UNAUTHORIZED");

      const refresh = await get(path, adminRefresh);
      expect(refresh.status).toBe(401);
    }
  });

  it("denies a logged-in USER before target lookup or input parsing", async () => {
    for (const path of [
      ENDPOINT,
      `${ENDPOINT}/2147483647`,
      `${ENDPOINT}/invalid`,
      `${ENDPOINT}?page=0`,
    ]) {
      const response = await get(path, userToken);

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("ADMIN_REQUIRED");
      expect(response.body).not.toHaveProperty("data");
    }
  });

  it("ignores a validly signed but forged ADMIN role claim", async () => {
    const jwt = app.get(JwtService);

    const forged = jwt.sign({
      sub: ordinary.id,
      email: ordinary.email,
      sv: ordinary.sessionVersion,
      tokenUse: "access",
      role: UserRole.ADMIN,
    }, {
      secret: ACCESS_SECRET,
      algorithm: "HS256",
      expiresIn: "5m",
    });

    const response = await get(ENDPOINT, forged);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("ADMIN_REQUIRED");
  });

  it("returns only the current account-management capability in /me", async () => {
    const a = await get(ME, adminToken);
    const u = await get(ME, userToken);

    expect(a.status).toBe(200);
    expect(a.body.data.role).toBe(UserRole.ADMIN);
    expect(a.body.data.capabilities).toEqual({ manageUsers: true });

    expect(u.status).toBe(200);
    expect(u.body.data.role).toBe(UserRole.USER);
    expect(u.body.data.capabilities).toEqual({ manageUsers: false });

    expect(a.body.data).not.toHaveProperty("password");
    expect(a.body.data).not.toHaveProperty("sessionVersion");
  });

  it("returns stable pagination from a real PostgreSQL statement", async () => {
    const first = await get(
      `${ENDPOINT}?page=1&pageSize=2`,
      adminToken,
    );

    expect(first.status).toBe(200);
    expect(first.body.success).toBe(true);
    expect(first.body.data).toMatchObject({
      page: 1,
      pageSize: 2,
      total: 3,
    });

    // All three accounts have the same creation time.
    expect(first.body.data.items.map((u: {id: number}) => u.id))
      .toEqual([literalUser.id, ordinary.id]);

    const second = await get(
      `${ENDPOINT}?page=2&pageSize=2`,
      adminToken,
    );

    expect(second.body.data.items.map((u: {id: number}) => u.id))
      .toEqual([administrator.id]);

    const empty = await get(
      `${ENDPOINT}?page=3&pageSize=2`,
      adminToken,
    );

    expect(empty.body.data).toEqual({
      items: [], page: 3, pageSize: 2, total: 3,
    });
  });

  it("uses literal case-insensitive name and email search", async () => {
    for (const [search, ids] of [
      ["ALICE", [ordinary.id]],
      ["LITERAL@EXAMPLE.TEST", [literalUser.id]],
      ["%_", [literalUser.id]],
      ["' OR 1=1 --", []],
      ["nonexistent", []],
    ] as const) {
      const response = await get(
        `${ENDPOINT}?search=${encodeURIComponent(search)}`,
        adminToken,
      );

      expect(response.status).toBe(200);
      expect(response.body.data.items.map((u: {id: number}) => u.id))
        .toEqual(ids);
      expect(response.body.data.total).toBe(ids.length);
    }
  });

  it("returns owner-scoped counts and exact response fields", async () => {
    const response = await get(
      `${ENDPOINT}/${ordinary.id}`,
      adminToken,
    );

    expect(response.status).toBe(200);

    expect(response.body.data).toEqual({
      id: ordinary.id,
      name: ordinary.name,
      email: ordinary.email,
      role: UserRole.USER,
      isActive: true,
      storageQuota: "1073741824",
      storageUsed: "3072",
      fileCount: 2,
      folderCount: 1,
      createdAt: ordinary.createdAt.toISOString(),
    });

    const other = await get(
      `${ENDPOINT}/${administrator.id}`,
      adminToken,
    );

    expect(other.body.data.fileCount).toBe(1);
    expect(other.body.data.folderCount).toBe(0);

    const list = await get(ENDPOINT, adminToken);
    const row = list.body.data.items.find(
      (user: { id: number }) => user.id === ordinary.id,
    );

    expect(row).toEqual(response.body.data);
    expect(JSON.stringify(list.body)).not.toContain("storagePath");
    expect(JSON.stringify(list.body)).not.toContain("sessionVersion");
    expect(JSON.stringify(list.body)).not.toContain("password");
  });

  it.each([
    "?page=0",
    "?page=1&page=2",
    "?pageSize=101",
    "?page%5B%5D=1",
    "?sort=password",
    "?__proto__=ADMIN",
    "?constructor=ADMIN",
    "?password=private-query-marker",
  ])("rejects invalid raw query %s", async (query) => {
    const response = await get(ENDPOINT + query, adminToken);

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
    expect(response.body.path).toBe(ENDPOINT);
    expect(JSON.stringify(response.body))
      .not.toContain("private-query-marker");
  });

  it("preserves the error contract for mixed-case admin routes", async () => {
    const path = "/api/v1/ADMIN/users";
    const query = "?password=private-case-marker";

    const missing = await request(app.getHttpServer())
      .get(path + query);

    expect(missing.status).toBe(401);
    expect(missing.body.code).toBe("UNAUTHORIZED");
    expect(missing.body.path).toBe(path);
    expect(JSON.stringify(missing.body))
      .not.toContain("private-case-marker");

    const invalid = await get(path + query, adminToken);

    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("VALIDATION_ERROR");
    expect(invalid.body.path).toBe(path);
    expect(JSON.stringify(invalid.body))
      .not.toContain("private-case-marker");

    const valid = await get(path, adminToken);

    expect(valid.status).toBe(200);
    expect(valid.body.data.total).toBe(3);
  });

  it("rejects invalid identifiers and reports missing users", async () => {
    const invalid = await get(`${ENDPOINT}/01`, adminToken);

    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("VALIDATION_ERROR");

    const missing = await get(
      `${ENDPOINT}/2147483647`,
      adminToken,
    );

    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("USER_NOT_FOUND");
  });

  it("validates the administrative status endpoint without mutation", async () => {
    const headers = { Authorization: `Bearer ${adminToken}` };

    const empty = await request(app.getHttpServer())
      .patch(`${ENDPOINT}/${ordinary.id}`)
      .set(headers).send({});
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe("VALIDATION_ERROR");

    const invalid = await request(app.getHttpServer())
      .patch(`${ENDPOINT}/${ordinary.id}/status`)
      .set(headers).send({});
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("VALIDATION_ERROR");

    expect(await db.getRepository(UserEntity).count()).toBe(3);
  });

  async function alternativeAccessFixture(email: string) {
    const { user, credentials } = await passwordTarget(email);
    const [location] = await db.getRepository(StorageLocationEntity).find();
    const files = db.getRepository(FileEntity);
    const file = await files.save(files.create({
      name: "owned.txt",
      userId: user.id,
      size: 1,
      isFolder: false,
      isDeleted: false,
      storagePath: `/fixture/${user.id}`,
      storageLocationId: location.id,
      relativeObjectKey: `${user.id}/owned`,
    }));
    const shares = db.getRepository(ShareLinkEntity);
    const share = await shares.save(shares.create({
      token: randomUUID(),
      userId: user.id,
      fileId: file.id,
      isActive: true,
      isFolder: false,
      allowUpload: false,
    }));
    const expiresAt = new Date(Date.now() + 3600000);
    const capabilityHash = randomUUID().replace(/-/g, "")
      .padEnd(64, "a");
    const archiveId = randomUUID().replace(/-/g, "");
    const archiveHash = randomUUID().replace(/-/g, "")
      .padEnd(64, "c");

    await db.query(
      `INSERT INTO "download_capabilities"
       ("tokenHash", "userId", "fileId", "expiresAt")
       VALUES ($1, $2, $3, $4)`,
      [capabilityHash, user.id, file.id, expiresAt],
    );
    await db.query(
      `INSERT INTO "archive_download_capabilities"
       (id, "tokenHash", "userId", manifest, "expiresAt")
       VALUES ($1, $2, $3, '{}', $4)`,
      [archiveId, archiveHash, user.id, expiresAt],
    );

    return { user, credentials, file, share };
  }

  it("revokes alternative access over HTTP and never revives it", async () => {
    const { user, credentials, share } = await alternativeAccessFixture(
      "status-http@example.test",
    );

    const blocked = await request(app.getHttpServer())
      .patch(`${ENDPOINT}/${user.id}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ isActive: false })
      .expect(200);

    expect(blocked.body.data.isActive).toBe(false);
    expect((await db.getRepository(ShareLinkEntity).findOneByOrFail({
      id: share.id,
    })).isActive).toBe(false);
    expect((await db.query(
      `SELECT count(*)::int AS count FROM "download_capabilities"
       WHERE "userId" = $1`, [user.id],
    ))[0].count).toBe(0);
    expect((await db.query(
      `SELECT count(*)::int AS count FROM "archive_download_capabilities"
       WHERE "userId" = $1`, [user.id],
    ))[0].count).toBe(0);

    await expectOldSessionRejected(
      credentials.accessToken, credentials.refreshToken,
    );

    await request(app.getHttpServer())
      .patch(`${ENDPOINT}/${user.id}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ isActive: true })
      .expect(200);

    expect((await db.getRepository(ShareLinkEntity).findOneByOrFail({
      id: share.id,
    })).isActive).toBe(false);
  });

  it("authorizes deletion and forbids deleting the current administrator", async () => {
    const { user, credentials } = await passwordTarget(
      "delete-authorization@example.test",
    );

    const missing = await request(app.getHttpServer())
      .delete(`${ENDPOINT}/${user.id}`);
    expect(missing.status).toBe(401);

    const denied = await request(app.getHttpServer())
      .delete(`${ENDPOINT}/${user.id}`)
      .set("Authorization", `Bearer ${credentials.accessToken}`);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("ADMIN_REQUIRED");

    const self = await request(app.getHttpServer())
      .delete(`${ENDPOINT}/${administrator.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(self.status).toBe(409);
    expect(self.body.code).toBe("CANNOT_DELETE_SELF");

    expect(await db.getRepository(UserEntity).findOneBy({
      id: administrator.id,
    })).not.toBeNull();
  });

  it("deletes owned records, revokes credentials and cleans physical files", async () => {
    const { user, credentials, file } = await alternativeAccessFixture(
      "delete-success@example.test",
    );
    deletePhysicalFile.mockClear();

    const response = await request(app.getHttpServer())
      .delete(`${ENDPOINT}/${user.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(response.body.data).toEqual({
      deleted: true,
      cleanupPending: false,
    });
    expect(await db.getRepository(UserEntity).findOneBy({ id: user.id }))
      .toBeNull();
    expect(await db.getRepository(FileEntity).countBy({ userId: user.id }))
      .toBe(0);
    expect(await db.getRepository(ShareLinkEntity).countBy({ userId: user.id }))
      .toBe(0);
    expect(await db.getRepository(RefreshTokenEntity).countBy({ userId: user.id }))
      .toBe(0);
    expect(deletePhysicalFile).toHaveBeenCalledWith(file.storagePath);
    await expectOldSessionRejected(
      credentials.accessToken, credentials.refreshToken,
    );
  });

  it.each([
    ["ssd", "USER_RECOVERY_REQUIRED"],
    ["copy", "USER_STORAGE_OPERATIONS_ACTIVE"],
  ] as const)("keeps account and data behind the %s recovery barrier", async (
    kind,
    code,
  ) => {
    const { user, file } = await alternativeAccessFixture(
      `delete-${kind}-barrier@example.test`,
    );

    if (kind === "ssd") {
      await db.query(
        `INSERT INTO "ssd_finalization_operations" ("userId") VALUES ($1)`,
        [user.id],
      );
    } else {
      await db.query(
        `INSERT INTO "file_copy_operations" ("userId", state)
         VALUES ($1, 'reserved')`,
        [user.id],
      );
    }

    const response = await request(app.getHttpServer())
      .delete(`${ENDPOINT}/${user.id}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe(code);
    expect(await db.getRepository(UserEntity).findOneBy({ id: user.id }))
      .not.toBeNull();
    expect(await db.getRepository(FileEntity).findOneBy({ id: file.id }))
      .not.toBeNull();
  });

  it.each(["pending", "uploading"]) (
    "keeps account and data while a %s legacy upload can own an unpublished final link",
    async (status) => {
      const { user, credentials, file } = await alternativeAccessFixture(
        `delete-${status}-upload@example.test`,
      );

      await db.query(
        `INSERT INTO upload_workspaces (id, "machineKey", "mountKey", type)
         VALUES ($1, $2, $3, 'local_filesystem')
         ON CONFLICT (id) DO NOTHING`,
        [
          LEGACY_UPLOAD_WORKSPACE_ID,
          `delete-test-${randomUUID()}`,
          `delete-mount-${randomUUID()}`,
        ],
      );
      await db.query(
        `INSERT INTO upload_sessions (
          "uploadId", filename, "totalSize", "uploadedSize", "chunkSize",
          "totalChunks", "uploadedCount", "accountingInitialized", "tempPath",
          "workspaceId", status, "expiresAt", "userId"
        ) VALUES ($1, 'pending.bin', 1, 0, 1, 1, 0, true, $2, $3, $4,
          '2030-01-01', $5)`,
        [
          randomUUID(),
          `/tmp/admin-delete-${randomUUID()}`,
          LEGACY_UPLOAD_WORKSPACE_ID,
          status,
          user.id,
        ],
      );

      const response = await request(app.getHttpServer())
        .delete(`${ENDPOINT}/${user.id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe("USER_STORAGE_OPERATIONS_ACTIVE");
      expect(await db.getRepository(UserEntity).findOneBy({ id: user.id }))
        .not.toBeNull();
      expect(await db.getRepository(FileEntity).findOneBy({ id: file.id }))
        .not.toBeNull();
      expect(await db.getRepository(RefreshTokenEntity).countBy({
        userId: user.id,
        revoked: false,
      })).toBe(1);
      expect(await db.getRepository(UserDeletionEntity).countBy({
        userId: user.id,
      })).toBe(0);
      expect((await get(ME, credentials.accessToken)).status).toBe(200);
      expect(deletePhysicalFile).not.toHaveBeenCalledWith(file.storagePath);
    },
  );

  it("retains physical cleanup and retries it after a repeated DELETE", async () => {
    const { user, file } = await alternativeAccessFixture(
      "delete-cleanup-retry@example.test",
    );
    const journal = db.getRepository(UserDeletionEntity);
    deletePhysicalFile.mockClear();
    deletePhysicalFile.mockRejectedValueOnce(new Error("fixture unlink failure"));

    const response = await request(app.getHttpServer())
      .delete(`${ENDPOINT}/${user.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(response.body.data).toEqual({
      deleted: true,
      cleanupPending: true,
    });
    expect(await db.getRepository(UserEntity).findOneBy({ id: user.id }))
      .toBeNull();
    expect(await journal.findOneBy({ userId: user.id })).toMatchObject({
      payload: { files: [{ path: file.storagePath }], uploads: [] },
    });

    const retry = await request(app.getHttpServer())
      .delete(`${ENDPOINT}/${user.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(retry.body.data).toEqual({
      deleted: true,
      cleanupPending: false,
    });
    expect(await journal.countBy({ userId: user.id })).toBe(0);
    expect(deletePhysicalFile).toHaveBeenCalledTimes(2);
    expect(deletePhysicalFile).toHaveBeenNthCalledWith(2, file.storagePath);
  });

  it("resumes retained physical cleanup during module initialization", async () => {
    const { user, file } = await alternativeAccessFixture(
      "delete-cleanup-startup@example.test",
    );
    const journal = db.getRepository(UserDeletionEntity);
    deletePhysicalFile.mockClear();
    deletePhysicalFile.mockRejectedValueOnce(new Error("fixture restart failure"));

    await request(app.getHttpServer())
      .delete(`${ENDPOINT}/${user.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.data.cleanupPending).toBe(true);
      });

    expect(await journal.countBy({ userId: user.id })).toBe(1);
    deletePhysicalFile.mockClear();

    await app.get(AdminUserDeletionService).onModuleInit();

    expect(deletePhysicalFile).toHaveBeenCalledWith(file.storagePath);
    expect(await journal.countBy({ userId: user.id })).toBe(0);
  });

  async function waitForReadLock() {
    const deadline = Date.now() + 10000;

    while (Date.now() < deadline) {
      const [row] = await adminConnection.query(`
        SELECT count(*)::int AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = $1
          AND wait_event_type = 'Lock'
          AND query ILIKE '%FOR SHARE%'
      `, [schema]);

      if (row.count > 0) return;

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    throw new Error("Expected FOR SHARE lock wait was not observed");
  }

  it.each([
    [
      "demotion",
      { role: UserRole.USER },
      403,
      "ADMIN_REQUIRED",
    ],
    [
      "session revocation",
      { sessionVersion: "2" },
      401,
      "UNAUTHORIZED",
    ],
    [
      "account deactivation",
      { isActive: false },
      401,
      "UNAUTHORIZED",
    ],
  ] as const)(
    "rechecks authorization after concurrent %s commits",
    async (_name, change, status, code) => {
      const runner = db.createQueryRunner();

      let pending: Promise<PromiseSettledResult<request.Response>[]> |
        undefined;

      try {
        await runner.connect();
        await runner.startTransaction();

        await runner.manager.update(
          UserEntity,
          { id: administrator.id },
          change,
        );

        // The JWT guard still sees the committed account version.
        // The read service must wait on its FOR SHARE authorization
        // lock, then observe the newly committed role/session/status.
        pending = Promise.allSettled([
          get(ENDPOINT, adminToken),
        ]);

        await waitForReadLock();

        await runner.commitTransaction();

        const [result] = await pending;

        expect(result).toMatchObject({
          status: "fulfilled",
          value: {
            status,
            body: {
              code,
            },
          },
        });

        const afterCommit = await get(ENDPOINT, adminToken);
        expect(afterCommit.status).toBe(status);
        expect(afterCommit.body.code).toBe(code);
      } finally {
        if (runner.isTransactionActive) {
          await runner.rollbackTransaction();
        }

        if (pending) await pending;

        await runner.release();

        // Test-only state restoration in the disposable database.
        // These are authorization race tests, not production admin
        // mutations. The production mutation paths are not exposed.
        await db.getRepository(UserEntity).update(
          administrator.id,
          {
            role: UserRole.ADMIN,
            isActive: true,
            sessionVersion: "1",
          },
        );
      }
    },
    30000,
  );

  // ======================================================
  // Administrative account creation: real HTTP + PostgreSQL
  // ======================================================

  function createBody(email: string) {
    return {
      name: "Created account",
      email,
      password: PASSWORD,
      role: UserRole.USER,
      storageQuota: "1073741824",
    };
  }

  async function create(
    body: Record<string, unknown>,
    token = adminToken,
  ) {
    return request(app.getHttpServer())
      .post(ENDPOINT)
      .set("Authorization", `Bearer ${token}`)
      .send(body);
  }

  async function waitForCreateLock(expected: number) {
    const deadline = Date.now() + 10000;

    while (Date.now() < deadline) {
      const [row] = await adminConnection.query(`
        SELECT count(*)::int AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = $1
          AND wait_event_type = 'Lock'
          AND query ILIKE '%pg_advisory_xact_lock%'
      `, [schema]);

      if (row.count >= expected) return;

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    throw new Error("Expected administrative lock waits not observed");
  }

  it("denies account creation without current ADMIN authority", async () => {
    const email = "denied-create@example.test";
    const body = createBody(email);

    const missing = await request(app.getHttpServer())
      .post(ENDPOINT).send(body);

    expect(missing.status).toBe(401);
    expect(missing.body.code).toBe("UNAUTHORIZED");

    const ordinaryResponse = await create(body, userToken);

    expect(ordinaryResponse.status).toBe(403);
    expect(ordinaryResponse.body.code).toBe("ADMIN_REQUIRED");

    const forged = app.get(JwtService).sign({
      sub: ordinary.id,
      email: ordinary.email,
      sv: ordinary.sessionVersion,
      tokenUse: "access",
      role: UserRole.ADMIN,
    }, {
      secret: ACCESS_SECRET,
      algorithm: "HS256",
      expiresIn: "5m",
    });

    const forgedResponse = await create(body, forged);

    expect(forgedResponse.status).toBe(403);
    expect(forgedResponse.body.code).toBe("ADMIN_REQUIRED");

    expect(await db.getRepository(UserEntity).countBy({ email }))
      .toBe(0);
  });

  it("rejects mass assignment and malformed creation input", async () => {
    const email = "invalid-create@example.test";
    const body = createBody(email);

    for (const patch of [
      { sessionVersion: "99" },
      { id: 123456 },
      { isActive: false },
      { storageUsed: "1" },
      { isEmailVerified: true },
      { passwordHash: "private-injected-marker" },
      { role: "SUPERADMIN" },
      { name: "" },
      { password: "short" },
    ]) {
      const response = await create({ ...body, ...patch });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
      expect(JSON.stringify(response.body))
        .not.toContain("private-injected-marker");
    }

    for (const storageQuota of [1, "-1", "01", "9007199254740992"]) {
      const response = await create({ ...body, storageQuota });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("INVALID_QUOTA");
    }

    const prototype = JSON.parse(
      '{"__proto__":{"role":"ADMIN"}}',
    );

    // SuperAgent object merging can consume the special
    // __proto__ property before JSON serialization.
    // Send the exact JSON payload instead of an object.
    const rawPayload = JSON.stringify({
      ...body,
      ...prototype,
    });

    expect(rawPayload).toContain('"__proto__"');
    expect(
      Object.prototype.hasOwnProperty.call(
        JSON.parse(rawPayload),
        "__proto__",
      ),
    ).toBe(true);

    const polluted = await request(app.getHttpServer())
      .post(ENDPOINT)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send(rawPayload);

    expect(polluted.status).toBe(400);
    expect(polluted.body.code).toBe("VALIDATION_ERROR");

    expect(await db.getRepository(UserEntity).countBy({ email }))
      .toBe(0);
  });

  it("creates a canonical USER who can log in with the assigned password", async () => {
    const email = "new-user@example.test";

    const response = await create({
      ...createBody("  NEW-USER@Example.TEST  "),
      name: "  New user  ",
    });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);

    const user = await db.getRepository(UserEntity)
      .findOneByOrFail({ email });

    expect(response.body.data).toEqual({
      id: user.id,
      name: "New user",
      email,
      role: UserRole.USER,
      isActive: true,
      storageQuota: "1073741824",
      storageUsed: "0",
      fileCount: 0,
      folderCount: 0,
      createdAt: user.createdAt.toISOString(),
    });

    expect(user.sessionVersion).toBe("1");
    expect(user.isEmailVerified).toBe(false);
    expect(user.password).toMatch(/^\$2[aby]\$12\$/);
    expect(await bcrypt.compare(PASSWORD, user.password)).toBe(true);

    const sessions = db.getRepository(RefreshTokenEntity);

    // Account creation must not create a session.
    expect(await sessions.countBy({ userId: user.id })).toBe(0);

    const tokens = await login(email);

    const me = await get(ME, tokens.accessToken);

    expect(me.status).toBe(200);
    expect(me.body.data.id).toBe(user.id);
    expect(me.body.data.capabilities).toEqual({
      manageUsers: false,
    });

    expect(await sessions.countBy({ userId: user.id })).toBe(1);

    const detail = await get(`${ENDPOINT}/${user.id}`, adminToken);

    expect(detail.status).toBe(200);
    expect(detail.body.data).toEqual(response.body.data);
  });

  it("creates an explicit ADMIN and preserves an exact maximum quota", async () => {
    const email = "additional-admin@example.test";

    const response = await create({
      ...createBody(email),
      role: UserRole.ADMIN,
      storageQuota: "9007199254740991",
    });

    expect(response.status).toBe(201);
    expect(response.body.data.role).toBe(UserRole.ADMIN);
    expect(response.body.data.storageQuota).toBe("9007199254740991");
    expect(response.body.data.storageUsed).toBe("0");

    const user = await db.getRepository(UserEntity)
      .findOneByOrFail({ email });

    expect(String(user.storageQuota)).toBe("9007199254740991");
    expect(user.sessionVersion).toBe("1");
    expect(user.isActive).toBe(true);

    const tokens = await login(email);
    const me = await get(ME, tokens.accessToken);

    expect(me.body.data.capabilities).toEqual({
      manageUsers: true,
    });

    expect((await get(ENDPOINT, tokens.accessToken)).status)
      .toBe(200);
  });

  it("rejects a canonical duplicate without modifying the existing account", async () => {
    const users = db.getRepository(UserEntity);
    const before = await users.findOneByOrFail({ id: ordinary.id });

    const response = await create({
      ...createBody(" ALICE@EXAMPLE.TEST "),
      name: "Must not replace",
      role: UserRole.ADMIN,
      password: "must-not-replace-password",
      storageQuota: "0",
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("EMAIL_ALREADY_EXISTS");
    expect(response.body).not.toHaveProperty("data");

    expect(await users.findOneByOrFail({ id: ordinary.id }))
      .toEqual(before);

    expect(await users.countBy({ email: ordinary.email })).toBe(1);
  });

  it("permits only one concurrent creation of equivalent email addresses", async () => {
    const runner = db.createQueryRunner();
    const email = "concurrent-create@example.test";

    let pending:
      Promise<PromiseSettledResult<request.Response>[]> |
      undefined;

    try {
      await runner.connect();
      await runner.startTransaction();
      await lockAdminTransactions(runner.manager);

      pending = Promise.allSettled([
        create(createBody(email)),
        create(createBody(" CONCURRENT-CREATE@EXAMPLE.TEST ")),
      ]);

      // Both real HTTP requests must reach the PostgreSQL lock.
      await waitForCreateLock(2);

      await runner.commitTransaction();

      const results = await pending;

      const statuses = results.map((result) =>
        result.status === "fulfilled" ? result.value.status : -1,
      ).sort((a, b) => a - b);

      expect(statuses).toEqual([201, 409]);

      expect(results.find((result) =>
        result.status === "fulfilled" &&
        result.value.status === 409,
      )).toMatchObject({
        status: "fulfilled",
        value: {
          body: { code: "EMAIL_ALREADY_EXISTS" },
        },
      });

      const users = db.getRepository(UserEntity);

      expect(await users.countBy({ email })).toBe(1);

      const created = await users.findOneByOrFail({ email });

      expect(created.role).toBe(UserRole.USER);
      expect(created.sessionVersion).toBe("1");

      expect(await db.getRepository(RefreshTokenEntity)
        .countBy({ userId: created.id })).toBe(0);

    } finally {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }

      if (pending) await pending;
      await runner.release();
    }
  }, 30000);

  it("rolls back a real INSERT when the persisted result fails validation", async () => {
    const email = "rollback-create@example.test";
    const users = db.getRepository(UserEntity);
    const before = await users.count();

    // Test-only trigger inside the isolated schema.
    // The INSERT succeeds but the returned state is unacceptable.
    await db.query(`
      CREATE FUNCTION admin_create_rollback_probe()
      RETURNS trigger LANGUAGE plpgsql AS $fixture$
      BEGIN
        IF NEW.email = 'rollback-create@example.test' THEN
          NEW."storageUsed" := 1;
        END IF;
        RETURN NEW;
      END;
      $fixture$;
    `);

    try {
      await db.query(`
        CREATE TRIGGER admin_create_rollback_probe
        BEFORE INSERT ON "users"
        FOR EACH ROW
        EXECUTE FUNCTION admin_create_rollback_probe()
      `);

      const response = await create(createBody(email));

      expect(response.status).toBe(500);
      expect(response.body).not.toHaveProperty("data");
      expect(JSON.stringify(response.body)).not.toContain(PASSWORD);

      expect(await users.countBy({ email })).toBe(0);
      expect(await users.count()).toBe(before);

    } finally {
      await db.query(
        'DROP TRIGGER IF EXISTS admin_create_rollback_probe ON "users"',
      );

      await db.query(
        "DROP FUNCTION IF EXISTS admin_create_rollback_probe()",
      );
    }
  });

  it.each([
    ["demotion", { role: UserRole.USER }, 403, "ADMIN_REQUIRED"],
    ["session revocation", { sessionVersion: "2" }, 401, "UNAUTHORIZED"],
    ["deactivation", { isActive: false }, 401, "UNAUTHORIZED"],
  ] as const)(
    "prevents creation after concurrent administrator %s",
    async (_name, change, status, code) => {
      const runner = db.createQueryRunner();
      const email = "lost-authority@example.test";
      let pending:
        Promise<PromiseSettledResult<request.Response>[]> |
        undefined;

      try {
        await runner.connect();
        await runner.startTransaction();

        await lockAdminTransactions(runner.manager);

        await runner.manager.update(
          UserEntity,
          { id: administrator.id },
          change,
        );

        // Preliminary authorization sees the still-committed ADMIN.
        // Creation reaches the global lock, then must reauthorize.
        pending = Promise.allSettled([
          create(createBody(email)),
        ]);

        await waitForCreateLock(1);
        await runner.commitTransaction();

        const [result] = await pending;

        expect(result).toMatchObject({
          status: "fulfilled",
          value: {
            status,
            body: { code },
          },
        });

        expect(await db.getRepository(UserEntity).countBy({ email }))
          .toBe(0);

      } finally {
        if (runner.isTransactionActive) {
          await runner.rollbackTransaction();
        }

        if (pending) await pending;
        await runner.release();

        // Restore fixture state only in this disposable database.
        await db.getRepository(UserEntity).update(
          administrator.id,
          {
            role: UserRole.ADMIN,
            isActive: true,
            sessionVersion: "1",
          },
        );
      }
    },
    30000,
  );

  // ======================================================
  // Administrative profile update, without exposing PATCH.
  // The real production service is resolved from UsersModule.
  // ======================================================

  function updateService() {
    return app.get(AdminUsersWriteService);
  }

  function administratorActor() {
    return {
      userId: administrator.id,
      sessionVersion: "1",
    };
  }

  it("denies unauthorized profile changes and unsafe quota edits", async () => {
    const users = db.getRepository(UserEntity);
    const before = await users.findOneByOrFail({ id: ordinary.id });

    await expect(updateService().updateProfile(
      {
        userId: ordinary.id,
        sessionVersion: before.sessionVersion,
      },
      String(ordinary.id),
      { name: "Forbidden name" },
    )).rejects.toMatchObject({
      status: 403,
      response: { code: "ADMIN_REQUIRED" },
    });

    await expect(updateService().updateProfile(
      { ...administratorActor(), sessionVersion: "999" },
      String(ordinary.id),
      { name: "Stale actor" },
    )).rejects.toMatchObject({ status: 401 });

    for (const patch of [
      {},
      { storageUsed: "0" },
      { password: PASSWORD },
      { isActive: false },
      { sessionVersion: "999" },
    ]) {
      await expect(updateService().updateProfile(
        administratorActor(),
        String(ordinary.id),
        patch,
      )).rejects.toMatchObject({ status: 400 });
    }

    // The account already uses 3072 bytes, so a zero quota is a
    // commitment conflict, not a format error.
    for (const patch of [
      { storageQuota: "0" },
      { name: "Valid", storageQuota: "3071" },
    ]) {
      await expect(updateService().updateProfile(
        administratorActor(),
        String(ordinary.id),
        patch,
      )).rejects.toMatchObject({
        status: 409,
        response: { code: "QUOTA_BELOW_COMMITMENTS" },
      });
    }

    await expect(updateService().updateProfile(
      administratorActor(),
      "2147483647",
      { name: "Missing user" },
    )).rejects.toMatchObject({
      status: 404,
      response: { code: "USER_NOT_FOUND" },
    });

    expect(await users.findOneByOrFail({ id: ordinary.id }))
      .toEqual(before);
  });

  it("changes only the name and preserves files, quota, password and sessions", async () => {
    const users = db.getRepository(UserEntity);
    const sessions = db.getRepository(RefreshTokenEntity);

    const before = await users.findOneByOrFail({ id: ordinary.id });
    const tokensBefore = await sessions.findBy({ userId: ordinary.id });

    const filesBefore = await db.query(
      'SELECT * FROM "files" WHERE "userId"=$1 ORDER BY id',
      [ordinary.id],
    );

    const result = await updateService().updateProfile(
      administratorActor(),
      String(ordinary.id),
      { name: "  Renamed Alice  " },
    );

    const after = await users.findOneByOrFail({ id: ordinary.id });

    expect(after).toEqual({
      ...before,
      name: "Renamed Alice",
      updatedAt: after.updatedAt,
    });

    expect(result).toMatchObject({
      id: ordinary.id,
      name: "Renamed Alice",
      email: ordinary.email,
      storageQuota: "1073741824",
      storageUsed: "3072",
      fileCount: 2,
      folderCount: 1,
    });

    expect(result).not.toHaveProperty("password");
    expect(result).not.toHaveProperty("sessionVersion");

    expect(await sessions.findBy({ userId: ordinary.id }))
      .toEqual(tokensBefore);

    expect(await db.query(
      'SELECT * FROM "files" WHERE "userId"=$1 ORDER BY id',
      [ordinary.id],
    )).toEqual(filesBefore);

    expect((await get(ME, userToken)).status).toBe(200);

    // Canonical same-value update: no timestamp or session change.
    await updateService().updateProfile(
      administratorActor(),
      String(ordinary.id),
      {
        name: "Renamed Alice",
        email: " ALICE@EXAMPLE.TEST ",
      },
    );

    expect(await users.findOneByOrFail({ id: ordinary.id }))
      .toEqual(after);
  });

  it("changes the storage quota over HTTP without touching sessions or files", async () => {
    const users = db.getRepository(UserEntity);
    const sessions = db.getRepository(RefreshTokenEntity);

    const before = await users.findOneByOrFail({ id: ordinary.id });
    const tokensBefore = await sessions.findBy({ userId: ordinary.id });

    const response = await request(app.getHttpServer())
      .patch(`${ENDPOINT}/${ordinary.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ storageQuota: "9007199254740991" })
      .expect(200);

    expect(response.body.data).toMatchObject({
      id: ordinary.id,
      storageQuota: "9007199254740991",
      storageUsed: "3072",
    });

    const after = await users.findOneByOrFail({ id: ordinary.id });

    expect(after).toEqual({
      ...before,
      storageQuota: "9007199254740991",
      updatedAt: after.updatedAt,
    });
    expect(String(after.sessionVersion)).toBe(String(before.sessionVersion));

    // A quota change is not an identity change: sessions stay valid.
    expect(await sessions.findBy({ userId: ordinary.id }))
      .toEqual(tokensBefore);
    expect((await get(ME, userToken)).status).toBe(200);
  });

  it("counts upload and copy reservations against the quota guard", async () => {
    const users = db.getRepository(UserEntity);

    // used=3072; add a 1000-byte upload reservation and a 500-byte copy.
    await db.query(
      `INSERT INTO upload_workspaces (id, "machineKey", "mountKey", type)
       VALUES ($1, $2, $3, 'local_filesystem')
       ON CONFLICT (id) DO NOTHING`,
      [
        LEGACY_UPLOAD_WORKSPACE_ID,
        `quota-test-${randomUUID()}`,
        `quota-mount-${randomUUID()}`,
      ],
    );
    await db.query(
      `INSERT INTO upload_sessions ("uploadId",filename,"totalSize","uploadedSize","chunkSize","totalChunks","uploadedCount","accountingInitialized","tempPath","workspaceId",status,"expiresAt","userId")
       VALUES ($1,'reservation.bin',1000,0,1000,1,0,true,$2,$3,'pending','2030-01-01',$4)`,
      [
        randomUUID(),
        `/tmp/admin-quota-${randomUUID()}`,
        LEGACY_UPLOAD_WORKSPACE_ID,
        ordinary.id,
      ],
    );
    await db.query(
      `INSERT INTO "file_copy_operations" ("userId", state, bytes) VALUES ($1, 'reserved', 500)`,
      [ordinary.id],
    );

    // 3072 + 1000 + 500 = 4572 committed.
    await request(app.getHttpServer())
      .patch(`${ENDPOINT}/${ordinary.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ storageQuota: "4571" })
      .expect(409)
      .expect((value) => {
        expect(value.body.code).toBe("QUOTA_BELOW_COMMITMENTS");
        expect(value.body.message).toBe(
          "Storage quota cannot be below used and reserved bytes",
        );
      });

    // Exactly the committed amount is allowed.
    const accepted = await request(app.getHttpServer())
      .patch(`${ENDPOINT}/${ordinary.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ storageQuota: "4572" })
      .expect(200);

    expect(accepted.body.data.storageQuota).toBe("4572");
    expect(
      String((await users.findOneByOrFail({ id: ordinary.id })).storageQuota),
    ).toBe("4572");

    await db.query(
      `DELETE FROM upload_sessions WHERE "userId"=$1 AND filename='reservation.bin'`,
      [ordinary.id],
    );
    await db.query(
      `DELETE FROM "file_copy_operations" WHERE "userId"=$1`,
      [ordinary.id],
    );
  });

  it("serializes concurrent quota patches to one committed value", async () => {
    const users = db.getRepository(UserEntity);
    const before = await users.findOneByOrFail({ id: ordinary.id });

    const [first, second] = await Promise.all([
      request(app.getHttpServer())
        .patch(`${ENDPOINT}/${ordinary.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ storageQuota: "6000" }),
      request(app.getHttpServer())
        .patch(`${ENDPOINT}/${ordinary.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ storageQuota: "7000" }),
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);

    const after = await users.findOneByOrFail({ id: ordinary.id });
    expect(["6000", "7000"]).toContain(String(after.storageQuota));
    expect(String(after.sessionVersion))
      .toBe(String(before.sessionVersion));
  });

  it("rejects quota patches from ordinary users over HTTP", async () => {
    const users = db.getRepository(UserEntity);
    const before = await users.findOneByOrFail({ id: ordinary.id });

    await request(app.getHttpServer())
      .patch(`${ENDPOINT}/${ordinary.id}`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({ storageQuota: "9007199254740991" })
      .expect(403);

    expect(await users.findOneByOrFail({ id: ordinary.id }))
      .toMatchObject({ storageQuota: before.storageQuota });
  });

  it("changes canonical email and atomically invalidates old access and refresh sessions", async () => {
    const users = db.getRepository(UserEntity);
    const sessions = db.getRepository(RefreshTokenEntity);

    const issued = await login(ordinary.email);

    // Set a verified test account to prove email verification
    // does not survive an actual identity change.
    await users.update(ordinary.id, { isEmailVerified: true });

    const before = await users.findOneByOrFail({ id: ordinary.id });

    const result = await updateService().updateProfile(
      administratorActor(),
      String(ordinary.id),
      {
        name: "Alice updated",
        email: " ALICE-UPDATED@Example.TEST ",
      },
    );

    const after = await users.findOneByOrFail({ id: ordinary.id });

    expect(after).toEqual({
      ...before,
      name: "Alice updated",
      email: "alice-updated@example.test",
      isEmailVerified: false,
      sessionVersion: (
        BigInt(before.sessionVersion) + 1n
      ).toString(),
      updatedAt: after.updatedAt,
    });

    expect(result).toMatchObject({
      id: ordinary.id,
      name: after.name,
      email: after.email,
      fileCount: 2,
      folderCount: 1,
      storageUsed: "3072",
    });

    expect(await sessions.countBy({
      userId: ordinary.id,
      revoked: false,
    })).toBe(0);

    expect(await sessions.countBy({
      userId: ordinary.id,
      revoked: true,
    })).toBeGreaterThan(0);

    await request(app.getHttpServer())
      .get(ME)
      .set("Authorization", `Bearer ${issued.accessToken}`)
      .expect(401);

    await request(app.getHttpServer())
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: issued.refreshToken })
      .expect(401);

    await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: ordinary.email, password: PASSWORD })
      .expect(401);

    const fresh = await login(after.email);
    const profile = await get(ME, fresh.accessToken);

    expect(profile.status).toBe(200);
    expect(profile.body.data.id).toBe(ordinary.id);
    expect(profile.body.data.email).toBe(after.email);
  });

  it("rejects a duplicate email without changing the name or revoking sessions", async () => {
    const users = db.getRepository(UserEntity);
    const sessions = db.getRepository(RefreshTokenEntity);

    const before = await users.findOneByOrFail({ id: ordinary.id });
    const tokensBefore = await sessions.findBy({ userId: ordinary.id });

    await expect(updateService().updateProfile(
      administratorActor(),
      String(ordinary.id),
      {
        email: " ADMIN@EXAMPLE.TEST ",
        name: "Must roll back",
      },
    )).rejects.toMatchObject({
      status: 409,
      response: { code: "EMAIL_ALREADY_EXISTS" },
    });

    expect(await users.findOneByOrFail({ id: ordinary.id }))
      .toEqual(before);

    expect(await sessions.findBy({ userId: ordinary.id }))
      .toEqual(tokensBefore);
  });

  it("allows an administrator to edit their own name with a single user lock", async () => {
    const users = db.getRepository(UserEntity);

    const before = await users.findOneByOrFail({
      id: administrator.id,
    });

    const result = await updateService().updateProfile(
      administratorActor(),
      String(administrator.id),
      { name: "Administrator renamed" },
    );

    expect(result.id).toBe(administrator.id);
    expect(result.name).toBe("Administrator renamed");

    const after = await users.findOneByOrFail({
      id: administrator.id,
    });

    expect(after).toEqual({
      ...before,
      name: "Administrator renamed",
      updatedAt: after.updatedAt,
    });

    expect((await get(ME, adminToken)).status).toBe(200);
  });

  it("rolls back an email change if refresh session revocation fails", async () => {
    const users = db.getRepository(UserEntity);
    const sessions = db.getRepository(RefreshTokenEntity);

    const before = await users.findOneByOrFail({ id: ordinary.id });
    const tokensBefore = await sessions.findBy({ userId: ordinary.id });
    const issued = await login(before.email);

    const allTokensBefore = await sessions.findBy({
      userId: ordinary.id,
    });

    expect(allTokensBefore.length).toBeGreaterThan(tokensBefore.length);

    // Test-only trigger, isolated schema. Failure happens after
    // the user update and sessionVersion update have succeeded.
    await db.query(`
      CREATE FUNCTION admin_profile_revocation_probe()
      RETURNS trigger LANGUAGE plpgsql AS $fixture$
      BEGIN
        RAISE EXCEPTION 'fixture refresh revocation failure';
      END;
      $fixture$;
    `);

    try {
      const table = db.getMetadata(RefreshTokenEntity).tableName;

      // The table name comes from trusted entity metadata.
      await db.query(`
        CREATE TRIGGER admin_profile_revocation_probe
        BEFORE UPDATE ON "${table}"
        FOR EACH ROW
        EXECUTE FUNCTION admin_profile_revocation_probe()
      `);

      await expect(updateService().updateProfile(
        administratorActor(),
        String(ordinary.id),
        {
          name: "Must roll back",
          email: "rollback-email@example.test",
        },
      )).rejects.toThrow("fixture refresh revocation failure");

      expect(await users.findOneByOrFail({ id: ordinary.id }))
        .toEqual(before);

      expect(await sessions.findBy({ userId: ordinary.id }))
        .toEqual(allTokensBefore);

      expect((await get(ME, issued.accessToken)).status).toBe(200);

    } finally {
      const table = db.getMetadata(RefreshTokenEntity).tableName;

      await db.query(
        `DROP TRIGGER IF EXISTS admin_profile_revocation_probe ON "${table}"`,
      );

      await db.query(
        "DROP FUNCTION IF EXISTS admin_profile_revocation_probe()",
      );
    }
  });

  it("rechecks the administrator after a real concurrent session revocation", async () => {
    const runner = db.createQueryRunner();
    const users = db.getRepository(UserEntity);

    const before = await users.findOneByOrFail({ id: ordinary.id });

    let pending:
      Promise<PromiseSettledResult<
        Awaited<ReturnType<AdminUsersWriteService["updateProfile"]>>
      >[]> | undefined;

    try {
      await runner.connect();
      await runner.startTransaction();
      await lockAdminTransactions(runner.manager);

      await runner.manager.update(
        UserEntity,
        administrator.id,
        { sessionVersion: "2" },
      );

      pending = Promise.allSettled([
        updateService().updateProfile(
          administratorActor(),
          String(ordinary.id),
          { name: "Stale actor must not write" },
        ),
      ]);

      await waitForCreateLock(1);
      await runner.commitTransaction();

      const [result] = await pending;

      expect(result).toMatchObject({
        status: "rejected",
        reason: {
          status: 401,
          response: { code: "UNAUTHORIZED" },
        },
      });

      expect(await users.findOneByOrFail({ id: ordinary.id }))
        .toEqual(before);

    } finally {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }

      if (pending) await pending;
      await runner.release();

      // Restore only the disposable administrator fixture.
      await users.update(administrator.id, {
        sessionVersion: "1",
      });
    }
  }, 30000);

  // ======================================================
  // Administrative password change: real HTTP and PostgreSQL.
  // ======================================================

  const NEW_PASSWORD = "new-admin-assigned-password-2026";

  async function passwordTarget(
    email: string,
    role: UserRole = UserRole.USER,
  ) {
    const created = await create({
      ...createBody(email),
      role,
    });

    if (created.status !== 201) {
      throw new Error("Password test fixture creation failed");
    }

    const user = await db.getRepository(UserEntity)
      .findOneByOrFail({ email });

    const credentials = await login(email);

    return { user, credentials };
  }

  async function resetPassword(
    id: number | string,
    body: Record<string, unknown>,
    token = adminToken,
  ) {
    return request(app.getHttpServer())
      .put(`${ENDPOINT}/${id}/password`)
      .set("Authorization", `Bearer ${token}`)
      .send(body);
  }

  it("requires ADMIN and validates password requests without mutation", async () => {
    const { user, credentials } = await passwordTarget(
      "password-denied@example.test",
    );

    const users = db.getRepository(UserEntity);
    const sessions = db.getRepository(RefreshTokenEntity);

    const before = await users.findOneByOrFail({ id: user.id });
    const tokensBefore = await sessions.findBy({ userId: user.id });

    const body = { newPassword: NEW_PASSWORD };

    const missing = await request(app.getHttpServer())
      .put(`${ENDPOINT}/${user.id}/password`)
      .send(body);

    expect(missing.status).toBe(401);
    expect(missing.body.code).toBe("UNAUTHORIZED");

    const denied = await resetPassword(
      user.id, body, credentials.accessToken,
    );

    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("ADMIN_REQUIRED");

    const forged = app.get(JwtService).sign({
      sub: user.id,
      email: user.email,
      sv: user.sessionVersion,
      tokenUse: "access",
      role: UserRole.ADMIN,
    }, {
      secret: ACCESS_SECRET,
      algorithm: "HS256",
      expiresIn: "5m",
    });

    const forgedResponse = await resetPassword(
      user.id, body, forged,
    );

    expect(forgedResponse.status).toBe(403);
    expect(forgedResponse.body.code).toBe("ADMIN_REQUIRED");

    for (const invalid of [
      {},
      { newPassword: "short" },
      { newPassword: "я".repeat(37) },
      { newPassword: NEW_PASSWORD, sessionVersion: "99" },
      { newPassword: NEW_PASSWORD, role: UserRole.ADMIN },
      { newPassword: NEW_PASSWORD, password: PASSWORD },
    ]) {
      const response = await resetPassword(user.id, invalid);

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
    }

    const raw = JSON.stringify({
      newPassword: NEW_PASSWORD,
      ...JSON.parse('{"__proto__":{"role":"ADMIN"}}'),
    });

    expect(raw).toContain('"__proto__"');

    const polluted = await request(app.getHttpServer())
      .put(`${ENDPOINT}/${user.id}/password`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send(raw);

    expect(polluted.status).toBe(400);
    expect(polluted.body.code).toBe("VALIDATION_ERROR");

    const invalidId = await resetPassword("01", body);
    expect(invalidId.status).toBe(400);

    const unknown = await resetPassword(2147483647, body);

    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("USER_NOT_FOUND");

    expect(await users.findOneByOrFail({ id: user.id }))
      .toEqual(before);

    expect(await sessions.findBy({ userId: user.id }))
      .toEqual(tokensBefore);

    expect((await get(ME, credentials.accessToken)).status)
      .toBe(200);
  });

  it("atomically replaces the password and revokes all old sessions", async () => {
    const { user, credentials } = await passwordTarget(
      "password-change@example.test",
    );

    const second = await login(user.email);

    const users = db.getRepository(UserEntity);
    const sessions = db.getRepository(RefreshTokenEntity);

    const before = await users.findOneByOrFail({ id: user.id });

    const response = await resetPassword(user.id, {
      newPassword: NEW_PASSWORD,
    });

    expect(response.status).toBe(200);

    expect(response.body).toEqual({
      success: true,
      data: {
        passwordChanged: true,
        sessionsRevoked: true,
      },
    });

    expect(JSON.stringify(response.body)).not.toContain(NEW_PASSWORD);

    const after = await users.findOneByOrFail({ id: user.id });

    expect(after).toEqual({
      ...before,
      password: after.password,
      sessionVersion: (
        BigInt(before.sessionVersion) + 1n
      ).toString(),
      updatedAt: after.updatedAt,
    });

    expect(after.password).not.toBe(before.password);
    expect(after.password).toMatch(/^\$2[aby]\$12\$/);

    expect(await bcrypt.compare(NEW_PASSWORD, after.password))
      .toBe(true);

    expect(await bcrypt.compare(PASSWORD, after.password))
      .toBe(false);

    expect(await sessions.countBy({
      userId: user.id,
      revoked: false,
    })).toBe(0);

    expect(await sessions.countBy({
      userId: user.id,
      revoked: true,
    })).toBe(2);

    for (const old of [credentials, second]) {
      await request(app.getHttpServer())
        .get(ME)
        .set("Authorization", `Bearer ${old.accessToken}`)
        .expect(401);

      await request(app.getHttpServer())
        .post("/api/v1/auth/refresh")
        .send({ refreshToken: old.refreshToken })
        .expect(401);
    }

    await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: PASSWORD })
      .expect(401);

    const fresh = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: NEW_PASSWORD })
      .expect(200);

    const me = await get(ME, fresh.body.data.accessToken);

    expect(me.status).toBe(200);
    expect(me.body.data.id).toBe(user.id);
    expect(await sessions.countBy({
      userId: user.id,
      revoked: false,
    })).toBe(1);
  });

  it("supports an administrator changing their own password and revokes that session", async () => {
    const { user, credentials } = await passwordTarget(
      "password-self-admin@example.test",
      UserRole.ADMIN,
    );

    const response = await resetPassword(
      user.id,
      { newPassword: NEW_PASSWORD },
      credentials.accessToken,
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      passwordChanged: true,
      sessionsRevoked: true,
    });

    expect((await get(ENDPOINT, credentials.accessToken)).status)
      .toBe(401);

    await request(app.getHttpServer())
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: credentials.refreshToken })
      .expect(401);

    const fresh = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: NEW_PASSWORD })
      .expect(200);

    expect((await get(ENDPOINT, fresh.body.data.accessToken)).status)
      .toBe(200);

    const persisted = await db.getRepository(UserEntity)
      .findOneByOrFail({ id: user.id });

    expect(persisted.role).toBe(UserRole.ADMIN);
    expect(persisted.isActive).toBe(true);
    expect(persisted.sessionVersion).toBe("2");
  });

  it("rolls back the password and session version if refresh revocation fails", async () => {
    const { user, credentials } = await passwordTarget(
      "password-rollback@example.test",
    );

    const users = db.getRepository(UserEntity);
    const sessions = db.getRepository(RefreshTokenEntity);

    const before = await users.findOneByOrFail({ id: user.id });
    const tokensBefore = await sessions.findBy({ userId: user.id });

    const table = db.getMetadata(RefreshTokenEntity).tableName;

    await db.query(`
      CREATE FUNCTION admin_password_rollback_probe()
      RETURNS trigger LANGUAGE plpgsql AS $fixture$
      BEGIN
        RAISE EXCEPTION 'fixture password revocation failure';
      END;
      $fixture$;
    `);

    try {
      await db.query(`
        CREATE TRIGGER admin_password_rollback_probe
        BEFORE UPDATE ON "${table}"
        FOR EACH ROW
        EXECUTE FUNCTION admin_password_rollback_probe()
      `);

      const response = await resetPassword(user.id, {
        newPassword: NEW_PASSWORD,
      });

      expect(response.status).toBe(500);
      expect(response.body).not.toHaveProperty("data");
      expect(JSON.stringify(response.body)).not.toContain(NEW_PASSWORD);

      expect(await users.findOneByOrFail({ id: user.id }))
        .toEqual(before);

      expect(await sessions.findBy({ userId: user.id }))
        .toEqual(tokensBefore);

      expect((await get(ME, credentials.accessToken)).status)
        .toBe(200);

    } finally {
      await db.query(
        `DROP TRIGGER IF EXISTS admin_password_rollback_probe ON "${table}"`,
      );

      await db.query(
        "DROP FUNCTION IF EXISTS admin_password_rollback_probe()",
      );
    }

    await login(user.email);

    await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: NEW_PASSWORD })
      .expect(401);
  });

  it("denies password changes after concurrent administrator session revocation", async () => {
    const { user } = await passwordTarget(
      "password-actor-race@example.test",
    );

    const users = db.getRepository(UserEntity);
    const sessions = db.getRepository(RefreshTokenEntity);

    const before = await users.findOneByOrFail({ id: user.id });
    const tokensBefore = await sessions.findBy({ userId: user.id });

    const runner = db.createQueryRunner();

    let pending:
      Promise<PromiseSettledResult<request.Response>[]> |
      undefined;

    try {
      await runner.connect();
      await runner.startTransaction();

      await lockAdminTransactions(runner.manager);

      await runner.manager.update(
        UserEntity,
        administrator.id,
        { sessionVersion: "2" },
      );

      pending = Promise.allSettled([
        resetPassword(user.id, { newPassword: NEW_PASSWORD }),
      ]);

      await waitForCreateLock(1);
      await runner.commitTransaction();

      const [result] = await pending;

      expect(result).toMatchObject({
        status: "fulfilled",
        value: {
          status: 401,
          body: { code: "UNAUTHORIZED" },
        },
      });

      expect(await users.findOneByOrFail({ id: user.id }))
        .toEqual(before);

      expect(await sessions.findBy({ userId: user.id }))
        .toEqual(tokensBefore);

    } finally {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }

      if (pending) await pending;
      await runner.release();

      await users.update(administrator.id, {
        sessionVersion: "1",
      });
    }
  }, 30000);

  // Observe real blocked SQL statements instead of assuming that
  // a sleep is sufficient to establish a concurrency interleaving.
  async function waitForPasswordRace(
    pattern: string,
    expected: number,
  ) {
    const deadline = Date.now() + 10000;

    while (Date.now() < deadline) {
      const [row] = await adminConnection.query(`
        SELECT count(*)::int AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = $1
          AND wait_event_type = 'Lock'
          AND query ILIKE $2
      `, [schema, pattern]);

      if (row.count >= expected) return;

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    throw new Error("Expected password race lock was not observed");
  }

  it("rejects old-password login and refresh waiting behind a real password update", async () => {
    const { user, credentials } = await passwordTarget(
      "password-login-refresh-race@example.test",
    );

    const users = db.getRepository(UserEntity);
    const sessions = db.getRepository(RefreshTokenEntity);

    // Hold an independent test-only advisory lock. The password
    // UPDATE trigger pauses while production user locks are held.
    const gate = db.createQueryRunner();

    let resetPending:
      Promise<PromiseSettledResult<request.Response>[]> |
      undefined;

    let authPending:
      Promise<PromiseSettledResult<request.Response>[]> |
      undefined;

    await db.query(`
      CREATE FUNCTION admin_password_race_probe()
      RETURNS trigger LANGUAGE plpgsql AS $fixture$
      BEGIN
        IF NEW.password IS DISTINCT FROM OLD.password THEN
          PERFORM pg_advisory_xact_lock(1212369985, 99);
        END IF;
        RETURN NEW;
      END;
      $fixture$;
    `);

    try {
      await db.query(`
        CREATE TRIGGER admin_password_race_probe
        BEFORE UPDATE OF password ON "users"
        FOR EACH ROW
        EXECUTE FUNCTION admin_password_race_probe()
      `);

      await gate.connect();
      await gate.startTransaction();

      await gate.query(
        "SELECT pg_advisory_xact_lock($1::integer, $2::integer)",
        [1212369985, 99],
      );

      resetPending = Promise.allSettled([
        resetPassword(user.id, { newPassword: NEW_PASSWORD }),
      ]);

      // The real password UPDATE is waiting inside its trigger.
      await waitForPasswordRace("%UPDATE%password%", 1);

      authPending = Promise.allSettled([
        request(app.getHttpServer())
          .post("/api/v1/auth/login")
          .send({ email: user.email, password: PASSWORD }),

        request(app.getHttpServer())
          .post("/api/v1/auth/refresh")
          .send({ refreshToken: credentials.refreshToken }),
      ]);

      // Both authentication requests must reach their actual
      // user-row lock while the old version is still committed.
      await waitForPasswordRace("%FOR UPDATE%", 2);

      await gate.commitTransaction();

      const [resetResult] = await resetPending;
      const authenticationResults = await authPending;

      expect(resetResult).toMatchObject({
        status: "fulfilled",
        value: { status: 200 },
      });

      expect(authenticationResults).toMatchObject([
        {
          status: "fulfilled",
          value: { status: 401 },
        },
        {
          status: "fulfilled",
          value: { status: 401 },
        },
      ]);

      const persisted = await users.findOneByOrFail({ id: user.id });

      expect(persisted.sessionVersion).toBe("2");

      expect(await sessions.countBy({
        userId: user.id,
        revoked: false,
      })).toBe(0);

      expect((await get(ME, credentials.accessToken)).status)
        .toBe(401);

    } finally {
      if (gate.isTransactionActive) {
        await gate.rollbackTransaction();
      }

      if (resetPending) await resetPending;
      if (authPending) await authPending;

      await gate.release();

      await db.query(
        'DROP TRIGGER IF EXISTS admin_password_race_probe ON "users"',
      );

      await db.query(
        "DROP FUNCTION IF EXISTS admin_password_race_probe()",
      );
    }

    const fresh = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: NEW_PASSWORD })
      .expect(200);

    expect((await get(ME, fresh.body.data.accessToken)).status)
      .toBe(200);
  }, 40000);

  // ======================================================
  // Role and status mutations. No HTTP route is exposed yet.
  // ======================================================

  function actorFor(user: UserEntity) {
    return {
      userId: user.id,
      sessionVersion: user.sessionVersion,
    };
  }

  async function expectOldSessionRejected(
    accessToken: string,
    refreshToken: string,
  ) {
    const me = await get(ME, accessToken);

    expect(me.status).toBe(401);

    const refreshed = await request(app.getHttpServer())
      .post("/api/v1/auth/refresh")
      .send({ refreshToken });

    expect(refreshed.status).toBe(401);
  }

  it("validates status updates and denies ordinary users without mutation", async () => {
    const { user, credentials } = await passwordTarget(
      "status-denied@example.test",
    );

    const users = db.getRepository(UserEntity);
    const sessions = db.getRepository(RefreshTokenEntity);

    const before = await users.findOneByOrFail({ id: user.id });
    const tokens = await sessions.findBy({ userId: user.id });

    await expect(updateService().updateStatus(
      actorFor(user), String(user.id), { isActive: false },
    )).rejects.toMatchObject({
      status: 403,
      response: { code: "ADMIN_REQUIRED" },
    });

    await expect(updateService().updateStatus(
      { ...administratorActor(), sessionVersion: "999" },
      String(user.id),
      { isActive: false },
    )).rejects.toMatchObject({ status: 401 });

    for (const body of [
      {},
      { isActive: "false" },
      { isActive: 0 },
      { isActive: null },
      { isActive: false, role: UserRole.ADMIN },
      { isActive: false, storageQuota: "0" },
      { isActive: false, sessionVersion: "9" },
    ]) {
      await expect(updateService().updateStatus(
        administratorActor(), String(user.id), body,
      )).rejects.toMatchObject({
        status: 400,
        response: { code: "VALIDATION_ERROR" },
      });
    }

    await expect(updateService().updateStatus(
      administratorActor(), "2147483647", { isActive: false },
    )).rejects.toMatchObject({
      status: 404,
      response: { code: "USER_NOT_FOUND" },
    });

    expect(await users.findOneByOrFail({ id: user.id }))
      .toEqual(before);

    expect(await sessions.findBy({ userId: user.id }))
      .toEqual(tokens);

    expect((await get(ME, credentials.accessToken)).status)
      .toBe(200);
  });

  it("changes role and email atomically with exactly one session version increment", async () => {
    const { user, credentials } = await passwordTarget(
      "role-change@example.test",
    );

    const users = db.getRepository(UserEntity);
    const sessions = db.getRepository(RefreshTokenEntity);

    const before = await users.findOneByOrFail({ id: user.id });

    const promoted = await updateService().updateProfile(
      administratorActor(),
      String(user.id),
      {
        role: UserRole.ADMIN,
        email: " ROLE-PROMOTED@Example.TEST ",
        name: "Promoted administrator",
      },
    );

    expect(promoted).toMatchObject({
      id: user.id,
      role: UserRole.ADMIN,
      email: "role-promoted@example.test",
      name: "Promoted administrator",
    });

    const after = await users.findOneByOrFail({ id: user.id });

    expect(after).toEqual({
      ...before,
      role: UserRole.ADMIN,
      email: "role-promoted@example.test",
      name: "Promoted administrator",
      isEmailVerified: false,
      sessionVersion: "2",
      updatedAt: after.updatedAt,
    });

    expect(await sessions.countBy({
      userId: user.id, revoked: false,
    })).toBe(0);

    await expectOldSessionRejected(
      credentials.accessToken, credentials.refreshToken,
    );

    const adminSession = await login(after.email);

    expect((await get(ENDPOINT, adminSession.accessToken)).status)
      .toBe(200);

    const noOpBefore = await users.findOneByOrFail({ id: user.id });

    await updateService().updateProfile(
      administratorActor(),
      String(user.id),
      { role: UserRole.ADMIN },
    );

    expect(await users.findOneByOrFail({ id: user.id }))
      .toEqual(noOpBefore);

    expect((await get(ENDPOINT, adminSession.accessToken)).status)
      .toBe(200);

    const demoted = await updateService().updateProfile(
      administratorActor(),
      String(user.id),
      { role: UserRole.USER },
    );

    expect(demoted.role).toBe(UserRole.USER);

    expect((await users.findOneByOrFail({ id: user.id }))
      .sessionVersion).toBe("3");

    await expectOldSessionRejected(
      adminSession.accessToken, adminSession.refreshToken,
    );

    const ordinarySession = await login(after.email);

    const denied = await get(ENDPOINT, ordinarySession.accessToken);

    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("ADMIN_REQUIRED");

    const profile = await get(ME, ordinarySession.accessToken);

    expect(profile.status).toBe(200);
    expect(profile.body.data.capabilities)
      .toEqual({ manageUsers: false });
  });

  it("blocks and reactivates an account without reviving old credentials", async () => {
    const { user, credentials } = await passwordTarget(
      "status-lifecycle@example.test",
    );

    const users = db.getRepository(UserEntity);
    const sessions = db.getRepository(RefreshTokenEntity);

    const before = await users.findOneByOrFail({ id: user.id });

    const blocked = await updateService().updateStatus(
      administratorActor(), String(user.id), { isActive: false },
    );

    expect(blocked).toMatchObject({
      id: user.id,
      isActive: false,
      storageQuota: "1073741824",
      storageUsed: "0",
    });

    const afterBlock = await users.findOneByOrFail({ id: user.id });

    expect(afterBlock).toEqual({
      ...before,
      isActive: false,
      sessionVersion: "2",
      updatedAt: afterBlock.updatedAt,
    });

    expect(await sessions.countBy({
      userId: user.id, revoked: false,
    })).toBe(0);

    await expectOldSessionRejected(
      credentials.accessToken, credentials.refreshToken,
    );

    await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: PASSWORD })
      .expect(401);

    await updateService().updateStatus(
      administratorActor(), String(user.id), { isActive: false },
    );

    expect(await users.findOneByOrFail({ id: user.id }))
      .toEqual(afterBlock);

    const unblocked = await updateService().updateStatus(
      administratorActor(), String(user.id), { isActive: true },
    );

    expect(unblocked.isActive).toBe(true);

    const afterUnblock = await users.findOneByOrFail({
      id: user.id,
    });

    expect(afterUnblock.sessionVersion).toBe("3");

    await expectOldSessionRejected(
      credentials.accessToken, credentials.refreshToken,
    );

    const fresh = await login(user.email);

    expect((await get(ME, fresh.accessToken)).status).toBe(200);

    await updateService().updateStatus(
      administratorActor(), String(user.id), { isActive: true },
    );

    expect(await users.findOneByOrFail({ id: user.id }))
      .toEqual(afterUnblock);

    expect((await get(ME, fresh.accessToken)).status).toBe(200);
  });

  it("rolls back role and status changes if session revocation fails", async () => {
    const { user, credentials } = await passwordTarget(
      "role-status-rollback@example.test",
    );

    const users = db.getRepository(UserEntity);
    const sessions = db.getRepository(RefreshTokenEntity);

    const before = await users.findOneByOrFail({ id: user.id });
    const tokens = await sessions.findBy({ userId: user.id });
    const table = db.getMetadata(RefreshTokenEntity).tableName;

    await db.query(`
      CREATE FUNCTION admin_role_status_rollback_probe()
      RETURNS trigger LANGUAGE plpgsql AS $fixture$
      BEGIN
        RAISE EXCEPTION 'fixture role status revocation failure';
      END;
      $fixture$;
    `);

    try {
      await db.query(`
        CREATE TRIGGER admin_role_status_rollback_probe
        BEFORE UPDATE ON "${table}"
        FOR EACH ROW
        EXECUTE FUNCTION admin_role_status_rollback_probe()
      `);

      await expect(updateService().updateProfile(
        administratorActor(),
        String(user.id),
        { role: UserRole.ADMIN, name: "Must roll back" },
      )).rejects.toThrow("fixture role status revocation failure");

      await expect(updateService().updateStatus(
        administratorActor(),
        String(user.id),
        { isActive: false },
      )).rejects.toThrow("fixture role status revocation failure");

      expect(await users.findOneByOrFail({ id: user.id }))
        .toEqual(before);

      expect(await sessions.findBy({ userId: user.id }))
        .toEqual(tokens);

      expect((await get(ME, credentials.accessToken)).status)
        .toBe(200);

    } finally {
      await db.query(
        `DROP TRIGGER IF EXISTS admin_role_status_rollback_probe ON "${table}"`,
      );

      await db.query(
        "DROP FUNCTION IF EXISTS admin_role_status_rollback_probe()",
      );
    }
  });

  it.each([
    "demotion",
    "blocking",
    "mixed",
  ] as const)(
    "preserves the last active administrator during concurrent %s",
    async (mode) => {
      const first = await passwordTarget(
        `last-${mode}-first@example.test`,
        UserRole.ADMIN,
      );

      const second = await passwordTarget(
        `last-${mode}-second@example.test`,
        UserRole.ADMIN,
      );

      const users = db.getRepository(UserEntity);
      const sessions = db.getRepository(RefreshTokenEntity);

      // Test-only isolation: keep exactly these two active ADMINs.
      // Preserve all other fixture rows for restoration afterwards.
      const others = (await users.findBy({
        role: UserRole.ADMIN,
        isActive: true,
      })).filter((user) =>
        user.id !== first.user.id && user.id !== second.user.id,
      );

      const otherIds = others.map((user) => user.id);
      const gate = db.createQueryRunner();

      let pending:
        Promise<PromiseSettledResult<
          Awaited<ReturnType<AdminUsersWriteService["updateStatus"]>>
        >[]> | undefined;

      try {
        if (otherIds.length > 0) {
          await users.update(otherIds, { isActive: false });
        }

        expect(await users.countBy({
          role: UserRole.ADMIN,
          isActive: true,
        })).toBe(2);

        const firstBefore = await users.findOneByOrFail({
          id: first.user.id,
        });

        const secondBefore = await users.findOneByOrFail({
          id: second.user.id,
        });

        await gate.connect();
        await gate.startTransaction();
        await lockAdminTransactions(gate.manager);

        // Both actors try to remove themselves. Regardless of
        // acquisition order, exactly one operation can succeed.
        const firstOperation = mode === "blocking"
          ? updateService().updateStatus(
              actorFor(first.user),
              String(first.user.id),
              { isActive: false },
            )
          : updateService().updateProfile(
              actorFor(first.user),
              String(first.user.id),
              { role: UserRole.USER },
            );

        const secondOperation = mode === "demotion"
          ? updateService().updateProfile(
              actorFor(second.user),
              String(second.user.id),
              { role: UserRole.USER },
            )
          : updateService().updateStatus(
              actorFor(second.user),
              String(second.user.id),
              { isActive: false },
            );

        pending = Promise.allSettled([
          firstOperation,
          secondOperation,
        ]);

        await waitForCreateLock(2);

        await gate.commitTransaction();

        const outcomes = await pending;

        expect(outcomes.filter((r) =>
          r.status === "fulfilled",
        )).toHaveLength(1);

        expect(outcomes.filter((r) =>
          r.status === "rejected",
        )).toHaveLength(1);

        expect(outcomes.find((r) =>
          r.status === "rejected",
        )).toMatchObject({
          status: "rejected",
          reason: {
            status: 409,
            response: { code: "LAST_ACTIVE_ADMIN" },
          },
        });

        const remaining = await users.findBy({
          role: UserRole.ADMIN,
          isActive: true,
        });

        expect(remaining).toHaveLength(1);

        const survivor = remaining[0];
        const survivorFixture =
          survivor.id === first.user.id ? first : second;

        const removedFixture =
          survivor.id === first.user.id ? second : first;

        const survivorBefore =
          survivor.id === first.user.id
            ? firstBefore
            : secondBefore;

        expect(survivor).toEqual(survivorBefore);

        expect(await sessions.countBy({
          userId: survivor.id,
          revoked: false,
        })).toBe(1);

        const removed = await users.findOneByOrFail({
          id: removedFixture.user.id,
        });

        expect(removed.sessionVersion).toBe("2");

        expect(await sessions.countBy({
          userId: removed.id,
          revoked: false,
        })).toBe(0);

        await expectOldSessionRejected(
          removedFixture.credentials.accessToken,
          removedFixture.credentials.refreshToken,
        );

        // Both mechanisms independently protect the last ADMIN.
        await expect(updateService().updateProfile(
          actorFor(survivor),
          String(survivor.id),
          { role: UserRole.USER, name: "Must not change" },
        )).rejects.toMatchObject({
          status: 409,
          response: { code: "LAST_ACTIVE_ADMIN" },
        });

        await expect(updateService().updateStatus(
          actorFor(survivor),
          String(survivor.id),
          { isActive: false },
        )).rejects.toMatchObject({
          status: 409,
          response: { code: "LAST_ACTIVE_ADMIN" },
        });

        expect(await users.findOneByOrFail({ id: survivor.id }))
          .toEqual(survivorBefore);

        expect((await get(
          ENDPOINT,
          survivorFixture.credentials.accessToken,
        )).status).toBe(200);

      } finally {
        if (gate.isTransactionActive) {
          await gate.rollbackTransaction();
        }

        if (pending) await pending;

        await gate.release();

        // Restore the unrelated disposable fixtures. No real
        // production accounts are involved in this test.
        for (const user of others) {
          await users.update(user.id, {
            isActive: true,
            updatedAt: user.updatedAt,
          });
        }
      }
    },
    30000,
  );
});
