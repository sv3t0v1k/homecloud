import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { isEmail } from "class-validator";
import { DataSource, EntityManager } from "typeorm";
import * as bcrypt from "bcryptjs";

import { UserEntity, UserRole } from "../entities/user.entity";
import { isSessionVersion } from "../auth/session-token";
import {
  lockSessionUser,
  revokeLockedUserSessions,
} from "../auth/session-revocation";
import { lockAdminTransactions } from "./admin-transaction-lock";
import {
  AdminActor,
  assertAdminActor,
  presentAdminUser,
  readAdminUser,
  validateActorIdentity,
} from "./admin-users-read.service";
import {
  canSetStorageQuota,
  readStorageCommitments,
} from "../storage/storage-accounting";
import {
  AdminUserDto,
  AdminChangePasswordResultDto,
  parseAdminChangePassword,
  parseAdminCreateUser,
  parseAdminUpdateUser,
  parseAdminChangeStatus,
  parseAdminUserId,
} from "./dtos/admin-user.dto";
import {
  isUserEmailConflict,
  normalizeUserEmail,
} from "./user-email";

const AUTHORIZATION_FIELDS = {
  id: true,
  role: true,
  isActive: true,
  sessionVersion: true,
} as const;

@Injectable()
export class AdminUsersWriteService {
  constructor(private readonly database: DataSource) {}

  async create(
    actor: AdminActor,
    rawBody: unknown,
  ): Promise<AdminUserDto> {
    if (
      !actor ||
      !Number.isSafeInteger(actor.userId) ||
      actor.userId < 1 ||
      actor.userId > 2_147_483_647 ||
      !isSessionVersion(actor.sessionVersion)
    ) {
      throw new UnauthorizedException({
        code: "UNAUTHORIZED",
        message: "Unauthorized",
      });
    }

    // Cheap preliminary authorization prevents ordinary users
    // from triggering expensive bcrypt work.
    const current = await this.database.manager.findOne(
      UserEntity,
      {
        select: AUTHORIZATION_FIELDS,
        where: { id: actor.userId },
      },
    );

    assertAdminActor(actor, current);

    const input = parseAdminCreateUser(rawBody);

    // Hash outside the transaction. Authorization below must
    // be repeated because the actor may change during hashing.
    const passwordHash = await bcrypt.hash(input.password, 12);

    return this.database.transaction(
      "READ COMMITTED",
      async (manager) => {
        // Shared lock order with operator bootstrap and all
        // subsequent administrative account mutations.
        await lockAdminTransactions(manager);

        const lockedActor = await manager.findOne(UserEntity, {
          select: AUTHORIZATION_FIELDS,
          where: { id: actor.userId },
          lock: { mode: "pessimistic_write" },
        });

        assertAdminActor(actor, lockedActor);

        const email = await normalizeUserEmail(
          manager,
          input.email,
        );

        if (!isEmail(email)) {
          throw new BadRequestException({
            code: "VALIDATION_ERROR",
            message: "Invalid administrator request",
          });
        }

        // INSERT only; never upsert or overwrite an existing account.
        // All values are parameters. Quota remains an exact decimal
        // string until PostgreSQL converts it to bigint.
        let rows: Parameters<typeof presentAdminUser>[0][];

        try {
          rows = await manager.query(`
            INSERT INTO "users" (
              name, email, password, role,
              "isActive", "isEmailVerified", "sessionVersion",
              "storageQuota", "storageUsed"
            )
            VALUES ($1, $2, $3, $4, true, false, 1, $5::bigint, 0)
            RETURNING
              id, name, email, role, "isActive",
              "storageQuota"::text AS "storageQuota",
              "storageUsed"::text AS "storageUsed",
              '0'::text AS "fileCount",
              '0'::text AS "folderCount",
              "createdAt"
          `, [
            input.name,
            email,
            passwordHash,
            input.role,
            input.storageQuota,
          ]);
        } catch (error) {
          if (isUserEmailConflict(error, manager)) {
            throw new ConflictException({
              code: "EMAIL_ALREADY_EXISTS",
              message: "Email already exists",
            });
          }

          throw error;
        }

        if (rows.length !== 1) {
          throw new Error("Unexpected user creation result");
        }

        const result = presentAdminUser(rows[0]);

        // Validate the resulting account before committing.
        if (
          result.email !== email ||
          result.name !== input.name ||
          result.role !== input.role ||
          result.isActive !== true ||
          result.storageQuota !== input.storageQuota ||
          result.storageUsed !== "0"
        ) {
          throw new Error("Unexpected created user state");
        }

        // New accounts receive no sessions. They authenticate
        // later using the ordinary login endpoint.
        return result;
      },
    );
  }

  // Administrative profile PATCH. Quota changes share the user-row
  // lock with upload and copy admission, so the shared accounting
  // snapshot inside the transaction is authoritative.
  async updateProfile(
    actor: AdminActor,
    rawId: unknown,
    rawBody: unknown,
  ): Promise<AdminUserDto> {
    validateActorIdentity(actor);

    const current = await this.database.manager.findOne(
      UserEntity,
      {
        select: AUTHORIZATION_FIELDS,
        where: { id: actor.userId },
      },
    );

    assertAdminActor(actor, current);

    const id = parseAdminUserId(rawId);
    const input = parseAdminUpdateUser(rawBody);

    return this.database.transaction(
      "READ COMMITTED",
      async (manager) => {
        const target = await this.lockMutationTarget(manager, actor, id);

        // Explicit field allowlist, never arbitrary entity updates.
        const changes: Partial<
          Pick<UserEntity, "name" | "email" | "isEmailVerified" | "role" | "storageQuota">
        > = {};

        if (input.storageQuota !== undefined) {
          // The target row is already locked: this snapshot sees the
          // same commitments that admission checks against.
          const accounting = await readStorageCommitments(manager, id);

          if (!canSetStorageQuota(accounting, BigInt(input.storageQuota))) {
            throw new ConflictException({
              code: "QUOTA_BELOW_COMMITMENTS",
              message:
                "Storage quota cannot be below used and reserved bytes",
            });
          }

          // The decimal string passes verbatim to the bigint column.
          if (input.storageQuota !== String(target.storageQuota)) {
            changes.storageQuota =
              input.storageQuota as unknown as number;
          }
        }

        if (input.name !== undefined && input.name !== target.name) {
          changes.name = input.name;
        }

        const roleChanged =
          input.role !== undefined && input.role !== target.role;

        if (roleChanged && input.role !== undefined) {
          await this.assertActiveAdminRemains(
            manager,
            target,
            input.role,
            target.isActive,
          );

          changes.role = input.role;
        }

        let emailChanged = false;

        if (input.email !== undefined) {
          let email: string;

          try {
            email = await normalizeUserEmail(manager, input.email);
          } catch (error) {
            if (error instanceof BadRequestException) {
              throw new BadRequestException({
                code: "VALIDATION_ERROR",
                message: "Invalid administrator request",
              });
            }

            throw error;
          }

          if (!isEmail(email)) {
            throw new BadRequestException({
              code: "VALIDATION_ERROR",
              message: "Invalid administrator request",
            });
          }

          if (email !== target.email) {
            changes.email = email;
            changes.isEmailVerified = false;
            emailChanged = true;
          }
        }

        // A canonical no-op does not change updatedAt or sessions.
        if (Object.keys(changes).length > 0) {
          try {
            const updated = await manager.update(
              UserEntity,
              { id },
              changes,
            );

            if (updated.affected !== 1) {
              throw new Error("Administrative profile update failed");
            }
          } catch (error) {
            if (isUserEmailConflict(error, manager)) {
              throw new ConflictException({
                code: "EMAIL_ALREADY_EXISTS",
                message: "Email already exists",
              });
            }

            throw error;
          }
        }

        // Email and role changes share a single version increment.
        // A combined PATCH revokes sessions once, atomically.
        if (emailChanged || roleChanged) {
          await revokeLockedUserSessions(manager, target);
        }

        // Reuse the exact safe DTO and file statistics.
        // Do not open a nested transaction or reacquire actor locks.
        return readAdminUser(manager, id);
      },
    );
  }

  // Shared lock order for existing-account mutations:
  // admin advisory lock -> ascending user IDs -> refresh rows.
  private async lockMutationTarget(
    manager: EntityManager,
    actor: AdminActor,
    id: number,
  ): Promise<UserEntity> {
    await lockAdminTransactions(manager);

    const locked = new Map<number, UserEntity>();

    const ids = [...new Set([actor.userId, id])]
      .sort((a, b) => a - b);

    for (const userId of ids) {
      const user = await lockSessionUser(manager, userId);

      if (user) {
        locked.set(userId, user);
      }
    }

    assertAdminActor(actor, locked.get(actor.userId) ?? null);

    const target = locked.get(id);

    if (!target) {
      throw new NotFoundException({
        code: "USER_NOT_FOUND",
        message: "User not found",
      });
    }

    return target;
  }

  async changePassword(
    actor: AdminActor,
    rawId: unknown,
    rawBody: unknown,
  ): Promise<AdminChangePasswordResultDto> {
    validateActorIdentity(actor);

    // Reject ordinary users before performing expensive bcrypt.
    const current = await this.database.manager.findOne(
      UserEntity,
      {
        select: AUTHORIZATION_FIELDS,
        where: { id: actor.userId },
      },
    );

    assertAdminActor(actor, current);

    const id = parseAdminUserId(rawId);
    const input = parseAdminChangePassword(rawBody);

    // Hash outside the transaction; repeat authorization under
    // the authoritative lock before modifying the account.
    const passwordHash = await bcrypt.hash(input.newPassword, 12);

    return this.database.transaction(
      "READ COMMITTED",
      async (manager) => {
        const target = await this.lockMutationTarget(
          manager,
          actor,
          id,
        );

        const updated = await manager.update(
          UserEntity,
          { id },
          { password: passwordHash },
        );

        if (updated.affected !== 1) {
          throw new Error("Administrative password update failed");
        }

        // Password, version increment, and refresh-token
        // revocation must commit or roll back together.
        await revokeLockedUserSessions(manager, target);

        return {
          passwordChanged: true,
          sessionsRevoked: true,
        };
      },
    );
  }

  // Caller owns the administrative advisory lock and the
  // target user row lock in the same transaction.
  private async assertActiveAdminRemains(
    manager: EntityManager,
    target: UserEntity,
    nextRole: UserRole,
    nextActive: boolean,
  ): Promise<void> {
    const wasActiveAdmin =
      target.role === UserRole.ADMIN && target.isActive === true;

    const willBeActiveAdmin =
      nextRole === UserRole.ADMIN && nextActive === true;

    if (!wasActiveAdmin || willBeActiveAdmin) {
      return;
    }

    // Every production role/status mutation and bootstrap
    // serializes through the same administrative advisory lock.
    const activeAdmins = await manager.count(UserEntity, {
      where: {
        role: UserRole.ADMIN,
        isActive: true,
      },
    });

    if (activeAdmins <= 1) {
      throw new ConflictException({
        code: "LAST_ACTIVE_ADMIN",
        message: "The last active administrator cannot be removed",
      });
    }
  }

  // Internal operation only. The HTTP status endpoint must
  // remain unavailable until alternative credentials are fenced.
  async updateStatus(
    actor: AdminActor,
    rawId: unknown,
    rawBody: unknown,
  ): Promise<AdminUserDto> {
    validateActorIdentity(actor);

    const current = await this.database.manager.findOne(
      UserEntity,
      {
        select: AUTHORIZATION_FIELDS,
        where: { id: actor.userId },
      },
    );

    assertAdminActor(actor, current);

    const id = parseAdminUserId(rawId);
    const input = parseAdminChangeStatus(rawBody);

    return this.database.transaction(
      "READ COMMITTED",
      async (manager) => {
        const target = await this.lockMutationTarget(
          manager,
          actor,
          id,
        );

        // Repeated status assignment is a genuine no-op.
        if (target.isActive === input.isActive) {
          return readAdminUser(manager, id);
        }

        await this.assertActiveAdminRemains(
          manager,
          target,
          target.role,
          input.isActive,
        );

        const updated = await manager.update(
          UserEntity,
          { id },
          { isActive: input.isActive },
        );

        if (updated.affected !== 1) {
          throw new Error("Administrative status update failed");
        }

        // Both actual status transitions invalidate existing
        // sessions. Reactivation never revives old credentials.
        await revokeLockedUserSessions(manager, target);

        // Alternative credentials, public capabilities and
        // in-flight storage operations are handled in 01.6.
        return readAdminUser(manager, id);
      },
    );
  }
}
