import { EntityManager } from "typeorm";
import { UserEntity } from "../entities/user.entity";
import { RefreshTokenEntity } from "../entities/refresh-token.entity";
import { nextSessionVersion } from "./session-token";

/**
 * Lock the user before accessing refresh-token rows.
 * Session issuance and account-wide revocation share this lock.
 */
export async function lockSessionUser(
  manager: EntityManager,
  userId: number,
): Promise<UserEntity | null> {
  return manager.findOne(UserEntity, {
    where: { id: userId },
    lock: { mode: "pessimistic_write" },
  });
}

/**
 * Caller owns the user's write lock in the same transaction.
 * Version increment and refresh revocation commit together.
 */
export async function revokeLockedUserSessions(
  manager: EntityManager,
  user: Pick<UserEntity, "id" | "sessionVersion">,
): Promise<string> {
  const version = nextSessionVersion(user.sessionVersion);

  const updated = await manager.update(
    UserEntity,
    { id: user.id, sessionVersion: user.sessionVersion },
    { sessionVersion: version },
  );

  if (updated.affected !== 1) {
    throw new Error("Session version update failed");
  }

  await manager
    .createQueryBuilder()
    .update(RefreshTokenEntity)
    .set({ revoked: true, revokedAt: new Date() })
    .where("userId = :userId AND revoked = false", { userId: user.id })
    .execute();

  return version;
}
