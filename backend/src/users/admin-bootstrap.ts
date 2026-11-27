import { DataSource, EntityManager } from "typeorm";
import { isEmail } from "class-validator";
import * as bcrypt from "bcryptjs";

import { UserEntity, UserRole } from "../entities/user.entity";
import {
  lockSessionUser,
  revokeLockedUserSessions,
} from "../auth/session-revocation";
import { lockAdminTransactions } from "./admin-transaction-lock";
import { normalizeUserEmail } from "./user-email";

export type AdminBootstrapRequest =
  | {
      mode: "create";
      email: string;
      name: string;
      password: string;
    }
  | {
      mode: "promote";
      userId: number;
      email: string;
    };

export type AdminBootstrapResult = {
  status: "created" | "promoted" | "already-configured";
  userId: number;
  email: string;
  role: UserRole.ADMIN;
};

export type AdminBootstrapErrorCode =
  | "INVALID_BOOTSTRAP_INPUT"
  | "BOOTSTRAP_REQUIRES_EMPTY_DATABASE"
  | "ACTIVE_ADMIN_ALREADY_EXISTS"
  | "BOOTSTRAP_USER_NOT_FOUND"
  | "BOOTSTRAP_USER_IDENTITY_MISMATCH"
  | "BOOTSTRAP_USER_INACTIVE";

export class AdminBootstrapError extends Error {
  constructor(public readonly code: AdminBootstrapErrorCode) {
    super(code);
    this.name = "AdminBootstrapError";
  }
}

function invalidInput(): never {
  throw new AdminBootstrapError("INVALID_BOOTSTRAP_INPUT");
}

export function validInitialPassword(password: unknown): password is string {
  return typeof password === "string" &&
    Array.from(password).length >= 12 &&
    Buffer.byteLength(password, "utf8") <= 72 &&
    !password.includes(String.fromCharCode(0));
}

function validateRequest(request: AdminBootstrapRequest): void {
  if (
    !request ||
    typeof request.email !== "string" ||
    request.email.length === 0 ||
    request.email.length > 1024 ||
    request.email.includes(String.fromCharCode(0))
  ) {
    invalidInput();
  }

  if (request.mode === "create") {
    if (
      typeof request.name !== "string" ||
      request.name.trim().length === 0 ||
      Array.from(request.name.trim()).length > 100 ||
      request.name.includes(String.fromCharCode(0)) ||
      !validInitialPassword(request.password)
    ) {
      invalidInput();
    }

    return;
  }

  if (request.mode === "promote") {
    if (
      !Number.isSafeInteger(request.userId) ||
      request.userId < 1 ||
      request.userId > 2147483647
    ) {
      invalidInput();
    }

    return;
  }

  invalidInput();
}

function result(
  status: AdminBootstrapResult["status"],
  user: Pick<UserEntity, "id" | "email">,
): AdminBootstrapResult {
  return {
    status,
    userId: user.id,
    email: user.email,
    role: UserRole.ADMIN,
  };
}

async function canonicalIdentity(
  manager: EntityManager,
  email: string,
): Promise<string> {
  const canonical = await normalizeUserEmail(manager, email);

  if (!isEmail(canonical)) {
    invalidInput();
  }

  return canonical;
}

async function countActiveAdmins(
  manager: EntityManager,
): Promise<number> {
  return manager.count(UserEntity, {
    where: { role: UserRole.ADMIN, isActive: true },
  });
}

/**
 * Operator-only domain operation.
 *
 * Do not expose this function through a public HTTP controller.
 * Authorization to invoke it is provided by the host maintenance CLI.
 *
 * Lock order: administrative advisory lock -> user row -> refresh rows.
 */
export async function bootstrapAdmin(
  database: DataSource,
  request: AdminBootstrapRequest,
): Promise<AdminBootstrapResult> {
  validateRequest(request);

  // Hash outside the transaction to avoid holding DB locks during bcrypt.
  // A repeated create never replaces an existing password.
  const passwordHash =
    request.mode === "create"
      ? await bcrypt.hash(request.password, 12)
      : undefined;

  return database.transaction("READ COMMITTED", async (manager) => {
    await lockAdminTransactions(manager);

    if (request.mode === "create") {
      // Serialize the empty-database check with ordinary user INSERTs.
      // This mode never locks existing users or their refresh rows.
      await manager.query(
        'LOCK TABLE "users" IN SHARE ROW EXCLUSIVE MODE',
      );
    }

    const email = await canonicalIdentity(manager, request.email);

    if (request.mode === "create") {
      const existing = await manager.findOne(UserEntity, {
        where: { email },
      });

      if (
        existing?.isActive &&
        existing.role === UserRole.ADMIN
      ) {
        return result("already-configured", existing);
      }

      if (await countActiveAdmins(manager) !== 0) {
        throw new AdminBootstrapError("ACTIVE_ADMIN_ALREADY_EXISTS");
      }

      if (await manager.count(UserEntity) !== 0) {
        throw new AdminBootstrapError(
          "BOOTSTRAP_REQUIRES_EMPTY_DATABASE",
        );
      }

      if (!passwordHash) {
        throw new Error("Missing bootstrap password hash");
      }

      const user = manager.create(UserEntity, {
        email,
        name: request.name.trim(),
        password: passwordHash,
        role: UserRole.ADMIN,
        isActive: true,
        isEmailVerified: false,
        sessionVersion: "1",
        storageQuota: 0,
        storageUsed: 0,
      });

      const saved = await manager.save(user);

      return result("created", saved);
    }

    // Exact ID and canonical email are both mandatory.
    // Re-read under the lock before changing the user's role.
    const user = await lockSessionUser(manager, request.userId);

    if (!user) {
      throw new AdminBootstrapError("BOOTSTRAP_USER_NOT_FOUND");
    }

    if (user.email !== email) {
      throw new AdminBootstrapError(
        "BOOTSTRAP_USER_IDENTITY_MISMATCH",
      );
    }

    if (!user.isActive) {
      throw new AdminBootstrapError("BOOTSTRAP_USER_INACTIVE");
    }

    if (user.role === UserRole.ADMIN) {
      return result("already-configured", user);
    }

    if (await countActiveAdmins(manager) !== 0) {
      throw new AdminBootstrapError("ACTIVE_ADMIN_ALREADY_EXISTS");
    }

    const updated = await manager.update(
      UserEntity,
      { id: user.id },
      { role: UserRole.ADMIN },
    );

    if (updated.affected !== 1) {
      throw new Error("Administrator promotion failed");
    }

    // Role change, session version increment and refresh revocation
    // are committed together. Any failure rolls everything back.
    await revokeLockedUserSessions(manager, user);

    return result("promoted", user);
  });
}
