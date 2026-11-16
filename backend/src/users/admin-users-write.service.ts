import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { isEmail } from "class-validator";
import { DataSource } from "typeorm";
import * as bcrypt from "bcryptjs";

import { UserEntity } from "../entities/user.entity";
import { isSessionVersion } from "../auth/session-token";
import { lockAdminTransactions } from "./admin-transaction-lock";
import {
  AdminActor,
  assertAdminActor,
  presentAdminUser,
} from "./admin-users-read.service";
import {
  AdminUserDto,
  parseAdminCreateUser,
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
}
