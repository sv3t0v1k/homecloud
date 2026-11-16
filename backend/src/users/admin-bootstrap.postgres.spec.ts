import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { DataSource } from "typeorm";
import * as bcrypt from "bcryptjs";

import {
  bootstrapAdmin,
  AdminBootstrapRequest,
} from "./admin-bootstrap";
import { lockAdminTransactions } from "./admin-transaction-lock";

import { AuthService } from "../auth/auth.service";
import { JwtStrategy } from "../auth/jwt.strategy";
import { UserEntity, UserRole } from "../entities/user.entity";
import { RefreshTokenEntity } from "../entities/refresh-token.entity";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { ShareLinkEntity } from "../entities/share-link.entity";
import { StorageLocationEntity } from "../entities/storage-location.entity";
import { UploadWorkspaceEntity } from "../entities/upload-workspace.entity";
import { UploadSessionEntity } from "../entities/upload-session.entity";
import { UploadChunkEntity } from "../entities/upload-chunk.entity";

const databaseUrl = process.env.HOMECLOUD_TEST_DATABASE_URL;
const postgres = databaseUrl ? describe : describe.skip;

const PASSWORD = "bootstrap-qualification-password";
const ACCESS_SECRET = "bootstrap-test-access-secret-not-production";
const REFRESH_SECRET = "bootstrap-test-refresh-secret-not-production";

postgres("Operator administrator bootstrap", () => {
  let admin: DataSource;
  let db: DataSource;
  let schema: string;
  let schemaCreated = false;

  let auth: AuthService;
  let jwt: JwtService;
  let strategy: JwtStrategy;

  const users = () => db.getRepository(UserEntity);
  const tokens = () => db.getRepository(RefreshTokenEntity);

  beforeEach(async () => {
    schema = `admin_bootstrap_${randomUUID().replace(/-/g, "")}`;
    schemaCreated = false;

    admin = new DataSource({
      type: "postgres",
      url: databaseUrl,
    });

    await admin.initialize();

    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;

    db = new DataSource({
      type: "postgres",
      url: databaseUrl,
      schema,
      synchronize: true,
      extra: {
        application_name: schema,
        options: [
          `-c search_path=${schema}`,
          "-c lock_timeout=20000",
          "-c statement_timeout=25000",
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
      ],
    });

    await db.initialize();

    const config = new ConfigService({
      JWT_SECRET: ACCESS_SECRET,
      JWT_REFRESH_SECRET: REFRESH_SECRET,
      JWT_EXPIRES_IN: "15m",
      JWT_REFRESH_EXPIRES_IN: "7d",
    });

    jwt = new JwtService({ secret: ACCESS_SECRET });

    auth = new AuthService(
      users(),
      tokens(),
      jwt,
      config,
    );

    strategy = new JwtStrategy(users(), config);
  }, 30000);

  afterEach(async () => {
    try {
      if (db?.isInitialized) {
        await db.destroy();
      }
    } finally {
      if (admin?.isInitialized) {
        try {
          if (schemaCreated) {
            await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
          }
        } finally {
          await admin.destroy();
        }
      }
    }
  }, 30000);

  function createRequest(
    email = "admin@example.test",
  ): AdminBootstrapRequest {
    return {
      mode: "create",
      email,
      name: "Administrator",
      password: PASSWORD,
    };
  }

  async function createUser(email: string) {
    // Create only an ordinary user in this isolated test schema.
    // Tokens are obtained through the real authentication service.
    await users().insert({
      email,
      password: await bcrypt.hash(PASSWORD, 12),
      name: "Existing user",
      role: UserRole.USER,
      isActive: true,
      sessionVersion: "1",
    });

    const issued = await auth.login(email, PASSWORD);

    const user = await users().findOneByOrFail({ email });

    return { user, issued };
  }

  async function activeAdmins() {
    return users().countBy({
      role: UserRole.ADMIN,
      isActive: true,
    });
  }

  async function waitForAdvisoryWaits(expected: number) {
    const deadline = Date.now() + 12000;

    while (Date.now() < deadline) {
      const [row] = await admin.query(
        `SELECT count(*)::int AS count
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND application_name = $1
            AND wait_event_type = 'Lock'
            AND query ILIKE '%pg_advisory_xact_lock%'`,
        [schema],
      );

      if (row.count >= expected) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    throw new Error("Expected advisory lock waits were not observed");
  }

  async function concurrentBootstrap(
    requests: AdminBootstrapRequest[],
  ) {
    const runner = db.createQueryRunner();

    let pending:
      | Promise<PromiseSettledResult<
          Awaited<ReturnType<typeof bootstrapAdmin>>
        >[]>
      | undefined;

    try {
      await runner.connect();
      await runner.startTransaction();

      await lockAdminTransactions(runner.manager);

      pending = Promise.allSettled(
        requests.map((request) => bootstrapAdmin(db, request)),
      );

      // Both operations must actually be waiting for PostgreSQL.
      await waitForAdvisoryWaits(requests.length);

      await runner.commitTransaction();

      return await pending;
    } finally {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }

      await runner.release();

      if (pending) {
        await pending;
      }
    }
  }

  it("creates a first administrator, exposes no credentials and never overwrites a password on retry", async () => {
    const request = createRequest("  ADMIN@Example.TEST  ");

    const created = await bootstrapAdmin(db, request);

    expect(created).toEqual({
      status: "created",
      userId: expect.any(Number),
      email: "admin@example.test",
      role: UserRole.ADMIN,
    });

    const user = await users().findOneByOrFail({
      id: created.userId,
    });

    expect(user).toMatchObject({
      role: UserRole.ADMIN,
      isActive: true,
      isEmailVerified: false,
      sessionVersion: "1",
    });

    expect(String(user.storageQuota)).toBe("0");
    expect(String(user.storageUsed)).toBe("0");
    expect(user.password).not.toBe(PASSWORD);
    expect(await bcrypt.compare(PASSWORD, user.password)).toBe(true);

    expect(await tokens().countBy({ userId: user.id })).toBe(0);

    const repeated = await bootstrapAdmin(db, {
      mode: "create",
      email: "ADMIN@example.test",
      name: "Do not replace name",
      password: "different-password-for-retry",
    });

    expect(repeated).toEqual({
      ...created,
      status: "already-configured",
    });

    expect(await users().findOneByOrFail({
      id: user.id,
    })).toEqual(user);

    const issued = await auth.login(user.email, PASSWORD);

    await expect(strategy.validate(jwt.verify(issued.accessToken)))
      .resolves.toMatchObject({
        userId: user.id,
        sessionVersion: "1",
      });

    await expect(bootstrapAdmin(
      db,
      createRequest("another@example.test"),
    )).rejects.toMatchObject({
      code: "ACTIVE_ADMIN_ALREADY_EXISTS",
    });

    expect(await activeAdmins()).toBe(1);
    expect(await users().count()).toBe(1);
  }, 30000);

  it("requires explicit promotion on an existing installation", async () => {
    const { user } = await createUser("existing@example.test");

    await expect(bootstrapAdmin(
      db,
      createRequest("admin@example.test"),
    )).rejects.toMatchObject({
      code: "BOOTSTRAP_REQUIRES_EMPTY_DATABASE",
    });

    await expect(bootstrapAdmin(
      db,
      createRequest(user.email),
    )).rejects.toMatchObject({
      code: "BOOTSTRAP_REQUIRES_EMPTY_DATABASE",
    });

    expect(await activeAdmins()).toBe(0);
    expect(await users().count()).toBe(1);

    expect(await users().findOneByOrFail({
      id: user.id,
    })).toEqual(user);
  }, 30000);

  it("validates ID, canonical email, active status and bootstrap input", async () => {
    const { user } = await createUser("existing@example.test");

    await expect(bootstrapAdmin(db, {
      mode: "promote",
      userId: user.id,
      email: "wrong@example.test",
    })).rejects.toMatchObject({
      code: "BOOTSTRAP_USER_IDENTITY_MISMATCH",
    });

    await expect(bootstrapAdmin(db, {
      mode: "promote",
      userId: user.id + 100000,
      email: user.email,
    })).rejects.toMatchObject({
      code: "BOOTSTRAP_USER_NOT_FOUND",
    });

    await expect(bootstrapAdmin(db, {
      mode: "promote",
      userId: -1,
      email: user.email,
    })).rejects.toMatchObject({
      code: "INVALID_BOOTSTRAP_INPUT",
    });

    await users().update(user.id, { isActive: false });

    await expect(bootstrapAdmin(db, {
      mode: "promote",
      userId: user.id,
      email: user.email,
    })).rejects.toMatchObject({
      code: "BOOTSTRAP_USER_INACTIVE",
    });

    await expect(bootstrapAdmin(db, {
      mode: "create",
      email: "admin@example.test",
      name: "Administrator",
      password: "short",
    })).rejects.toMatchObject({
      code: "INVALID_BOOTSTRAP_INPUT",
    });

    await expect(bootstrapAdmin(db, {
      mode: "create",
      email: "admin@example.test",
      name: "Administrator",
      password: "a".repeat(73),
    })).rejects.toMatchObject({
      code: "INVALID_BOOTSTRAP_INPUT",
    });

    await expect(bootstrapAdmin(
      db,
      createRequest("not-an-email"),
    )).rejects.toMatchObject({
      code: "INVALID_BOOTSTRAP_INPUT",
    });

    expect(await activeAdmins()).toBe(0);

    const after = await users().findOneByOrFail({
      id: user.id,
    });

    expect(after).toMatchObject({
      role: UserRole.USER,
      isActive: false,
      sessionVersion: "1",
    });
  }, 30000);

  it("promotes the exact user, revokes old sessions and preserves other account data", async () => {
    const { user, issued } = await createUser("owner@example.test");
    const second = await createUser("other@example.test");

    await users().update(user.id, {
      storageQuota: 10000,
      storageUsed: 123,
    });

    const before = await users().findOneByOrFail({
      id: user.id,
    });

    const promoted = await bootstrapAdmin(db, {
      mode: "promote",
      userId: user.id,
      email: "  OWNER@Example.TEST ",
    });

    expect(promoted).toEqual({
      status: "promoted",
      userId: user.id,
      email: user.email,
      role: UserRole.ADMIN,
    });

    const after = await users().findOneByOrFail({
      id: user.id,
    });

    expect(after).toMatchObject({
      id: before.id,
      email: before.email,
      password: before.password,
      name: before.name,
      storageQuota: before.storageQuota,
      storageUsed: before.storageUsed,
      isEmailVerified: before.isEmailVerified,
      isActive: true,
      role: UserRole.ADMIN,
      sessionVersion: "2",
    });

    expect(await tokens().countBy({
      userId: user.id,
      revoked: false,
    })).toBe(0);

    await expect(
      strategy.validate(jwt.verify(issued.accessToken)),
    ).rejects.toThrow();

    await expect(
      auth.refresh(user.id, issued.refreshToken),
    ).rejects.toThrow();

    const fresh = await auth.login(user.email, PASSWORD);

    await expect(
      strategy.validate(jwt.verify(fresh.accessToken)),
    ).resolves.toMatchObject({
      userId: user.id,
      sessionVersion: "2",
    });

    const retry = await bootstrapAdmin(db, {
      mode: "promote",
      userId: user.id,
      email: user.email,
    });

    expect(retry.status).toBe("already-configured");

    expect(await users().findOneByOrFail({
      id: user.id,
    })).toEqual(after);

    await expect(bootstrapAdmin(db, {
      mode: "promote",
      userId: second.user.id,
      email: second.user.email,
    })).rejects.toMatchObject({
      code: "ACTIVE_ADMIN_ALREADY_EXISTS",
    });

    expect(await users().findOneByOrFail({
      id: second.user.id,
    })).toEqual(second.user);

    await expect(
      strategy.validate(jwt.verify(second.issued.accessToken)),
    ).resolves.toMatchObject({
      userId: second.user.id,
      sessionVersion: "1",
    });

    expect(await activeAdmins()).toBe(1);
  }, 30000);

  it("serializes simultaneous first-admin creation through real PostgreSQL advisory locks", async () => {
    const results = await concurrentBootstrap([
      createRequest("first@example.test"),
      createRequest("second@example.test"),
    ]);

    const accepted = results.filter((r) => r.status === "fulfilled");

    const denied = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );

    expect(accepted).toHaveLength(1);
    expect(denied).toHaveLength(1);

    expect(denied[0].reason).toMatchObject({
      code: "ACTIVE_ADMIN_ALREADY_EXISTS",
    });

    expect(await activeAdmins()).toBe(1);
    expect(await users().count()).toBe(1);
  }, 30000);

  it("serializes simultaneous promotions and changes exactly one user", async () => {
    const first = await createUser("first@example.test");
    const second = await createUser("second@example.test");

    const results = await concurrentBootstrap([
      {
        mode: "promote",
        userId: first.user.id,
        email: first.user.email,
      },
      {
        mode: "promote",
        userId: second.user.id,
        email: second.user.email,
      },
    ]);

    const accepted = results.filter((r) => r.status === "fulfilled");

    const denied = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );

    expect(accepted).toHaveLength(1);
    expect(denied).toHaveLength(1);

    expect(denied[0].reason).toMatchObject({
      code: "ACTIVE_ADMIN_ALREADY_EXISTS",
    });

    expect(await activeAdmins()).toBe(1);

    const rows = await users().find({
      order: { id: "ASC" },
    });

    const promoted = rows.find((u) => u.role === UserRole.ADMIN)!;
    const unchanged = rows.find((u) => u.role === UserRole.USER)!;

    expect(promoted.sessionVersion).toBe("2");
    expect(unchanged.sessionVersion).toBe("1");

    expect(await tokens().countBy({
      userId: promoted.id,
      revoked: false,
    })).toBe(0);

    expect(await tokens().countBy({
      userId: unchanged.id,
      revoked: false,
    })).toBe(1);
  }, 30000);

  it("rolls back role and session version if refresh revocation fails", async () => {
    const { user, issued } = await createUser("owner@example.test");

    await db.query(`
      CREATE FUNCTION "${schema}".reject_bootstrap_revocation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'bootstrap qualification forced failure';
      END;
      $$;
    `);

    try {
      await db.query(`
        CREATE TRIGGER fail_bootstrap_revocation
        BEFORE UPDATE ON "${schema}".refresh_tokens
        FOR EACH ROW
        WHEN (NEW.revoked AND NOT OLD.revoked)
        EXECUTE FUNCTION "${schema}".reject_bootstrap_revocation()
      `);

      try {
        await expect(bootstrapAdmin(db, {
          mode: "promote",
          userId: user.id,
          email: user.email,
        })).rejects.toThrow(
          "bootstrap qualification forced failure",
        );

        expect(await users().findOneByOrFail({
          id: user.id,
        })).toEqual(user);

        expect(await activeAdmins()).toBe(0);

        expect(await tokens().countBy({
          userId: user.id,
          revoked: false,
        })).toBe(1);

        await expect(
          strategy.validate(jwt.verify(issued.accessToken)),
        ).resolves.toMatchObject({
          userId: user.id,
          sessionVersion: "1",
        });
      } finally {
        await db.query(`
          DROP TRIGGER IF EXISTS fail_bootstrap_revocation
          ON "${schema}".refresh_tokens
        `);
      }
    } finally {
      await db.query(`
        DROP FUNCTION "${schema}".reject_bootstrap_revocation()
      `);
    }

    await expect(bootstrapAdmin(db, {
      mode: "promote",
      userId: user.id,
      email: user.email,
    })).resolves.toMatchObject({
      status: "promoted",
    });
  }, 30000);
});
