import { DataSource, EntityManager } from "typeorm";
import { UserEntity, UserRole } from "../entities/user.entity";

import {
  AdminActor,
  AdminUsersReadService,
  assertAdminActor,
  presentAdminUser,
} from "./admin-users-read.service";

const actor: AdminActor = {
  userId: 10,
  sessionVersion: "3",
};

const admin = {
  id: 10,
  role: UserRole.ADMIN,
  isActive: true,
  sessionVersion: "3",
};

const row = {
  id: 20,
  name: "Ordinary user",
  email: "user@example.test",
  role: UserRole.USER,
  isActive: true,
  storageQuota: "1073741824",
  storageUsed: "1024",
  fileCount: "7",
  folderCount: "2",
  createdAt: new Date("2026-11-16T10:00:00.000Z"),
};

const presented = {
  id: 20,
  name: "Ordinary user",
  email: "user@example.test",
  role: UserRole.USER,
  isActive: true,
  storageQuota: "1073741824",
  storageUsed: "1024",
  fileCount: 7,
  folderCount: 2,
  createdAt: "2026-11-16T10:00:00.000Z",
};

describe("AdminUsersReadService", () => {
  const findOne = jest.fn();
  const query = jest.fn();

  const manager = { findOne, query };

  const transaction = jest.fn(
    (
      isolation: string,
      work: (manager: EntityManager) => Promise<unknown>,
    ) => {
      if (isolation !== "READ COMMITTED") {
        throw new Error("Unexpected isolation level");
      }

      return work(manager as unknown as EntityManager);
    },
  );

  const service = new AdminUsersReadService(
    { transaction } as unknown as DataSource,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    findOne.mockResolvedValue(admin);
    query.mockResolvedValue([{ ...row, total: "1" }]);
  });

  it("authorizes against the current locked database row", async () => {
    await expect(service.list(actor, {})).resolves.toEqual({
      items: [presented],
      page: 1,
      pageSize: 25,
      total: 1,
    });

    expect(transaction).toHaveBeenCalledWith(
      "READ COMMITTED",
      expect.any(Function),
    );

    expect(findOne).toHaveBeenCalledWith(UserEntity, {
      select: {
        id: true,
        role: true,
        isActive: true,
        sessionVersion: true,
      },
      where: { id: actor.userId },
      lock: { mode: "pessimistic_read" },
    });

    expect(findOne.mock.invocationCallOrder[0])
      .toBeLessThan(query.mock.invocationCallOrder[0]);
  });

  it.each([
    ["missing account", null],
    ["inactive account", { ...admin, isActive: false }],
    ["stale session", { ...admin, sessionVersion: "4" }],
    ["different account", { ...admin, id: 11 }],
  ])("rejects %s before reading users", async (_name, current) => {
    findOne.mockResolvedValue(current);

    await expect(service.list(actor, {})).rejects.toMatchObject({
      status: 401,
      response: { code: "UNAUTHORIZED" },
    });

    expect(query).not.toHaveBeenCalled();
  });

  it("rejects ordinary users even when a request claims ADMIN", async () => {
    findOne.mockResolvedValue({
      ...admin,
      role: UserRole.USER,
    });

    const forgedActor = { ...actor, role: UserRole.ADMIN };

    await expect(service.list(forgedActor, {}))
      .rejects.toMatchObject({
        status: 403,
        response: { code: "ADMIN_REQUIRED" },
      });

    expect(query).not.toHaveBeenCalled();
  });

  it("denies detail access before looking up the requested user", async () => {
    findOne.mockResolvedValue({ ...admin, role: UserRole.USER });

    await expect(service.get(actor, "999"))
      .rejects.toMatchObject({
        status: 403,
        response: { code: "ADMIN_REQUIRED" },
      });

    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    { ...actor, userId: 0 },
    { ...actor, userId: 2_147_483_648 },
    { ...actor, userId: 1.5 },
    { ...actor, sessionVersion: "0" },
    { ...actor, sessionVersion: "01" },
    { ...actor, sessionVersion: "" },
  ])("rejects malformed actor %p", async (invalid) => {
    await expect(service.list(invalid, {}))
      .rejects.toMatchObject({ status: 401 });

    expect(findOne).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects a non-admin even with a valid session", () => {
    expect(() => assertAdminActor(actor, {
      ...admin,
      role: UserRole.USER,
    })).toThrow("Administrator access required");
  });

  it("preserves literal search characters and parameterizes SQL", async () => {
    const search = "x%'_ OR 1=1 --";

    query.mockResolvedValue([{ ...row, total: "50" }]);

    await expect(service.list(actor, {
      page: "2",
      pageSize: "10",
      search,
    })).resolves.toEqual({
      items: [presented],
      page: 2,
      pageSize: 10,
      total: 50,
    });

    expect(query).toHaveBeenCalledTimes(1);

    const [sql, parameters] = query.mock.calls[0];

    expect(sql).not.toContain(search);
    expect(sql).toContain("strpos(lower(name), lower($1::text))");
    expect(sql).toContain("strpos(lower(email), lower($1::text))");
    expect(sql).toContain('ORDER BY "createdAt" DESC, id DESC');
    expect(sql).toContain("LIMIT $2::integer");
    expect(sql).toContain("OFFSET $3::integer");

    expect(parameters).toEqual([search, 10, 10]);
  });

  it("uses owner-scoped non-deleted file and folder counts", async () => {
    await service.list(actor, {});

    const sql = query.mock.calls[0][0];

    expect(sql).toContain('f."userId" = u.id');
    expect(sql).toContain('f."isDeleted" = false');
    expect(sql).toContain('f."isFolder" = false');
    expect(sql).toContain('f."isFolder" = true');
    expect(sql).not.toContain("storagePath");
    expect(sql).not.toContain("relativeObjectKey");
    expect(sql).not.toContain("password");
  });

  it("returns a total for a page beyond the last user", async () => {
    query.mockResolvedValue([{ id: null, total: "3" }]);

    await expect(service.list(actor, {
      page: "2",
      pageSize: "25",
    })).resolves.toEqual({
      items: [],
      page: 2,
      pageSize: 25,
      total: 3,
    });
  });

  it("returns an empty result for a search with no matches", async () => {
    query.mockResolvedValue([{ id: null, total: "0" }]);

    await expect(service.list(actor, { search: "not-found" }))
      .resolves.toEqual({
        items: [],
        page: 1,
        pageSize: 25,
        total: 0,
      });
  });

  it("returns an explicit detail response", async () => {
    query.mockResolvedValue([row]);

    await expect(service.get(actor, "20"))
      .resolves.toEqual(presented);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE u.id = $1::integer"),
      [20],
    );
  });

  it("returns stable not-found error for a missing user", async () => {
    query.mockResolvedValue([]);

    await expect(service.get(actor, "20"))
      .rejects.toMatchObject({
        status: 404,
        response: { code: "USER_NOT_FOUND" },
      });
  });

  it("validates list input only after authorization", async () => {
    await expect(service.list(actor, { pageSize: "101" }))
      .rejects.toMatchObject({ status: 400 });

    expect(findOne).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects invalid detail identifiers before SQL", async () => {
    await expect(service.get(actor, "20 OR 1=1"))
      .rejects.toMatchObject({ status: 400 });

    expect(query).not.toHaveBeenCalled();
  });

  it("rejects an unexpected empty SQL result for a list", async () => {
    query.mockResolvedValue([]);

    await expect(service.list(actor, {}))
      .rejects.toMatchObject({
        status: 503,
        response: { code: "STORAGE_ACCOUNTING_UNAVAILABLE" },
      });
  });

  it("rejects mismatched detail identity", async () => {
    query.mockResolvedValue([{ ...row, id: 21 }]);

    await expect(service.get(actor, "20"))
      .rejects.toMatchObject({ status: 503 });
  });

  it("does not return a partial success if the database fails", async () => {
    query.mockRejectedValue(new Error("database unavailable"));

    await expect(service.list(actor, {}))
      .rejects.toThrow("database unavailable");
  });
});

describe("Admin user response allowlist", () => {
  it("never returns internal credentials or arbitrary columns", () => {
    const sensitive = {
      ...row,
      password: "private-hash-marker",
      sessionVersion: "7",
      refreshToken: "private-token-marker",
      avatar: "internal-avatar",
      relativeObjectKey: "internal-object-key",
    };

    expect(presentAdminUser(sensitive)).toEqual(presented);
  });

  it("preserves exact decimal quota and used-byte strings", () => {
    expect(presentAdminUser({
      ...row,
      storageQuota: "9007199254740991",
      storageUsed: "9007199254740990",
    })).toEqual({
      ...presented,
      storageQuota: "9007199254740991",
      storageUsed: "9007199254740990",
    });
  });

  it("allows zero quota and storage usage", () => {
    expect(presentAdminUser({
      ...row,
      storageQuota: "0",
      storageUsed: "0",
      fileCount: "0",
      folderCount: "0",
    })).toEqual({
      ...presented,
      storageQuota: "0",
      storageUsed: "0",
      fileCount: 0,
      folderCount: 0,
    });
  });

  it("preserves the recorded usage even above assigned quota", () => {
    expect(presentAdminUser({
      ...row,
      storageQuota: "0",
      storageUsed: "1024",
    }).storageUsed).toBe("1024");
  });

  it.each([
    { storageQuota: "-1" },
    { storageQuota: "9007199254740992" },
    { storageQuota: "1.5" },
    { storageUsed: "01" },
    { storageUsed: "-1" },
    { storageUsed: "1e3" },
    { fileCount: "-1" },
    { folderCount: "9007199254740992" },
    { fileCount: "1.5" },
    { createdAt: new Date("invalid") },
    { id: 0 },
    { id: null },
  ])("fails closed on invalid database row %p", (changes) => {
    expect(() => presentAdminUser({ ...row, ...changes }))
      .toThrow("Storage accounting unavailable");
  });
});
