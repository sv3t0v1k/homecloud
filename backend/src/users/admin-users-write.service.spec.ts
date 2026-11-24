import { DataSource, EntityManager, QueryFailedError } from "typeorm";
import * as bcrypt from "bcryptjs";
import { UserEntity, UserRole } from "../entities/user.entity";
import { AdminUsersWriteService } from "./admin-users-write.service";
import { ADMIN_TRANSACTION_LOCK_KEYS } from "./admin-transaction-lock";

const actor = { userId: 10, sessionVersion: "3" };
const admin = {
  id: 10,
  role: UserRole.ADMIN,
  isActive: true,
  sessionVersion: "3",
};

const input = {
  name: " New user ",
  email: " NEW@Example.TEST ",
  password: "test-password-for-admin-create",
  role: UserRole.USER,
  storageQuota: "1073741824",
};

const row = {
  id: 20,
  name: "New user",
  email: "new@example.test",
  role: UserRole.USER,
  isActive: true,
  storageQuota: "1073741824",
  storageUsed: "0",
  fileCount: "0",
  folderCount: "0",
  createdAt: new Date("2026-11-16T10:00:00Z"),
};

describe("AdminUsersWriteService create", () => {
  const preliminary = jest.fn();
  const findOne = jest.fn();
  const query = jest.fn();

  const manager = {
    findOne,
    query,
    queryRunner: { isTransactionActive: true },
    connection: {
      getMetadata: jest.fn(() => ({ uniques: [] })),
    },
  };

  const transaction = jest.fn((
    _isolation: string,
    work: (manager: EntityManager) => Promise<unknown>,
  ) => work(manager as unknown as EntityManager));

  const service = new AdminUsersWriteService({
    manager: { findOne: preliminary },
    transaction,
  } as unknown as DataSource);

  beforeEach(() => {
    jest.clearAllMocks();
    preliminary.mockResolvedValue(admin);
    findOne.mockResolvedValue(admin);
    query.mockReset();
    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ email: row.email }])
      .mockResolvedValueOnce([row]);
  });

  it("creates a canonical USER with a real bcrypt hash and safe response", async () => {
    const result = await service.create(actor, input);

    expect(result).toEqual({
      ...row,
      fileCount: 0,
      folderCount: 0,
      createdAt: row.createdAt.toISOString(),
    });

    expect(transaction).toHaveBeenCalledWith(
      "READ COMMITTED",
      expect.any(Function),
    );

    expect(query.mock.calls[0]).toEqual([
      "SELECT pg_advisory_xact_lock($1::integer, $2::integer)",
      [...ADMIN_TRANSACTION_LOCK_KEYS],
    ]);

    expect(findOne).toHaveBeenCalledWith(
      UserEntity,
      expect.objectContaining({
        where: { id: actor.userId },
        lock: { mode: "pessimistic_write" },
      }),
    );

    expect(query.mock.invocationCallOrder[0])
      .toBeLessThan(findOne.mock.invocationCallOrder[0]);

    expect(findOne.mock.invocationCallOrder[0])
      .toBeLessThan(query.mock.invocationCallOrder[1]);

    const [sql, parameters] = query.mock.calls[2];

    expect(sql).toContain('INSERT INTO "users"');
    expect(sql).not.toContain(input.password);
    expect(sql).not.toContain("ON CONFLICT");

    expect(parameters).toEqual([
      row.name,
      row.email,
      expect.stringMatching(/^\$2[aby]\$12\$/),
      UserRole.USER,
      input.storageQuota,
    ]);

    expect(await bcrypt.compare(input.password, parameters[2]))
      .toBe(true);

    expect(result).not.toHaveProperty("password");
    expect(result).not.toHaveProperty("sessionVersion");
    expect(result).not.toHaveProperty("accessToken");
  });

  it("allows explicit ADMIN creation with zero initial quota", async () => {
    query.mockReset();
    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ email: row.email }])
      .mockResolvedValueOnce([{
        ...row,
        role: UserRole.ADMIN,
        storageQuota: "0",
      }]);

    await expect(service.create(actor, {
      ...input,
      role: UserRole.ADMIN,
      storageQuota: "0",
    })).resolves.toMatchObject({
      role: UserRole.ADMIN,
      storageQuota: "0",
      storageUsed: "0",
    });
  });

  it("rejects ordinary users before the transaction", async () => {
    preliminary.mockResolvedValue({
      ...admin,
      role: UserRole.USER,
    });

    await expect(service.create(actor, input))
      .rejects.toMatchObject({
        status: 403,
        response: { code: "ADMIN_REQUIRED" },
      });

    expect(transaction).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects invalid input before opening a transaction", async () => {
    await expect(service.create(actor, {
      ...input,
      sessionVersion: "999",
    })).rejects.toMatchObject({ status: 400 });

    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([
    { ...admin, role: UserRole.USER },
    { ...admin, sessionVersion: "4" },
    { ...admin, isActive: false },
    null,
  ])("rechecks authorization after obtaining the lock", async (current) => {
    findOne.mockResolvedValue(current);

    await expect(service.create(actor, input)).rejects.toBeDefined();

    // Advisory lock only; no normalization or account INSERT.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("maps the production email uniqueness violation to 409", async () => {
    const error = new QueryFailedError(
      "INSERT",
      [],
      Object.assign(new Error("private database details"), {
        code: "23505",
        constraint: "users_email_key",
      }),
    );

    query.mockReset();
    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ email: row.email }])
      .mockRejectedValueOnce(error);

    await expect(service.create(actor, input))
      .rejects.toMatchObject({
        status: 409,
        response: {
          code: "EMAIL_ALREADY_EXISTS",
          message: "Email already exists",
        },
      });
  });

  it("does not misclassify unrelated uniqueness failures", async () => {
    const error = new QueryFailedError(
      "INSERT",
      [],
      Object.assign(new Error("other unique constraint"), {
        code: "23505",
        constraint: "users_pkey",
      }),
    );

    query.mockReset();
    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ email: row.email }])
      .mockRejectedValueOnce(error);

    await expect(service.create(actor, input)).rejects.toBe(error);
  });

  it("fails rather than returning an inconsistent persisted account", async () => {
    query.mockReset();
    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ email: row.email }])
      .mockResolvedValueOnce([{ ...row, storageUsed: "1" }]);

    await expect(service.create(actor, input))
      .rejects.toThrow("Unexpected created user state");
  });
});
