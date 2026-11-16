import { ServiceUnavailableException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import {
  canAddStorageBytes,
  canSetStorageQuota,
  lockStorageCommitments,
  MAX_STORAGE_BYTES,
  readStorageCommitments,
} from "./storage-accounting";

describe("Shared storage accounting", () => {
  const query = jest.fn();
  const manager = {
    query,
    queryRunner: { isTransactionActive: true },
  } as unknown as EntityManager;

  const row = {
    id: 10,
    isActive: true,
    quota: "1000",
    used: "400",
    uploadBytes: "300",
    copyBytes: "100",
    activeCopyCount: "1",
    invalidUploads: "0",
    invalidCopies: "0",
  };

  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue([row]);
  });

  it("sums used bytes and both reservation classes exactly", async () => {
    const result = await readStorageCommitments(manager, 10);

    expect(result).toEqual({
      userId: 10,
      isActive: true,
      quota: 1000n,
      used: 400n,
      uploadBytes: 300n,
      copyBytes: 100n,
      activeCopyCount: 1n,
      committedBytes: 800n,
      remainingBytes: 200n,
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([10]);
  });

  it("includes all active workspaces and origins without a second SSD reservation", async () => {
    await readStorageCommitments(manager, 10);

    const sql = query.mock.calls[0][0];

    expect(sql).toContain(
      `s.status IN ('pending', 'uploading')`,
    );

    expect(sql).toContain(
      `c.state IN ('reserved', 'cleanup_required')`,
    );

    expect(sql).toContain('s."userId" = u.id');
    expect(sql).toContain('c."userId" = u.id');

    expect(sql).not.toContain("ssd_finalization_operations");
    expect(sql).not.toContain('"workspaceId"');
    expect(sql).not.toContain('"expiresAt"');
    expect(sql).not.toContain("FOR UPDATE");
  });

  it("locks the owner before reading a fresh accounting statement", async () => {
    query.mockReset();
    query
      .mockResolvedValueOnce([{ id: 10 }])
      .mockResolvedValueOnce([row]);

    const result = await lockStorageCommitments(manager, 10);

    expect(result.committedBytes).toBe(800n);

    expect(query).toHaveBeenNthCalledWith(
      1,
      'SELECT id FROM "users" WHERE id = $1 FOR UPDATE',
      [10],
    );

    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('FROM "users" u'),
      [10],
    );

    expect(query).toHaveBeenCalledTimes(2);
  });

  it("rejects transactional accounting without an active transaction", async () => {
    const inactive = {
      query,
      queryRunner: { isTransactionActive: false },
    } as unknown as EntityManager;

    await expect(lockStorageCommitments(inactive, 10))
      .rejects.toMatchObject({
        status: 503,
        response: { code: "STORAGE_ACCOUNTING_UNAVAILABLE" },
      });

    expect(query).not.toHaveBeenCalled();
  });

  it("does not accept a plain connection as a transactional lock", async () => {
    const plain = { query } as unknown as EntityManager;

    await expect(lockStorageCommitments(plain, 10))
      .rejects.toMatchObject({ status: 503 });

    expect(query).not.toHaveBeenCalled();
  });

  it("rejects a missing owner without reading reservations", async () => {
    query.mockResolvedValue([]);

    await expect(lockStorageCommitments(manager, 10))
      .rejects.toMatchObject({ status: 404 });

    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing owner in an informational read", async () => {
    query.mockResolvedValue([]);

    await expect(readStorageCommitments(manager, 10))
      .rejects.toMatchObject({ status: 404 });
  });

  it("rejects an unexpected locked identity", async () => {
    query.mockResolvedValue([{ id: 11 }]);

    await expect(lockStorageCommitments(manager, 10))
      .rejects.toMatchObject({ status: 503 });

    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects ambiguous accounting results", async () => {
    query.mockResolvedValue([row, row]);

    await expect(readStorageCommitments(manager, 10))
      .rejects.toMatchObject({ status: 503 });
  });

  it("preserves aggregates above the safe integer boundary", async () => {
    query.mockResolvedValue([{
      ...row,
      quota: MAX_STORAGE_BYTES.toString(),
      used: MAX_STORAGE_BYTES.toString(),
      uploadBytes: "9007199254740993",
      copyBytes: "2",
    }]);

    const result = await readStorageCommitments(manager, 10);

    expect(result.committedBytes).toBe(18014398509481986n);
    expect(result.remainingBytes).toBe(0n);
    expect(canSetStorageQuota(result, MAX_STORAGE_BYTES))
      .toBe(false);
    expect(canAddStorageBytes(result, 1n)).toBe(false);
  });

  it("allows an exact reservation boundary but never one byte more", async () => {
    const result = await readStorageCommitments(manager, 10);

    expect(canAddStorageBytes(result, 200n)).toBe(true);
    expect(canAddStorageBytes(result, 201n)).toBe(false);

    expect(canSetStorageQuota(result, 800n)).toBe(true);
    expect(canSetStorageQuota(result, 799n)).toBe(false);
  });

  it("allows quota management but denies admission for an inactive account", async () => {
    query.mockResolvedValue([{
      ...row,
      isActive: false,
    }]);

    const result = await readStorageCommitments(manager, 10);

    expect(canSetStorageQuota(result, 900n)).toBe(true);
    expect(canAddStorageBytes(result, 1n)).toBe(false);
    expect(canAddStorageBytes(result, 0n)).toBe(false);
  });

  it("supports empty accounts and zero-byte file copies", async () => {
    query.mockResolvedValue([{
      ...row,
      quota: "0",
      used: "0",
      uploadBytes: "0",
      copyBytes: "0",
      activeCopyCount: "1",
    }]);

    const result = await readStorageCommitments(manager, 10);

    expect(result.committedBytes).toBe(0n);
    expect(result.remainingBytes).toBe(0n);
    expect(result.activeCopyCount).toBe(1n);
    expect(canSetStorageQuota(result, 0n)).toBe(true);
    expect(canAddStorageBytes(result, 0n)).toBe(true);
    expect(canAddStorageBytes(result, 1n)).toBe(false);
  });

  it.each([
    { id: 11 },
    { isActive: "true" },
    { quota: "-1" },
    { quota: "9007199254740992" },
    { used: -1 },
    { used: "1.5" },
    { used: "01" },
    { uploadBytes: "-1" },
    { uploadBytes: "1e3" },
    { uploadBytes: "1\n" },
    { copyBytes: undefined },
    { copyBytes: null },
    { copyBytes: " 100" },
    { invalidUploads: "1" },
    { invalidCopies: "1" },
    { activeCopyCount: "-1" },
    { activeCopyCount: "0" },
  ])("fails closed for corrupt accounting %p", async (patch) => {
    query.mockResolvedValue([{ ...row, ...patch }]);

    await expect(readStorageCommitments(manager, 10))
      .rejects.toMatchObject({
        status: 503,
        response: { code: "STORAGE_ACCOUNTING_UNAVAILABLE" },
      });
  });

  it.each([
    0,
    -1,
    1.5,
    2147483648,
    NaN,
    Infinity,
    "10",
  ])("rejects invalid owner identity %p", async (id) => {
    await expect(
      readStorageCommitments(manager, id as number),
    ).rejects.toMatchObject({ status: 503 });

    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    -1n,
    9007199254740992n,
    1,
    "1",
  ])("rejects invalid mutation amounts %p", async (amount) => {
    const result = await readStorageCommitments(manager, 10);

    expect(() => canAddStorageBytes(
      result, amount as bigint,
    )).toThrow(ServiceUnavailableException);

    expect(() => canSetStorageQuota(
      result, amount as bigint,
    )).toThrow(ServiceUnavailableException);
  });

  it("does not mask a PostgreSQL query failure as zero commitments", async () => {
    const error = new Error("fixture database unavailable");

    query.mockRejectedValue(error);

    await expect(readStorageCommitments(manager, 10))
      .rejects.toBe(error);
  });
});
