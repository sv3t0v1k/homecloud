import { createHash, randomUUID } from "node:crypto";
import {
  isSessionVersion,
  sessionVersionMatches,
  nextSessionVersion,
  parseAccessSessionClaims,
  parseRefreshSessionClaims,
  refreshTokenDigest,
} from "./session-token";

const identity = {
  sub: 1,
  email: "user@example.test",
  sv: "1",
};

const exp = 2000000000;

const access = {
  ...identity,
  tokenUse: "access",
  exp,
};

const refresh = {
  ...identity,
  tokenUse: "refresh",
  jti: randomUUID(),
  exp,
};

describe("Session token contract", () => {
  describe("PostgreSQL bigint session version", () => {
    it.each([
      "1",
      "2",
      "9007199254740993",
      "9223372036854775807",
    ])("accepts canonical version %s", (version) => {
      expect(isSessionVersion(version)).toBe(true);
    });

    it.each([
      undefined,
      null,
      1,
      0,
      true,
      "",
      "0",
      "00",
      "01",
      "-1",
      "+1",
      "1.0",
      "1e3",
      " 1",
      "1 ",
      "1\\n",
      "9223372036854775808",
      "99999999999999999999999999",
    ])("rejects noncanonical version %p", (version) => {
      expect(isSessionVersion(version)).toBe(false);
    });

    it("compares exact decimal strings without Number conversion", () => {
      expect(
        sessionVersionMatches("9007199254740992", "9007199254740993"),
      ).toBe(false);

      expect(
        sessionVersionMatches("9007199254740993", "9007199254740993"),
      ).toBe(true);

      expect(sessionVersionMatches("1", 1)).toBe(false);
      expect(sessionVersionMatches("1", "2")).toBe(false);
      expect(sessionVersionMatches(undefined, "1")).toBe(false);
      expect(sessionVersionMatches("1", undefined)).toBe(false);
    });

    it("increments without losing bigint precision", () => {
      expect(nextSessionVersion("1")).toBe("2");

      expect(nextSessionVersion("9007199254740992"))
        .toBe("9007199254740993");

      expect(nextSessionVersion("9223372036854775806"))
        .toBe("9223372036854775807");
    });

    it("fails closed when stored version is invalid or exhausted", () => {
      expect(() => nextSessionVersion("0")).toThrow(
        "Invalid stored session version",
      );

      expect(() => nextSessionVersion("9223372036854775807")).toThrow(
        "Session version exhausted",
      );
    });
  });

  describe("Access claims", () => {
    it("accepts the versioned access contract", () => {
      expect(parseAccessSessionClaims(access)).toEqual(access);
    });

    it("returns only explicitly permitted claims", () => {
      expect(parseAccessSessionClaims({
        ...access,
        role: "ADMIN",
        password: "secret",
        sessionVersion: "999",
      })).toEqual(access);
    });

    it.each([
      undefined,
      null,
      "token",
      [],
      {},
      { sub: 1, email: "legacy@example.test", exp },
      { ...access, sv: undefined },
      { ...access, sv: 1 },
      { ...access, sv: "01" },
      { ...access, sub: "1" },
      { ...access, sub: 0 },
      { ...access, sub: -1 },
      { ...access, sub: 1.5 },
      { ...access, sub: Number.MAX_SAFE_INTEGER + 1 },
      { ...access, email: "" },
      { ...access, email: undefined },
      { ...access, exp: undefined },
      { ...access, exp: "2000000000" },
      { ...access, exp: 0 },
      { ...access, exp: -1 },
      { ...access, exp: 1.5 },
      { ...access, exp: Infinity },
      { ...access, tokenUse: undefined },
      { ...access, tokenUse: "refresh" },
    ])("rejects invalid access claims %p", (value) => {
      expect(parseAccessSessionClaims(value)).toBeNull();
    });
  });

  describe("Refresh claims", () => {
    it("accepts the versioned refresh contract", () => {
      expect(parseRefreshSessionClaims(refresh)).toEqual(refresh);
    });

    it("does not permit an access token to act as a refresh token", () => {
      expect(parseRefreshSessionClaims(access)).toBeNull();
      expect(parseAccessSessionClaims(refresh)).toBeNull();
    });

    it.each([
      undefined,
      null,
      {},
      { ...refresh, sv: undefined },
      { ...refresh, sv: "0" },
      { ...refresh, sv: 1 },
      { ...refresh, tokenUse: undefined },
      { ...refresh, tokenUse: "access" },
      { ...refresh, jti: undefined },
      { ...refresh, jti: "" },
      { ...refresh, jti: "not-a-uuid" },
      { ...refresh, jti: "00000000-0000-0000-0000-000000000000" },
      { ...refresh, sub: -1 },
      { ...refresh, email: undefined },
      { ...refresh, exp: undefined },
    ])("rejects invalid refresh claims %p", (value) => {
      expect(parseRefreshSessionClaims(value)).toBeNull();
    });
  });

  describe("Refresh token digest", () => {
    it("hashes the complete token using an explicit format prefix", () => {
      const token = "header.payload.signature";

      expect(refreshTokenDigest(token)).toBe(
        "sha256:" + createHash("sha256").update(token).digest("hex"),
      );

      expect(refreshTokenDigest(token)).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(refreshTokenDigest(token)).not.toContain(token);
    });

    it("distinguishes credentials that differ beyond bcrypt's prefix", () => {
      const commonPrefix = "a".repeat(150);

      expect(refreshTokenDigest(commonPrefix + "X"))
        .not.toBe(refreshTokenDigest(commonPrefix + "Y"));
    });

    it("is deterministic for exact token bytes", () => {
      expect(refreshTokenDigest("abc.def.ghi"))
        .toBe(refreshTokenDigest("abc.def.ghi"));
    });

    it("rejects empty credentials", () => {
      expect(() => refreshTokenDigest("")).toThrow(
        "Invalid refresh token",
      );
    });
  });
});
