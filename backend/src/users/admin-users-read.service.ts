import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";

import { UserEntity, UserRole } from "../entities/user.entity";
import {
  isSessionVersion,
  sessionVersionMatches,
} from "../auth/session-token";
import {
  ADMIN_MAX_QUOTA_BYTES,
  AdminUserDto,
  AdminUserPageDto,
  parseAdminListUsers,
  parseAdminUserId,
} from "./dtos/admin-user.dto";

// This identity must come from the existing verified JWT boundary.
// A client-supplied role is never consulted.
export interface AdminActor {
  userId: number;
  sessionVersion: string;
}

type AuthorizationUser = Pick<
  UserEntity,
  "id" | "role" | "isActive" | "sessionVersion"
>;

function unauthorized(): never {
  throw new UnauthorizedException({
    code: "UNAUTHORIZED",
    message: "Unauthorized",
  });
}

function invalidAccounting(): never {
  throw new ServiceUnavailableException({
    code: "STORAGE_ACCOUNTING_UNAVAILABLE",
    message: "Storage accounting unavailable",
  });
}

function validateActorIdentity(actor: AdminActor): void {
  if (
    !actor ||
    !Number.isSafeInteger(actor.userId) ||
    actor.userId < 1 ||
    actor.userId > 2_147_483_647 ||
    !isSessionVersion(actor.sessionVersion)
  ) {
    unauthorized();
  }
}

// Shared authorization predicate for later administrative mutations.
// The caller must obtain the authoritative row under the appropriate
// transaction lock before invoking this function.
export function assertAdminActor(
  actor: AdminActor,
  user: AuthorizationUser | null,
): void {
  validateActorIdentity(actor);

  if (
    !user ||
    user.id !== actor.userId ||
    user.isActive !== true ||
    !sessionVersionMatches(actor.sessionVersion, user.sessionVersion)
  ) {
    unauthorized();
  }

  if (user.role !== UserRole.ADMIN) {
    throw new ForbiddenException({
      code: "ADMIN_REQUIRED",
      message: "Administrator access required",
    });
  }
}

async function authorizeRead(
  manager: EntityManager,
  actor: AdminActor,
): Promise<void> {
  validateActorIdentity(actor);

  // PostgreSQL FOR SHARE conflicts with account mutation locks.
  // Hold authorization until the administrative read finishes.
  // No password hash or refresh token is selected.
  const user = await manager.findOne(UserEntity, {
    select: {
      id: true,
      role: true,
      isActive: true,
      sessionVersion: true,
    },
    where: { id: actor.userId },
    lock: { mode: "pessimistic_read" },
  });

  assertAdminActor(actor, user);
}

type UserReadRow = {
  id: number | null;
  name: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  storageQuota: string;
  storageUsed: string;
  fileCount: string;
  folderCount: string;
  createdAt: Date;
};

type PageReadRow = UserReadRow & { total: string };

function safeDecimal(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > ADMIN_MAX_QUOTA_BYTES.length ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > BigInt(ADMIN_MAX_QUOTA_BYTES)
  ) {
    return invalidAccounting();
  }

  return value;
}

function safeCount(value: unknown): number {
  return Number(safeDecimal(value));
}

// Explicit response allowlist. Never spread an ORM entity or raw row.
export function presentAdminUser(row: UserReadRow): AdminUserDto {
  if (
    typeof row.id !== "number" ||
    !Number.isSafeInteger(row.id) ||
    row.id < 1 ||
    row.id > 2_147_483_647 ||
    typeof row.name !== "string" ||
    typeof row.email !== "string" ||
    (row.role !== UserRole.ADMIN && row.role !== UserRole.USER) ||
    typeof row.isActive !== "boolean" ||
    !(row.createdAt instanceof Date) ||
    !Number.isFinite(row.createdAt.getTime())
  ) {
    return invalidAccounting();
  }

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    isActive: row.isActive,
    storageQuota: safeDecimal(row.storageQuota),
    storageUsed: safeDecimal(row.storageUsed),
    fileCount: safeCount(row.fileCount),
    folderCount: safeCount(row.folderCount),
    createdAt: row.createdAt.toISOString(),
  };
}

// Static SQL fragments only. No request-controlled SQL identifiers,
// expressions, sort direction, or string interpolation.
const USER_COLUMNS = `
  u.id,
  u.name,
  u.email,
  u.role,
  u."isActive",
  u."storageQuota"::text AS "storageQuota",
  u."storageUsed"::text AS "storageUsed",
  u."createdAt",
  stats."fileCount",
  stats."folderCount"
`;

const FILE_COUNTS = `
  SELECT
    (count(*) FILTER (WHERE f."isFolder" = false))::text
      AS "fileCount",
    (count(*) FILTER (WHERE f."isFolder" = true))::text
      AS "folderCount"
  FROM "files" f
  WHERE f."userId" = u.id
    AND f."isDeleted" = false
`;

const LIST_SQL = `
  WITH matching AS MATERIALIZED (
    SELECT id, "createdAt"
    FROM "users"
    WHERE $1::text = ''
       OR strpos(lower(name), lower($1::text)) > 0
       OR strpos(lower(email), lower($1::text)) > 0
  ),
  selected_page AS (
    SELECT id, "createdAt"
    FROM matching
    ORDER BY "createdAt" DESC, id DESC
    LIMIT $2::integer
    OFFSET $3::integer
  )
  SELECT
    totals.total,
    ${USER_COLUMNS}
  FROM (
    SELECT count(*)::text AS total FROM matching
  ) totals
  LEFT JOIN selected_page p ON true
  LEFT JOIN "users" u ON u.id = p.id
  LEFT JOIN LATERAL (
    ${FILE_COUNTS}
  ) stats ON u.id IS NOT NULL
  ORDER BY u."createdAt" DESC NULLS LAST, u.id DESC NULLS LAST
`;

const DETAIL_SQL = `
  SELECT ${USER_COLUMNS}
  FROM "users" u
  CROSS JOIN LATERAL (
    ${FILE_COUNTS}
  ) stats
  WHERE u.id = $1::integer
`;

@Injectable()
export class AdminUsersReadService {
  constructor(private readonly database: DataSource) {}

  async list(
    actor: AdminActor,
    rawQuery: unknown,
  ): Promise<AdminUserPageDto> {
    return this.database.transaction(
      "READ COMMITTED",
      async (manager) => {
        await authorizeRead(manager, actor);

        const query = parseAdminListUsers(rawQuery);
        const offset = (query.page - 1) * query.pageSize;

        // Count, page and file statistics share one PostgreSQL
        // statement snapshot, including the empty-page case.
        const rows = await manager.query(LIST_SQL, [
          query.search,
          query.pageSize,
          offset,
        ]) as PageReadRow[];

        if (rows.length === 0) {
          return invalidAccounting();
        }

        const total = safeCount(rows[0].total);

        const items = rows
          .filter((row) => row.id !== null)
          .map(presentAdminUser);

        return {
          items,
          page: query.page,
          pageSize: query.pageSize,
          total,
        };
      },
    );
  }

  async get(
    actor: AdminActor,
    rawId: unknown,
  ): Promise<AdminUserDto> {
    return this.database.transaction(
      "READ COMMITTED",
      async (manager) => {
        await authorizeRead(manager, actor);

        const id = parseAdminUserId(rawId);

        const rows = await manager.query(
          DETAIL_SQL,
          [id],
        ) as UserReadRow[];

        if (rows.length === 0) {
          throw new NotFoundException({
            code: "USER_NOT_FOUND",
            message: "User not found",
          });
        }

        if (rows.length !== 1 || rows[0].id !== id) {
          return invalidAccounting();
        }

        return presentAdminUser(rows[0]);
      },
    );
  }
}
