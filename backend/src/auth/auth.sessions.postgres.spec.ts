import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { DataSource, EntityManager } from "typeorm";
import * as bcrypt from "bcryptjs";

import { AuthService } from "./auth.service";
import { normalizeUserEmail } from "../users/user-email";
import { JwtStrategy } from "./jwt.strategy";
import {
  lockSessionUser,
  revokeLockedUserSessions,
} from "./session-revocation";
import { refreshTokenDigest } from "./session-token";
import { RevokeLegacyRefreshTokens1792831500000 } from "../migrations/1792831500000-RevokeLegacyRefreshTokens";

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

const ACCESS_SECRET = "auth-session-test-access-secret-not-production";
const REFRESH_SECRET = "auth-session-test-refresh-secret-not-production";

const OLD_PASSWORD = "old-password-for-qualification";
const NEW_PASSWORD = "new-password-for-qualification";

postgres("Real PostgreSQL session concurrency", () => {
  const schema = `auth_sessions_${randomUUID().replace(/-/g, "")}`;

  let admin: DataSource;
  let db: DataSource;
  let auth: AuthService;
  let strategy: JwtStrategy;
  let jwt: JwtService;
  let schemaCreated = false;

  beforeAll(async () => {
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
      db.getRepository(UserEntity),
      db.getRepository(RefreshTokenEntity),
      jwt,
      config,
    );

    strategy = new JwtStrategy(
      db.getRepository(UserEntity),
      config,
    );
  }, 30000);

  afterAll(async () => {
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

  const users = () => db.getRepository(UserEntity);
  const tokens = () => db.getRepository(RefreshTokenEntity);

  // Test-only account preparation. No HTTP registration endpoint
  // or production registration service is involved.
  async function createFixtureAccount(
    email: string,
    password: string,
    name: string,
  ) {
    const canonicalEmail = await normalizeUserEmail(
      db.manager,
      email,
    );

    const passwordHash = await bcrypt.hash(password, 12);

    await users().insert({
      email: canonicalEmail,
      password: passwordHash,
      name,
      role: UserRole.USER,
      isActive: true,
      sessionVersion: "1",
    });

    // All test credentials are issued by the real login flow.
    return auth.login(canonicalEmail, password);
  }

  async function createUser() {
    const email = `${randomUUID()}@example.test`;

    const issued = await createFixtureAccount(
      email,
      OLD_PASSWORD,
      "Qualification user",
    );

    const user = await users().findOneByOrFail({ email });

    return { user, issued };
  }

  async function activeTokenCount(userId: number) {
    return tokens().countBy({
      userId,
      revoked: false,
    });
  }

  async function validateAccess(token: string) {
    return strategy.validate(jwt.verify(token));
  }

  // Observe a real database lock wait, not an arbitrary sleep.
  async function waitForBlockedOperations(expected: number) {
    const deadline = Date.now() + 12000;

    while (Date.now() < deadline) {
      const [row] = await admin.query(
        `SELECT count(*)::int AS count
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND application_name = $1
            AND wait_event_type = 'Lock'
            AND query ILIKE '%FOR UPDATE%'`,
        [schema],
      );

      if (row.count >= expected) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    throw new Error(
      `Did not observe ${expected} real PostgreSQL lock waits`,
    );
  }

  async function queueBehindUserLock<T>(
    userId: number,
    start: () => Promise<T>[],
    mutate?: (
      manager: EntityManager,
      locked: UserEntity,
    ) => Promise<void>,
  ): Promise<PromiseSettledResult<T>[]> {
    const runner = db.createQueryRunner();
    let pending: Promise<PromiseSettledResult<T>[]> | undefined;

    try {
      await runner.connect();
      await runner.startTransaction();

      const locked = await lockSessionUser(runner.manager, userId);

      if (!locked) {
        throw new Error("Test user not found");
      }

      const operations = start();

      // Attach handlers immediately, including on test failure.
      pending = Promise.allSettled(operations);

      await waitForBlockedOperations(operations.length);

      if (mutate) {
        await mutate(runner.manager, locked);
      }

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

  function expectUnauthorized(result: PromiseSettledResult<unknown>) {
    expect(result.status).toBe("rejected");

    if (result.status === "rejected") {
      expect(result.reason.getStatus()).toBe(401);
    }
  }

  it("issues versioned JWTs, stores the complete digest and rejects legacy or wrong-purpose credentials", async () => {
    const { user, issued } = await createUser();

    expect(user.role).toBe(UserRole.USER);
    expect(user.sessionVersion).toBe("1");

    expect(jwt.verify(issued.accessToken)).toMatchObject({
      sub: user.id,
      sv: "1",
      tokenUse: "access",
    });

    const refresh = await auth.verifyRefreshToken(
      issued.refreshToken,
    );

    expect(refresh).toMatchObject({
      sub: user.id,
      sv: "1",
      tokenUse: "refresh",
    });

    const stored = await tokens().findOneByOrFail({
      userId: user.id,
    });

    expect(stored.tokenHash)
      .toBe(refreshTokenDigest(issued.refreshToken));

    expect(stored.expiresAt.getTime()).toBe(refresh.exp * 1000);

    await expect(validateAccess(issued.accessToken))
      .resolves.toMatchObject({
        userId: user.id,
        sessionVersion: "1",
      });

    const legacyAccess = jwt.sign(
      { sub: user.id, email: user.email },
      { expiresIn: "15m" },
    );

    const legacyRefresh = jwt.sign(
      {
        sub: user.id,
        email: user.email,
        jti: randomUUID(),
      },
      {
        secret: REFRESH_SECRET,
        expiresIn: "7d",
      },
    );

    await tokens().save({
      userId: user.id,
      tokenHash: await bcrypt.hash(legacyRefresh, 10),
      expiresAt: new Date(Date.now() + 86400000),
    });

    await expect(validateAccess(legacyAccess)).rejects.toThrow();
    await expect(auth.refresh(user.id, legacyRefresh)).rejects.toThrow();
    await expect(auth.verifyRefreshToken(issued.accessToken))
      .rejects.toThrow();

    const forgedPurpose = jwt.sign(
      {
        sub: user.id,
        email: user.email,
        sv: "1",
        tokenUse: "refresh",
      },
      { expiresIn: "15m" },
    );

    await expect(validateAccess(forgedPurpose)).rejects.toThrow();

    const unregisteredRefresh = jwt.sign(
      {
        sub: user.id,
        email: user.email,
        sv: "1",
        tokenUse: "refresh",
        jti: randomUUID(),
      },
      {
        secret: REFRESH_SECRET,
        expiresIn: "7d",
      },
    );

    await expect(auth.refresh(user.id, unregisteredRefresh))
      .rejects.toThrow("Invalid refresh token");
  }, 30000);

  it("authenticates the same canonical account regardless of email casing or surrounding whitespace", async () => {
    const canonical = `${randomUUID()}@example.test`;
    const supplied = `  ${canonical.toUpperCase()}  `;

    const issued = await createFixtureAccount(
      supplied,
      OLD_PASSWORD,
      "Canonical user",
    );

    const user = await users().findOneByOrFail({
      email: canonical,
    });

    expect(jwt.verify(issued.accessToken)).toMatchObject({
      sub: user.id,
      email: canonical,
    });

    const login = await auth.login(
      canonical.toUpperCase(),
      OLD_PASSWORD,
    );

    await expect(validateAccess(login.accessToken))
      .resolves.toMatchObject({ userId: user.id });

    await expect(auth.login(
      `  ${canonical}  `,
      OLD_PASSWORD,
    )).resolves.toHaveProperty("accessToken");

    await expect(createFixtureAccount(
      canonical.toUpperCase(),
      OLD_PASSWORD,
      "Duplicate",
    )).rejects.toMatchObject({
      driverError: { code: "23505" },
    });

    expect(await users().countBy({
      email: canonical,
    })).toBe(1);
  }, 30000);

  it("permits only one concurrent database insert for equivalent email addresses", async () => {
    const canonical = `${randomUUID()}@example.test`;

    const results = await Promise.allSettled([
      createFixtureAccount(
        canonical,
        OLD_PASSWORD,
        "First",
      ),
      createFixtureAccount(
        ` ${canonical.toUpperCase()} `,
        OLD_PASSWORD,
        "Second",
      ),
    ]);

    const accepted = results.filter(
      (result) => result.status === "fulfilled",
    );

    const denied = results.filter(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );

    expect(accepted).toHaveLength(1);
    expect(denied).toHaveLength(1);
    expect(denied[0].reason).toMatchObject({
      driverError: { code: "23505" },
    });

    expect(await users().countBy({
      email: canonical,
    })).toBe(1);

    const user = await users().findOneByOrFail({
      email: canonical,
    });

    expect(await activeTokenCount(user.id)).toBe(1);
  }, 30000);

  it("changes password and revokes all old access and refresh credentials atomically", async () => {
    const { user, issued } = await createUser();
    const other = await auth.login(user.email, OLD_PASSWORD);

    expect(await activeTokenCount(user.id)).toBe(2);

    await auth.changePassword(
      user.id,
      OLD_PASSWORD,
      NEW_PASSWORD,
      "1",
    );

    const after = await users().findOneByOrFail({ id: user.id });

    expect(after.sessionVersion).toBe("2");
    expect(await bcrypt.compare(NEW_PASSWORD, after.password))
      .toBe(true);
    expect(await activeTokenCount(user.id)).toBe(0);

    for (const session of [issued, other]) {
      await expect(validateAccess(session.accessToken))
        .rejects.toThrow();

      await expect(auth.refresh(user.id, session.refreshToken))
        .rejects.toThrow();
    }

    await expect(auth.login(user.email, OLD_PASSWORD))
      .rejects.toThrow();

    const fresh = await auth.login(user.email, NEW_PASSWORD);

    await expect(validateAccess(fresh.accessToken))
      .resolves.toMatchObject({ sessionVersion: "2" });

    expect(await activeTokenCount(user.id)).toBe(1);
  }, 30000);

  it("rejects a login that verified an old password before waiting for the user lock", async () => {
    const { user } = await createUser();
    const newHash = await bcrypt.hash(NEW_PASSWORD, 12);

    const [result] = await queueBehindUserLock(
      user.id,
      () => [auth.login(user.email, OLD_PASSWORD)],
      async (manager, locked) => {
        await manager.update(
          UserEntity,
          { id: user.id },
          { password: newHash },
        );

        await revokeLockedUserSessions(manager, locked);
      },
    );

    expectUnauthorized(result);

    expect(await activeTokenCount(user.id)).toBe(0);

    const after = await users().findOneByOrFail({ id: user.id });

    expect(after.sessionVersion).toBe("2");

    await expect(auth.login(user.email, NEW_PASSWORD))
      .resolves.toHaveProperty("accessToken");
  }, 30000);

  it("rejects a refresh waiting behind committed session revocation", async () => {
    const { user, issued } = await createUser();

    const [result] = await queueBehindUserLock(
      user.id,
      () => [auth.refresh(user.id, issued.refreshToken)],
      async (manager, locked) => {
        await revokeLockedUserSessions(manager, locked);
      },
    );

    expectUnauthorized(result);

    expect(await activeTokenCount(user.id)).toBe(0);
    expect(await tokens().countBy({ userId: user.id })).toBe(1);

    await expect(validateAccess(issued.accessToken))
      .rejects.toThrow();
  }, 30000);

  it("serializes two concurrent refreshes and commits reuse revocation", async () => {
    const { user, issued } = await createUser();

    const results = await queueBehindUserLock(
      user.id,
      () => [
        auth.refresh(user.id, issued.refreshToken),
        auth.refresh(user.id, issued.refreshToken),
      ],
    );

    const successful = results.filter(
      (result): result is PromiseFulfilledResult<typeof issued> =>
        result.status === "fulfilled",
    );

    const rejected = results.filter(
      (result) => result.status === "rejected",
    );

    expect(successful).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    expectUnauthorized(rejected[0]);

    expect(
      (await users().findOneByOrFail({ id: user.id }))
        .sessionVersion,
    ).toBe("2");

    expect(await activeTokenCount(user.id)).toBe(0);
    expect(await tokens().countBy({ userId: user.id })).toBe(2);

    const rotated = successful[0].value;

    await expect(validateAccess(rotated.accessToken))
      .rejects.toThrow();

    await expect(auth.refresh(user.id, rotated.refreshToken))
      .rejects.toThrow();
  }, 30000);

  it("permits only one concurrent password change from the same session version", async () => {
    const { user } = await createUser();

    const passwords = [
      "concurrent-password-one",
      "concurrent-password-two",
    ];

    const results = await queueBehindUserLock(
      user.id,
      () => passwords.map((password) =>
        auth.changePassword(
          user.id,
          OLD_PASSWORD,
          password,
          "1",
        ),
      ),
    );

    expect(results.filter((r) => r.status === "fulfilled"))
      .toHaveLength(1);

    expect(results.filter((r) => r.status === "rejected"))
      .toHaveLength(1);

    const winner = results.findIndex(
      (result) => result.status === "fulfilled",
    );

    const after = await users().findOneByOrFail({ id: user.id });

    expect(after.sessionVersion).toBe("2");

    expect(await bcrypt.compare(passwords[winner], after.password))
      .toBe(true);

    expect(await bcrypt.compare(passwords[1 - winner], after.password))
      .toBe(false);

    expect(await activeTokenCount(user.id)).toBe(0);

    expectUnauthorized(results[1 - winner]);
  }, 30000);

  it("rolls back password and session version if refresh revocation fails in PostgreSQL", async () => {
    const { user, issued } = await createUser();

    await db.query(`
      CREATE FUNCTION "${schema}".reject_refresh_revocation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'qualification forced revocation failure';
      END;
      $$;
    `);

    try {
      await db.query(`
        CREATE TRIGGER fail_refresh_revocation
        BEFORE UPDATE ON "${schema}".refresh_tokens
        FOR EACH ROW
        WHEN (NEW.revoked AND NOT OLD.revoked)
        EXECUTE FUNCTION "${schema}".reject_refresh_revocation()
      `);

      try {
        await expect(auth.changePassword(
          user.id,
          OLD_PASSWORD,
          NEW_PASSWORD,
          "1",
        )).rejects.toThrow(
          "qualification forced revocation failure",
        );

        const after = await users().findOneByOrFail({
          id: user.id,
        });

        expect(after.sessionVersion).toBe("1");
        expect(after.password).toBe(user.password);
        expect(await activeTokenCount(user.id)).toBe(1);

        await expect(validateAccess(issued.accessToken))
          .resolves.toMatchObject({ sessionVersion: "1" });
      } finally {
        await db.query(`
          DROP TRIGGER IF EXISTS fail_refresh_revocation
          ON "${schema}".refresh_tokens
        `);
      }
    } finally {
      await db.query(`
        DROP FUNCTION "${schema}".reject_refresh_revocation()
      `);
    }

    await expect(auth.refresh(user.id, issued.refreshToken))
      .resolves.toHaveProperty("refreshToken");
  }, 30000);

  it("does not revive revoked credentials after deactivation and reactivation", async () => {
    const { user, issued } = await createUser();

    await db.transaction(async (manager) => {
      const locked = await lockSessionUser(manager, user.id);

      if (!locked) throw new Error("Test user not found");

      await manager.update(
        UserEntity,
        { id: user.id },
        { isActive: false },
      );

      await revokeLockedUserSessions(manager, locked);
    });

    await expect(validateAccess(issued.accessToken))
      .rejects.toThrow();

    await expect(auth.login(user.email, OLD_PASSWORD))
      .rejects.toThrow();

    await db.transaction(async (manager) => {
      const locked = await lockSessionUser(manager, user.id);

      if (!locked) throw new Error("Test user not found");

      await manager.update(
        UserEntity,
        { id: user.id },
        { isActive: true },
      );
    });

    await expect(validateAccess(issued.accessToken))
      .rejects.toThrow();

    await expect(auth.refresh(user.id, issued.refreshToken))
      .rejects.toThrow();

    const fresh = await auth.login(user.email, OLD_PASSWORD);

    await expect(validateAccess(fresh.accessToken))
      .resolves.toMatchObject({ sessionVersion: "2" });
  }, 30000);

  it("revokes historical refresh records without modifying canonical tokens or reviving credentials on down", async () => {
    const { user, issued } = await createUser();

    const current = await tokens().findOneByOrFail({
      tokenHash: refreshTokenDigest(issued.refreshToken),
    });

    const previousDate = new Date("2025-01-01T00:00:00.000Z");

    const oldHash = await bcrypt.hash("legacy-active-token", 4);
    const revokedHash = await bcrypt.hash("legacy-revoked-token", 4);
    const expiredHash = await bcrypt.hash("legacy-expired-token", 4);

    const historical = await tokens().save([
      {
        userId: user.id,
        tokenHash: oldHash,
        revoked: false,
        expiresAt: new Date(Date.now() + 86400000),
      },
      {
        userId: user.id,
        tokenHash: revokedHash,
        revoked: true,
        revokedAt: previousDate,
        expiresAt: new Date(Date.now() + 86400000),
      },
      {
        userId: user.id,
        tokenHash: expiredHash,
        revoked: false,
        expiresAt: previousDate,
      },
      {
        userId: user.id,
        tokenHash: "sha256:not-a-valid-digest",
        revoked: false,
        expiresAt: new Date(Date.now() + 86400000),
      },
    ]);

    const runner = db.createQueryRunner();

    try {
      await runner.connect();
      await runner.startTransaction();

      const repo = runner.manager.getRepository(RefreshTokenEntity);
      const migration = new RevokeLegacyRefreshTokens1792831500000();

      const [clock] = await runner.query(
        'SELECT CURRENT_TIMESTAMP::timestamp AS "revokedAt"',
      ) as { revokedAt: Date }[];

      expect(clock.revokedAt).toBeInstanceOf(Date);

      await migration.up(runner);

      const after = await repo.find({
        where: { userId: user.id },
        order: { id: "ASC" },
      });

      expect(after).toHaveLength(5);

      const unchanged = after.find((row) => row.id === current.id);
      expect(unchanged).toEqual(current);

      for (const row of historical) {
        const updated = after.find((item) => item.id === row.id)!;

        expect(updated.revoked).toBe(true);
        expect(updated.revokedAt).toBeInstanceOf(Date);
        expect(updated.tokenHash).toBe(row.tokenHash);
        expect(updated.expiresAt).toEqual(row.expiresAt);
        expect(updated.userId).toBe(row.userId);

        expect(updated.revokedAt).toEqual(
          row.revoked ? previousDate : clock.revokedAt,
        );
      }

      // Re-execution must not overwrite historical revocation dates.
      await migration.up(runner);

      expect(await repo.find({
        where: { userId: user.id },
        order: { id: "ASC" },
      })).toEqual(after);

      // Metadata rollback cannot resurrect credentials.
      await migration.down(runner);

      expect(await repo.find({
        where: { userId: user.id },
        order: { id: "ASC" },
      })).toEqual(after);

      await runner.commitTransaction();
    } finally {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }

      await runner.release();
    }

    expect(await activeTokenCount(user.id)).toBe(1);

    const unchangedUser = await users().findOneByOrFail({
      id: user.id,
    });

    expect(unchangedUser.password).toBe(user.password);
    expect(unchangedUser.sessionVersion).toBe(user.sessionVersion);

    await expect(validateAccess(issued.accessToken))
      .resolves.toMatchObject({ sessionVersion: "1" });

    await expect(auth.refresh(user.id, issued.refreshToken))
      .resolves.toHaveProperty("refreshToken");
  }, 30000);

  it("logout follows rotation to the active replacement without revoking another session", async () => {
    const { user, issued } = await createUser();

    const secondSession = await auth.login(
      user.email,
      OLD_PASSWORD,
    );

    const rotated = await auth.refresh(
      user.id,
      issued.refreshToken,
    );

    await auth.logout(user.id, issued.refreshToken, "1");

    const revoked = await tokens().findOneByOrFail({
      tokenHash: refreshTokenDigest(rotated.refreshToken),
    });

    expect(revoked.revoked).toBe(true);

    const other = await tokens().findOneByOrFail({
      tokenHash: refreshTokenDigest(secondSession.refreshToken),
    });

    expect(other.revoked).toBe(false);
    expect(await activeTokenCount(user.id)).toBe(1);

    expect(
      (await users().findOneByOrFail({ id: user.id }))
        .sessionVersion,
    ).toBe("1");

    await expect(auth.refresh(
      user.id,
      secondSession.refreshToken,
    )).resolves.toHaveProperty("accessToken");
  }, 30000);
});
