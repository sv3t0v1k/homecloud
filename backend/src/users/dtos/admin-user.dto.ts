import { BadRequestException } from "@nestjs/common";
import { isEmail } from "class-validator";
import { UserRole } from "../../entities/user.entity";

// API sizes are canonical decimal strings, never JSON numbers.
// The existing storage accounting uses the JS safe integer range.
export const ADMIN_MAX_QUOTA_BYTES = "9007199254740991";

export const ADMIN_DEFAULT_PAGE = 1;
export const ADMIN_DEFAULT_PAGE_SIZE = 25;
export const ADMIN_MAX_PAGE_SIZE = 100;
export const ADMIN_MAX_OFFSET = 100_000;

export interface AdminUserDto {
  id: number;
  name: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  storageQuota: string;
  storageUsed: string;
  fileCount: number;
  folderCount: number;
  createdAt: string;
}

export interface AdminUserPageDto {
  items: AdminUserDto[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AdminListUsersDto {
  page: number;
  pageSize: number;
  search: string;
}

export interface AdminCreateUserDto {
  name: string;
  email: string;
  password: string;
  role: UserRole;
  storageQuota: string;
}

export interface AdminUpdateUserDto {
  name?: string;
  email?: string;
  role?: UserRole;
  storageQuota?: string;
}

export interface AdminChangePasswordDto {
  newPassword: string;
}

export interface AdminChangePasswordResultDto {
  passwordChanged: true;
  sessionsRevoked: true;
}

export interface AdminChangeStatusDto {
  isActive: boolean;
}

// These parsers are the strict runtime boundary for the DTOs.
// A later controller must parse the raw HTTP body/query before
// calling the service. Never pass request bodies to repository.save.

type Input = Record<string, unknown>;

function invalid(
  code: "VALIDATION_ERROR" | "INVALID_QUOTA" = "VALIDATION_ERROR",
): never {
  // Do not reflect untrusted field names, credentials or values.
  throw new BadRequestException({
    code,
    message:
      code === "INVALID_QUOTA"
        ? "Invalid storage quota"
        : "Invalid administrator request",
  });
}

function fields(
  value: unknown,
  allowed: readonly string[],
): Input {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return invalid();
  }

  const prototype = Object.getPrototypeOf(value);

  if (prototype !== Object.prototype && prototype !== null) {
    return invalid();
  }

  // Validate raw own properties, including non-enumerable and
  // symbol keys. Never invoke input getters or accept inherited fields.
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      return invalid();
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (
      !descriptor ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      return invalid();
    }
  }

  // Return a null-prototype snapshot of validated own data fields.
  const result: Input = Object.create(null);

  for (const key of Object.keys(value)) {
    result[key] = Object.getOwnPropertyDescriptor(value, key)!.value;
  }

  return result;
}

function has(input: Input, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function nameValue(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.includes(String.fromCharCode(0))
  ) {
    return invalid();
  }

  const normalized = value.trim();

  if (
    normalized.length === 0 ||
    Array.from(normalized).length > 100
  ) {
    return invalid();
  }

  return normalized;
}

function emailValue(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    value.includes(String.fromCharCode(0))
  ) {
    return invalid();
  }

  const trimmed = value.trim();

  if (
    trimmed.length === 0 ||
    Array.from(trimmed).length > 255 ||
    !isEmail(trimmed)
  ) {
    return invalid();
  }

  // PostgreSQL remains authoritative for canonical lowercasing
  // and uniqueness. The service must normalize again inside its
  // transaction using normalizeUserEmail.
  return trimmed;
}

function passwordValue(value: unknown): string {
  // Same creation policy as the protected operator bootstrap.
  // Never trim, case-fold or truncate passwords.
  if (
    typeof value !== "string" ||
    Array.from(value).length < 12 ||
    Buffer.byteLength(value, "utf8") > 72 ||
    value.includes(String.fromCharCode(0))
  ) {
    return invalid();
  }

  return value;
}

function roleValue(value: unknown): UserRole {
  if (value !== UserRole.USER && value !== UserRole.ADMIN) {
    return invalid();
  }

  return value;
}

export function parseAdminQuota(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > ADMIN_MAX_QUOTA_BYTES.length ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > BigInt(ADMIN_MAX_QUOTA_BYTES)
  ) {
    return invalid("INVALID_QUOTA");
  }

  return value;
}

function positiveInteger(
  value: unknown,
  max: number,
): number {
  // HTTP path/query values must be canonical strings.
  if (
    typeof value !== "string" ||
    value.length > 10 ||
    !/^[1-9][0-9]*$/.test(value)
  ) {
    return invalid();
  }

  const number = Number(value);

  if (!Number.isSafeInteger(number) || number > max) {
    return invalid();
  }

  return number;
}

export function parseAdminUserId(value: unknown): number {
  return positiveInteger(value, 2_147_483_647);
}

export function parseAdminListUsers(
  value: unknown,
): AdminListUsersDto {
  const input = fields(value, ["page", "pageSize", "search"]);

  const page = has(input, "page")
    ? positiveInteger(input.page, 2_147_483_647)
    : ADMIN_DEFAULT_PAGE;

  const pageSize = has(input, "pageSize")
    ? positiveInteger(input.pageSize, ADMIN_MAX_PAGE_SIZE)
    : ADMIN_DEFAULT_PAGE_SIZE;

  if ((page - 1) * pageSize > ADMIN_MAX_OFFSET) {
    return invalid();
  }

  let search = "";

  if (has(input, "search")) {
    if (
      typeof input.search !== "string" ||
      input.search.includes(String.fromCharCode(0)) ||
      Array.from(input.search.trim()).length > 100
    ) {
      return invalid();
    }

    search = input.search.trim();
  }

  return { page, pageSize, search };
}

export function parseAdminCreateUser(
  value: unknown,
): AdminCreateUserDto {
  const input = fields(
    value,
    ["name", "email", "password", "role", "storageQuota"],
  );

  return {
    name: nameValue(input.name),
    email: emailValue(input.email),
    password: passwordValue(input.password),
    role: roleValue(input.role),
    storageQuota: parseAdminQuota(input.storageQuota),
  };
}

export function parseAdminUpdateUser(
  value: unknown,
): AdminUpdateUserDto {
  const input = fields(
    value,
    ["name", "email", "role", "storageQuota"],
  );

  if (Object.keys(input).length === 0) {
    return invalid();
  }

  const result: AdminUpdateUserDto = {};

  if (has(input, "name")) result.name = nameValue(input.name);
  if (has(input, "email")) result.email = emailValue(input.email);
  if (has(input, "role")) result.role = roleValue(input.role);

  if (has(input, "storageQuota")) {
    result.storageQuota = parseAdminQuota(input.storageQuota);
  }

  return result;
}

export function parseAdminChangePassword(
  value: unknown,
): AdminChangePasswordDto {
  const input = fields(value, ["newPassword"]);

  return {
    newPassword: passwordValue(input.newPassword),
  };
}

export function parseAdminChangeStatus(
  value: unknown,
): AdminChangeStatusDto {
  const input = fields(value, ["isActive"]);

  if (typeof input.isActive !== "boolean") {
    return invalid();
  }

  return { isActive: input.isActive };
}
