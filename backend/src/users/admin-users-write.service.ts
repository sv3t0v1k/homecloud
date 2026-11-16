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

import { UserEntity } from "../entities/user.entity";
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
  AdminUserDto,
  AdminChangePasswordResultDto,
  parseAdminChangePassword,
  parseAdminCreateUser,
  parseAdminUpdateUser,
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

  // Internal first part of the administrative PATCH operation.
  // Role and quota changes are deliberately unavailable until
  // their transaction invariants are implemented.
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

    if (input.role !== undefined || input.storageQuota !== undefined) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Invalid administrator request",
      });
    }

    return this.database.transaction(
      "READ COMMITTED",
      async (manager) => {
        const target = await this.lockMutationTarget(manager, actor, id);

        // Explicit field allowlist, never arbitrary entity updates.
        const changes: Partial<
          Pick<UserEntity, "name" | "email" | "isEmailVerified">
        > = {};

        if (input.name !== undefined && input.name !== target.name) {
          changes.name = input.name;
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

        // The old identity and all refresh sessions are invalidated
        // atomically with the actual email change.
        if (emailChanged) {
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
}
