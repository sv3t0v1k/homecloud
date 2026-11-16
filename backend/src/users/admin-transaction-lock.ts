import { EntityManager } from "typeorm";

/**
 * All administrator membership/status mutations must acquire this
 * transaction-scoped lock before locking individual user rows.
 *
 * Keep these two PostgreSQL advisory-lock keys stable across versions.
 * The two-integer namespace is separate from bigint advisory locks.
 */
export const ADMIN_TRANSACTION_LOCK_KEYS = [1212369985, 1] as const;

export async function lockAdminTransactions(
  manager: EntityManager,
): Promise<void> {
  if (!manager.queryRunner?.isTransactionActive) {
    throw new Error("Administrative lock requires an active transaction");
  }

  await manager.query(
    "SELECT pg_advisory_xact_lock($1::integer, $2::integer)",
    [...ADMIN_TRANSACTION_LOCK_KEYS],
  );
}
