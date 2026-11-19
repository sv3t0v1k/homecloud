import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { DataSource } from "typeorm";

import { UserEntity, UserRole } from "../entities/user.entity";
import { FileEntity } from "../entities/file.entity";
import { UploadSessionEntity } from "../entities/upload-session.entity";
import { UploadWorkspaceEntity } from "../entities/upload-workspace.entity";
import {
  UserDeletionCleanupPayload,
  UserDeletionEntity,
} from "../entities/user-deletion.entity";
import {
  LEGACY_UPLOAD_WORKSPACE,
  LEGACY_UPLOAD_WORKSPACE_ID,
  UploadWorkspaceResolver,
} from "../uploads/upload-workspace";
import { StorageService } from "../storage/storage.service";
import { lockSessionUser, revokeLockedUserSessions } from "../auth/session-revocation";
import { lockAdminTransactions } from "./admin-transaction-lock";
import { assertAdminActor, AdminActor, validateActorIdentity } from "./admin-users-read.service";
import { parseAdminUserId } from "./dtos/admin-user.dto";
import { revokeAlternativeUserAccess } from "./account-access-revocation";

export interface AdminUserDeletionResult {
  deleted: true;
  cleanupPending: boolean;
}

@Injectable()
export class AdminUserDeletionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdminUserDeletionService.name);
  private readonly workspaceResolver: UploadWorkspaceResolver;

  constructor(
    private readonly database: DataSource,
    private readonly storage: StorageService,
  ) {
    this.workspaceResolver = new UploadWorkspaceResolver(storage);
  }

  onModuleInit(): Promise<void> {
    return this.resumeCleanup();
  }

  onModuleDestroy(): void {
    this.workspaceResolver.close();
  }

  async delete(
    actor: AdminActor,
    rawId: unknown,
  ): Promise<AdminUserDeletionResult> {
    validateActorIdentity(actor);

    const current = await this.database.manager.findOne(UserEntity, {
      select: {
        id: true,
        role: true,
        isActive: true,
        sessionVersion: true,
      },
      where: { id: actor.userId },
    });

    assertAdminActor(actor, current);
    const id = parseAdminUserId(rawId);

    const payload = await this.database.transaction(
      "READ COMMITTED",
      async (manager) => {
        await lockAdminTransactions(manager);

        const locked = new Map<number, UserEntity>();
        const ids = [...new Set([actor.userId, id])].sort((a, b) => a - b);

        for (const userId of ids) {
          const user = await lockSessionUser(manager, userId);
          if (user) locked.set(userId, user);
        }

        assertAdminActor(actor, locked.get(actor.userId) ?? null);
        const target = locked.get(id);

        if (!target) {
          const retained = await manager.findOne(UserDeletionEntity, {
            where: { userId: id },
          });

          if (retained) return retained.payload;

          throw new NotFoundException({
            code: "USER_NOT_FOUND",
            message: "User not found",
          });
        }

        if (target.id === actor.userId) {
          throw new ConflictException({
            code: "CANNOT_DELETE_SELF",
            message: "The current administrator cannot delete their own account",
          });
        }

        if (target.role === UserRole.ADMIN && target.isActive) {
          const activeAdmins = await manager.count(UserEntity, {
            where: { role: UserRole.ADMIN, isActive: true },
          });

          if (activeAdmins <= 1) {
            throw new ConflictException({
              code: "LAST_ACTIVE_ADMIN",
              message: "The last active administrator cannot be removed",
            });
          }
        }

        // Immutable recovery journals and live storage operations are explicit
        // operator barriers. Never discard them to make account deletion pass.
        const recovery = await manager.query(
          `SELECT id FROM "ssd_finalization_operations"
           WHERE "userId" = $1 LIMIT 1`,
          [id],
        );

        if (recovery.length !== 0) {
          throw new ConflictException({
            code: "USER_RECOVERY_REQUIRED",
            message: "User has retained storage recovery records",
          });
        }

        const activeCopies = await manager.query(
          `SELECT id FROM "file_copy_operations"
           WHERE "userId" = $1
             AND state IN ('reserved', 'cleanup_required')
           LIMIT 1`,
          [id],
        );

        if (activeCopies.length !== 0) {
          throw new ConflictException({
            code: "USER_STORAGE_OPERATIONS_ACTIVE",
            message: "User has unresolved storage operations",
          });
        }

        const files = await manager.find(FileEntity, {
          where: { userId: id, isFolder: false },
        });
        const sessions = await manager.find(UploadSessionEntity, {
          where: { userId: id },
        });

        // A pending legacy session can own an unpublished final hard link after
        // an uncertain COMMIT. Only completed/aborted sessions have a defined
        // physical lifecycle; all other states require their existing recovery.
        if (sessions.some((session) =>
          session.status === "pending" || session.status === "uploading"
        )) {
          throw new ConflictException({
            code: "USER_STORAGE_OPERATIONS_ACTIVE",
            message: "User has unresolved upload operations",
          });
        }

        if (sessions.some((session) =>
          session.workspaceId !== LEGACY_UPLOAD_WORKSPACE_ID ||
          (session.status !== "completed" && session.status !== "aborted")
        )) {
          throw new ConflictException({
            code: "USER_RECOVERY_REQUIRED",
            message: "User has uploads requiring operator inspection",
          });
        }

        // Resolve every physical destination before deleting its metadata.
        // The journal is committed atomically with the account tombstone.
        const payload: UserDeletionCleanupPayload = {
          files: files.flatMap((file) => file.storagePath
            ? [{ path: this.storage.resolveFilePath(file, true) }]
            : []),
          uploads: sessions.map((session) => ({
            workspaceId: session.workspaceId,
            uploadId: session.uploadId,
            tempPath: session.tempPath,
          })),
        };

        await manager.insert(UserDeletionEntity, {
          userId: id,
          payload,
        });
        await revokeLockedUserSessions(manager, target);
        await revokeAlternativeUserAccess(manager, id);

        // Terminal copy receipts have no live reservation or filesystem claim.
        await manager.query(
          `DELETE FROM "file_copy_operations"
           WHERE "userId" = $1 AND state IN ('committed', 'released')`,
          [id],
        );

        const deleted = await manager.delete(UserEntity, id);
        if (deleted.affected !== 1) {
          throw new Error("Administrative user deletion failed");
        }

        return payload;
      },
    );

    return this.finishCleanup(id, payload);
  }

  private async resumeCleanup(): Promise<void> {
    try {
      const retained = await this.database.getRepository(
        UserDeletionEntity,
      ).find({ order: { userId: "ASC" } });

      for (const operation of retained) {
        await this.finishCleanup(operation.userId, operation.payload);
      }
    } catch {
      this.logger.error("Failed to resume retained user cleanup operations");
    }
  }

  private async finishCleanup(
    userId: number,
    rawPayload: UserDeletionCleanupPayload,
  ): Promise<AdminUserDeletionResult> {
    let cleanupPending = false;
    let payload: UserDeletionCleanupPayload;

    try {
      payload = validateCleanupPayload(rawPayload);
    } catch {
      this.logger.error(`Invalid retained cleanup payload for removed user ${userId}`);
      return { deleted: true, cleanupPending: true };
    }

    // Filesystem effects follow the committed account deletion and durable
    // journal. A crash leaves the journal available to retry or startup resume.
    for (const file of payload.files) {
      try {
        await this.storage.deleteFile(file.path);
      } catch {
        cleanupPending = true;
        this.logger.error(`Failed to delete physical file for removed user ${userId}`);
      }
    }

    for (const session of payload.uploads) {
      try {
        await this.cleanupLegacyUpload(session);
      } catch {
        cleanupPending = true;
        this.logger.error(`Failed to clean upload workspace for removed user ${userId}`);
      }
    }

    if (!cleanupPending) {
      try {
        await this.database.manager.delete(UserDeletionEntity, { userId });
      } catch {
        cleanupPending = true;
        this.logger.error(`Failed to close cleanup journal for removed user ${userId}`);
      }
    }

    return { deleted: true, cleanupPending };
  }

  private async cleanupLegacyUpload(
    session: UserDeletionCleanupPayload["uploads"][number],
  ): Promise<void> {
    const workspace = await this.database.getRepository(
      UploadWorkspaceEntity,
    ).findOne({ where: { id: session.workspaceId } });

    const tempPath = this.workspaceResolver.resolve(session, workspace);

    if (tempPath === this.workspaceResolver.root(LEGACY_UPLOAD_WORKSPACE)) {
      throw new Error("Temporary root deletion refused");
    }

    this.workspaceResolver.filesystem().remove(tempPath, true);
  }
}

function validateCleanupPayload(
  value: UserDeletionCleanupPayload,
): UserDeletionCleanupPayload {
  if (!value || typeof value !== "object" ||
      !Array.isArray(value.files) || !Array.isArray(value.uploads) ||
      value.files.some((file) => !file || typeof file.path !== "string") ||
      value.uploads.some((session) => !session ||
        typeof session.workspaceId !== "string" ||
        typeof session.uploadId !== "string" ||
        typeof session.tempPath !== "string")) {
    throw new Error("Invalid user cleanup payload");
  }

  return value;
}
