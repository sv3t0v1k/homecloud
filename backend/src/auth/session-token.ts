import { createHash } from "node:crypto";

const MAX_SESSION_VERSION = 9223372036854775807n;

export type SessionTokenUse = "access" | "refresh";

export interface SessionIdentity {
  sub: number;
  email: string;
  sv: string;
}

export interface AccessSessionClaims extends SessionIdentity {
  tokenUse: "access";
  exp: number;
}

export interface RefreshSessionClaims extends SessionIdentity {
  tokenUse: "refresh";
  jti: string;
  exp: number;
}

const REFRESH_JTI_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isSessionVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9][0-9]{0,18}$/.test(value) &&
    BigInt(value) <= MAX_SESSION_VERSION
  );
}

export function sessionVersionMatches(
  tokenVersion: unknown,
  storedVersion: unknown,
): boolean {
  return (
    isSessionVersion(tokenVersion) &&
    isSessionVersion(storedVersion) &&
    tokenVersion === storedVersion
  );
}

export function nextSessionVersion(version: unknown): string {
  if (!isSessionVersion(version)) {
    throw new Error("Invalid stored session version");
  }

  const next = BigInt(version) + 1n;

  if (next > MAX_SESSION_VERSION) {
    throw new Error("Session version exhausted");
  }

  return next.toString();
}

type ClaimRecord = Record<string, unknown>;

function claimRecord(value: unknown): ClaimRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as ClaimRecord;
}

function sessionIdentity(
  claims: ClaimRecord,
): SessionIdentity | null {
  if (
    typeof claims.sub !== "number" ||
    !Number.isSafeInteger(claims.sub) ||
    claims.sub <= 0 ||
    typeof claims.email !== "string" ||
    claims.email.length === 0 ||
    !isSessionVersion(claims.sv)
  ) {
    return null;
  }

  return {
    sub: claims.sub,
    email: claims.email,
    sv: claims.sv,
  };
}

function expiration(claims: ClaimRecord): number | null {
  if (
    typeof claims.exp !== "number" ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp <= 0
  ) {
    return null;
  }

  return claims.exp;
}

/**
 * Parse claims only AFTER successful cryptographic JWT verification.
 * Signature, expiry and JWT algorithm validation remain the responsibility
 * of the JWT verifier.
 */
export function parseAccessSessionClaims(
  value: unknown,
): AccessSessionClaims | null {
  const claims = claimRecord(value);

  if (!claims || claims.tokenUse !== "access") {
    return null;
  }

  const identity = sessionIdentity(claims);
  const exp = expiration(claims);

  if (!identity || exp === null) {
    return null;
  }

  return {
    ...identity,
    tokenUse: "access",
    exp,
  };
}

/**
 * Parse claims only AFTER successful refresh-secret JWT verification.
 */
export function parseRefreshSessionClaims(
  value: unknown,
): RefreshSessionClaims | null {
  const claims = claimRecord(value);

  if (
    !claims ||
    claims.tokenUse !== "refresh" ||
    typeof claims.jti !== "string" ||
    !REFRESH_JTI_PATTERN.test(claims.jti)
  ) {
    return null;
  }

  const identity = sessionIdentity(claims);
  const exp = expiration(claims);

  if (!identity || exp === null) {
    return null;
  }

  return {
    ...identity,
    tokenUse: "refresh",
    jti: claims.jti,
    exp,
  };
}

/**
 * Refresh JWTs contain high-entropy signed credentials.
 * Hash the entire token, rather than bcrypt's 72-byte input prefix.
 * The prefix distinguishes this format from historical bcrypt hashes.
 * Never use this function for user passwords.
 */
export function refreshTokenDigest(token: string): string {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Invalid refresh token");
  }

  return "sha256:" + createHash("sha256").update(token, "utf8").digest("hex");
}
