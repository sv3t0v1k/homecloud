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
import { lockAdminTransactions } from "./admin-transaction-lock";
import { UserEntity, UserRole } from "../entities/user.entity";
import { RefreshTokenEntity } from "../entities/refresh-token.entity";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { ShareLinkEntity } from "../entities/share-link.entity";
import { StorageLocationEntity } from "../entities/storage-location.entity";
import { UploadWorkspaceEntity } from "../entities/upload-workspace.entity";
import { UploadSessionEntity } from "../entities/upload-session.entity";
import { UploadChunkEntity } from "../entities/upload-chunk.entity";
import { HttpExceptionFilter } from "../common/errors/http-exception.filter";
import { TransformInterceptor } from "../common/interceptors/transform.interceptor";

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
          ],
        }),
        UsersModule,
      ],
    })
      .overrideProvider(ConfigService)
      .useValue(config)
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

  it("does not open administrative update endpoints prematurely", async () => {
    const headers = { Authorization: `Bearer ${adminToken}` };

    await request(app.getHttpServer())
      .patch(`${ENDPOINT}/${ordinary.id}`)
      .set(headers).send({}).expect(404);

    await request(app.getHttpServer())
      .put(`${ENDPOINT}/${ordinary.id}/password`)
      .set(headers).send({}).expect(404);

    await request(app.getHttpServer())
      .patch(`${ENDPOINT}/${ordinary.id}/status`)
      .set(headers).send({}).expect(404);

    expect(await db.getRepository(UserEntity).count()).toBe(3);
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
});
