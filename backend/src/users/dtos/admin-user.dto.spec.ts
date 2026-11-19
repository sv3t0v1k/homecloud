import { BadRequestException } from "@nestjs/common";
import { UserRole } from "../../entities/user.entity";
import {
  ADMIN_MAX_OFFSET,
  ADMIN_MAX_QUOTA_BYTES,
  parseAdminChangePassword,
  parseAdminChangeStatus,
  parseAdminCreateUser,
  parseAdminListUsers,
  parseAdminQuota,
  parseAdminUpdateUser,
  parseAdminUserId,
} from "./admin-user.dto";

const valid = {
  name: "Test user",
  email: "User@Example.TEST",
  password: "test-password-123",
  role: UserRole.USER,
  storageQuota: "1073741824",
};

describe("Admin user runtime DTO contract", () => {
  describe("create", () => {
    it("returns only explicitly allowed fields", () => {
      const input = Object.freeze({
        ...valid,
        name: "  Test user  ",
        email: "  User@Example.TEST  ",
      });

      expect(parseAdminCreateUser(input)).toEqual(valid);
      expect(input.name).toBe("  Test user  ");
    });

    it("accepts explicit ADMIN and zero quota", () => {
      expect(parseAdminCreateUser({
        ...valid,
        role: UserRole.ADMIN,
        storageQuota: "0",
      })).toEqual({
        ...valid,
        role: UserRole.ADMIN,
        storageQuota: "0",
      });
    });

    it.each(Object.keys(valid))(
      "rejects missing required field %s",
      (key) => {
        const input: Record<string, unknown> = { ...valid };
        delete input[key];

        expect(() => parseAdminCreateUser(input))
          .toThrow(BadRequestException);
      },
    );

    it.each([
      "id",
      "isActive",
      "isEmailVerified",
      "sessionVersion",
      "storageUsed",
      "createdAt",
      "updatedAt",
      "avatar",
      "files",
      "refreshTokens",
      "passwordHash",
      "accessToken",
      "refreshToken",
    ])("rejects forbidden field %s", (key) => {
      expect(() => parseAdminCreateUser({
        ...valid,
        [key]: "untrusted",
      })).toThrow(BadRequestException);
    });

    it.each([
      "",
      "   ",
      "a".repeat(101),
      "name" + String.fromCharCode(0),
      null,
      123,
      false,
    ])("rejects invalid name %p", (name) => {
      expect(() => parseAdminCreateUser({ ...valid, name }))
        .toThrow(BadRequestException);
    });

    it.each([
      "",
      "not-an-email",
      "a".repeat(256) + "@example.test",
      "a" + String.fromCharCode(0) + "@example.test",
      null,
      123,
      false,
    ])("rejects invalid email %p", (email) => {
      expect(() => parseAdminCreateUser({ ...valid, email }))
        .toThrow(BadRequestException);
    });

    it.each([
      "admin",
      "owner",
      "SUPERADMIN",
      "",
      null,
      1,
      false,
    ])("rejects invalid role %p", (role) => {
      expect(() => parseAdminCreateUser({ ...valid, role }))
        .toThrow(BadRequestException);
    });
  });

  describe("quota", () => {
    it.each([
      "0",
      "1",
      "1073741824",
      ADMIN_MAX_QUOTA_BYTES,
    ])("accepts canonical quota %s", (quota) => {
      expect(parseAdminQuota(quota)).toBe(quota);
    });

    const invalidQuotas: unknown[] = [
      0, 1, 1073741824, -1,
      null, undefined, true, {},
      "", " ", "00", "01", "-0", "-1",
      "+1", "1.0", "1e9", "0x10",
      " 1", "1 ", "1\n", "1\r",
      "9007199254740992",
      "9223372036854775807",
      "9".repeat(1000),
    ];

    it.each(invalidQuotas.map((value) => [value]))(
      "rejects invalid quota %p",
      (quota) => {
        expect(() => parseAdminQuota(quota))
          .toThrow(BadRequestException);
      },
    );

    it("uses stable error code without reflecting input", () => {
      let caught: unknown;

      try {
        parseAdminQuota("private-invalid-quota-marker");
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(BadRequestException);

      expect((caught as BadRequestException).getResponse())
        .toEqual({
          code: "INVALID_QUOTA",
          message: "Invalid storage quota",
        });
    });
  });

  describe("PATCH", () => {
    it("accepts each permitted field independently", () => {
      expect(parseAdminUpdateUser({ name: " New name " }))
        .toEqual({ name: "New name" });

      expect(parseAdminUpdateUser({ email: valid.email }))
        .toEqual({ email: valid.email });

      expect(parseAdminUpdateUser({ role: UserRole.ADMIN }))
        .toEqual({ role: UserRole.ADMIN });

      expect(parseAdminUpdateUser({ storageQuota: "0" }))
        .toEqual({ storageQuota: "0" });
    });

    it.each([
      {},
      { name: null },
      { email: undefined },
      { role: null },
      { storageQuota: null },
      { password: "test-password-123" },
      { newPassword: "test-password-123" },
      { isActive: false },
      { sessionVersion: "9" },
      { storageUsed: "1" },
      { id: 123 },
      { name: "Valid", extra: "not permitted" },
    ])("rejects invalid patch %p", (patch) => {
      expect(() => parseAdminUpdateUser(patch))
        .toThrow(BadRequestException);
    });
  });

  describe("password changes", () => {
    it("preserves password bytes and whitespace", () => {
      const password = "  test-password  ";

      expect(parseAdminChangePassword({
        newPassword: password,
      })).toEqual({ newPassword: password });
    });

    it("enforces bcrypt's byte boundary, not string truncation", () => {
      const exactly72 = "я".repeat(36);

      expect(parseAdminChangePassword({
        newPassword: exactly72,
      })).toEqual({ newPassword: exactly72 });

      expect(() => parseAdminChangePassword({
        newPassword: "я".repeat(37),
      })).toThrow(BadRequestException);
    });

    it.each([
      "",
      "a".repeat(11),
      "a".repeat(73),
      "password123" + String.fromCharCode(0),
      null,
      undefined,
      123456789012,
    ])("rejects invalid password %p", (password) => {
      expect(() => parseAdminChangePassword({
        newPassword: password,
      })).toThrow(BadRequestException);

      expect(() => parseAdminCreateUser({ ...valid, password }))
        .toThrow(BadRequestException);
    });

    it("rejects additional fields in password request", () => {
      expect(() => parseAdminChangePassword({
        newPassword: valid.password,
        sessionVersion: "1",
      })).toThrow(BadRequestException);
    });
  });

  describe("status", () => {
    it.each([true, false])(
      "accepts explicit boolean %s",
      (isActive) => {
        expect(parseAdminChangeStatus({ isActive }))
          .toEqual({ isActive });
      },
    );

    it.each([
      {},
      { isActive: "true" },
      { isActive: "false" },
      { isActive: 0 },
      { isActive: 1 },
      { isActive: null },
      { isActive: false, role: UserRole.ADMIN },
    ])("rejects invalid status %p", (value) => {
      expect(() => parseAdminChangeStatus(value))
        .toThrow(BadRequestException);
    });
  });

  describe("pagination and identifiers", () => {
    it("uses bounded default pagination", () => {
      expect(parseAdminListUsers({})).toEqual({
        page: 1,
        pageSize: 25,
        search: "",
      });
    });

    it("parses canonical query strings without implicit coercion", () => {
      expect(parseAdminListUsers({
        page: "2",
        pageSize: "100",
        search: "  Example.TEST  ",
      })).toEqual({
        page: 2,
        pageSize: 100,
        search: "Example.TEST",
      });
    });

    it("accepts offset boundary and rejects larger offsets", () => {
      expect(parseAdminListUsers({
        page: String(ADMIN_MAX_OFFSET + 1),
        pageSize: "1",
      }).page).toBe(ADMIN_MAX_OFFSET + 1);

      expect(() => parseAdminListUsers({
        page: String(ADMIN_MAX_OFFSET + 2),
        pageSize: "1",
      })).toThrow(BadRequestException);
    });

    it.each([
      { page: "0" },
      { page: "01" },
      { page: "-1" },
      { page: "1.5" },
      { page: "1e2" },
      { page: "1\n" },
      { page: 1 },
      { page: ["1", "2"] },
      { page: null },
      { pageSize: "0" },
      { pageSize: "101" },
      { pageSize: ["25"] },
      { pageSize: "2147483648" },
      { search: "x".repeat(101) },
      { search: ["name"] },
      { search: 1 },
      { search: "a" + String.fromCharCode(0) },
      { sort: "password" },
      { includePassword: "true" },
    ])("rejects invalid list query %p", (query) => {
      expect(() => parseAdminListUsers(query))
        .toThrow(BadRequestException);
    });

    it.each(["1", "2147483647"])(
      "accepts PostgreSQL integer identifier %s",
      (id) => {
        expect(parseAdminUserId(id)).toBe(Number(id));
      },
    );

    it.each([
      "", "0", "-1", "01", "+1", "1.5", "1e3",
      "1\n", "2147483648", "999999999999999999999",
      1, null, undefined, ["1"],
    ])("rejects invalid identifier %p", (id) => {
      expect(() => parseAdminUserId(id))
        .toThrow(BadRequestException);
    });
  });

  describe("raw object safety", () => {
    it.each([null, undefined, [], "body", 1, false])(
      "rejects non-object request %p",
      (body) => {
        expect(() => parseAdminCreateUser(body))
          .toThrow(BadRequestException);
      },
    );

    it("accepts a valid null-prototype query object", () => {
      const query = Object.assign(Object.create(null), {
        page: "1",
        pageSize: "25",
      });

      expect(parseAdminListUsers(query)).toEqual({
        page: 1,
        pageSize: 25,
        search: "",
      });
    });

    it("rejects inherited fields", () => {
      const input = Object.create(valid);

      expect(() => parseAdminCreateUser(input))
        .toThrow(BadRequestException);
    });

    it("rejects prototype pollution keys", () => {
      const input = JSON.parse(
        '{"name":"valid","__proto__":{"role":"ADMIN"}}',
      );

      expect(() => parseAdminUpdateUser(input))
        .toThrow(BadRequestException);
    });

    it("rejects getters without invoking them", () => {
      const getter = jest.fn(() => valid.password);

      const input = {
        ...valid,
        get password() {
          return getter();
        },
      };

      expect(() => parseAdminCreateUser(input))
        .toThrow(BadRequestException);

      expect(getter).not.toHaveBeenCalled();
    });

    it("rejects symbol and non-enumerable fields", () => {
      expect(() => parseAdminUpdateUser({
        name: "Valid",
        [Symbol("private")]: true,
      })).toThrow(BadRequestException);

      const input = { name: "Valid" };

      Object.defineProperty(input, "role", {
        value: UserRole.ADMIN,
        enumerable: false,
      });

      expect(() => parseAdminUpdateUser(input))
        .toThrow(BadRequestException);
    });
  });
});
