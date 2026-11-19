import {
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { EntityManager } from "typeorm";

// Existing API and file-size contracts use safe integer bytes.
// Arithmetic below never converts database accounting to Number.
export const MAX_STORAGE_BYTES = 9007199254740991n;

export interface StorageCommitments {
  userId: number;
  isActive: boolean;
  quota: bigint;
  used: bigint;
  uploadBytes: bigint;
  copyBytes: bigint;
  activeCopyCount: bigint;
  committedBytes: bigint;
  remainingBytes: bigint;
}

interface AccountingRow {
  id: unknown;
  isActive: unknown;
  quota: unknown;
  used: unknown;
  uploadBytes: unknown;
  copyBytes: unknown;
  activeCopyCount: unknown;
  invalidUploads: unknown;
  invalidCopies: unknown;
}

function unavailable(): never {
  throw new ServiceUnavailableException({
    code: "STORAGE_ACCOUNTING_UNAVAILABLE",
    message: "Storage accounting unavailable",
  });
}

function validateUserId(userId: number): void {
  if (
    !Number.isSafeInteger(userId) ||
    userId < 1 ||
    userId > 2147483647
  ) {
    unavailable();
  }
}

// No coercion, whitespace, signs, fractions, or exponent notation.
// Aggregate totals may legitimately exceed MAX_STORAGE_BYTES when
// historical accounting is overcommitted. Preserve exact totals.
function decimal(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value)
  ) {
    return unavailable();
  }

  const parsed = BigInt(value);

  // Also rejects a trailing newline accepted by the regex end anchor.
  if (parsed.toString() !== value) {
    return unavailable();
  }

  return parsed;
}

function boundedBytes(value: unknown): bigint {
  const parsed = decimal(value);

  if (parsed > MAX_STORAGE_BYTES) {
    return unavailable();
  }

  return parsed;
}

// One statement provides a coherent MVCC snapshot for all
// components. No upload, copy or SSD-journal row locks are taken.
//
// Active SSD finalization is already represented by upload_sessions.
// Never add ssd_finalization_operations.totalSize a second time.
//
// TTL, workspace and origin do not release a logical reservation.
// Only a durable lifecycle transition does.
//
// Aggregate validation rejects individual corrupt active amounts
// even when a negative amount would be hidden by a positive sum.
const COMMITMENTS_SQL = `
  SELECT
    u.id,
    u."isActive",
    u."storageQuota"::text AS quota,
    u."storageUsed"::text AS used,
    uploads.bytes AS "uploadBytes",
    uploads.invalid AS "invalidUploads",
    copies.bytes AS "copyBytes",
    copies.count AS "activeCopyCount",
    copies.invalid AS "invalidCopies"
  FROM "users" u
  CROSS JOIN LATERAL (
    SELECT
      COALESCE(SUM(s."totalSize"), 0)::text AS bytes,
      COUNT(*) FILTER (
        WHERE s."totalSize" <= 0
           OR s."totalSize" > 9007199254740991
           OR s."totalSize" IS NULL
      )::text AS invalid
    FROM "upload_sessions" s
    WHERE s."userId" = u.id
      AND s.status IN ('pending', 'uploading')
  ) uploads
  CROSS JOIN LATERAL (
    SELECT
      COALESCE(SUM(c.bytes), 0)::text AS bytes,
      COUNT(*)::text AS count,
      COUNT(*) FILTER (
        WHERE c.bytes < 0
           OR c.bytes > 9007199254740991
           OR c.bytes IS NULL
      )::text AS invalid
    FROM "file_copy_operations" c
    WHERE c."userId" = u.id
      AND c.state IN ('reserved', 'cleanup_required')
  ) copies
  WHERE u.id = $1
`;

function presentCommitments(
  userId: number,
  row: AccountingRow,
): StorageCommitments {
  if (
    !row ||
    row.id !== userId ||
    typeof row.isActive !== "boolean"
  ) {
    return unavailable();
  }

  if (
    decimal(row.invalidUploads) !== 0n ||
    decimal(row.invalidCopies) !== 0n
  ) {
    return unavailable();
  }

  const quota = boundedBytes(row.quota);
  const used = boundedBytes(row.used);
  const uploadBytes = decimal(row.uploadBytes);
  const copyBytes = decimal(row.copyBytes);
  const activeCopyCount = decimal(row.activeCopyCount);

  if (activeCopyCount === 0n && copyBytes !== 0n) {
    return unavailable();
  }

  const committedBytes = used + uploadBytes + copyBytes;

  return {
    userId,
    isActive: row.isActive,
    quota,
    used,
    uploadBytes,
    copyBytes,
    activeCopyCount,
    committedBytes,
    remainingBytes:
      committedBytes >= quota ? 0n : quota - committedBytes,
  };
}

/**
 * Informational snapshot only. Never use this unlocked read alone
 * to admit a new obligation or change a user's quota.
 *
 * Inactive accounts can be inspected; authorization is the
 * responsibility of the calling operation.
 */
export async function readStorageCommitments(
  manager: EntityManager,
  userId: number,
): Promise<StorageCommitments> {
  validateUserId(userId);

  const rows: AccountingRow[] = await manager.query(
    COMMITMENTS_SQL,
    [userId],
  );

  if (!Array.isArray(rows)) {
    return unavailable();
  }

  if (rows.length === 0) {
    throw new NotFoundException("User not found");
  }

  if (rows.length !== 1) {
    return unavailable();
  }

  return presentCommitments(userId, rows[0]);
}

/**
 * Transactional accounting boundary.
 *
 * Use READ COMMITTED and retain the same transaction through
 * admission, publication, or quota mutation. A stronger isolation
 * level requires handling its serialization failures.
 *
 * Lock first, then use a separate SQL statement. A statement
 * that aggregates before waiting for FOR UPDATE could otherwise
 * carry an old snapshot of reservations.
 *
 * This lock is the same users-row lock used by upload and copy
 * admission. It does not acquire child-row or filesystem locks.
 */
export async function lockStorageCommitments(
  manager: EntityManager,
  userId: number,
): Promise<StorageCommitments> {
  validateUserId(userId);

  if (!manager.queryRunner?.isTransactionActive) {
    return unavailable();
  }

  const locked: Array<{ id: number }> = await manager.query(
    `SELECT id FROM "users" WHERE id = $1 FOR UPDATE`,
    [userId],
  );

  if (!Array.isArray(locked)) {
    return unavailable();
  }

  if (locked.length === 0) {
    throw new NotFoundException("User not found");
  }

  if (locked.length !== 1 || locked[0].id !== userId) {
    return unavailable();
  }

  return readStorageCommitments(manager, userId);
}

/**
 * New, previously unreserved bytes.
 * Must be used with locked accounting in a write transaction.
 */
export function canAddStorageBytes(
  accounting: StorageCommitments,
  bytes: bigint,
): boolean {
  if (
    typeof bytes !== "bigint" ||
    bytes < 0n ||
    bytes > MAX_STORAGE_BYTES
  ) {
    return unavailable();
  }

  return accounting.isActive &&
    accounting.committedBytes + bytes <= accounting.quota;
}

/**
 * A quota update may apply to active or inactive accounts.
 * Existing commitments must remain fully covered.
 */
export function canSetStorageQuota(
  accounting: StorageCommitments,
  quota: bigint,
): boolean {
  if (
    typeof quota !== "bigint" ||
    quota < 0n ||
    quota > MAX_STORAGE_BYTES
  ) {
    return unavailable();
  }

  return quota >= accounting.committedBytes;
}
