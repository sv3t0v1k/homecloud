import { EntityManager } from "typeorm";

/**
 * Revoke resource-bound credentials in the caller's account transaction.
 * The caller must hold the target user's write lock. Public upload paths
 * revalidate their share link, so disabling links also fences new public work.
 */
export async function revokeAlternativeUserAccess(
  manager: EntityManager,
  userId: number,
): Promise<void> {
  await manager.query(
    `UPDATE "share_links"
     SET "isActive" = false, "updatedAt" = NOW()
     WHERE "userId" = $1 AND "isActive" = true`,
    [userId],
  );

  await manager.query(
    `DELETE FROM "download_capabilities" WHERE "userId" = $1`,
    [userId],
  );

  await manager.query(
    `DELETE FROM "archive_download_capabilities" WHERE "userId" = $1`,
    [userId],
  );
}
