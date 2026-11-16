import { BadRequestException } from "@nestjs/common";
import { EntityManager, QueryFailedError } from "typeorm";

// Keep the SQL canonicalization identical to the migration.
// The input expression is internal SQL, never user-controlled text.
const EMAIL_TRIM_CHARACTERS = "chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760) || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279)";

export function canonicalEmailSql(expression: string): string {
  return `lower(btrim(${expression}, ${EMAIL_TRIM_CHARACTERS}) COLLATE "default")`;
}

export const CANONICAL_EMAIL_CHECK =
  `char_length("email") > 0 AND ` +
  `("email" COLLATE "C") = (${canonicalEmailSql('"email"')} COLLATE "C")`;

/**
 * PostgreSQL is authoritative for normalization.
 * No JavaScript Unicode case-folding discrepancy with the DB.
 */
export async function normalizeUserEmail(
  manager: EntityManager,
  email: string,
): Promise<string> {
  if (typeof email !== "string" || email.includes(String.fromCharCode(0))) {
    throw new BadRequestException("Invalid email");
  }

  const rows = await manager.query(
    `SELECT ${canonicalEmailSql("$1::text")} AS email`,
    [email],
  ) as { email: string }[];

  const normalized = rows[0]?.email;

  if (
    typeof normalized !== "string" ||
    normalized.length === 0 ||
    Array.from(normalized).length > 255
  ) {
    throw new BadRequestException("Invalid email");
  }

  return normalized;
}

/**
 * Only an actual users.email unique-constraint violation
 * is translated into an email-conflict response.
 */
export function isUserEmailConflict(
  error: unknown,
  manager: EntityManager,
): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }

  const driver = error.driverError as {
    code?: string;
    constraint?: string;
  };

  if (driver.code !== "23505" || !driver.constraint) {
    return false;
  }

  // Original production users migration uses this constraint.
  if (driver.constraint === "users_email_key") {
    return true;
  }

  // TypeORM-generated schemas can use a generated unique name.
  const metadata = manager.connection.getMetadata("users");

  return metadata.uniques.some(
    (unique) =>
      unique.name === driver.constraint &&
      unique.columns.length === 1 &&
      unique.columns[0].databaseName === "email",
  );
}
