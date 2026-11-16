import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { EntityManager } from "typeorm";
import { normalizeUserEmail } from "./user-email";
import { LoginDto } from "../auth/dtos/login.dto";
import { RegisterDto } from "../auth/dtos/register.dto";

describe("User email DTO boundary", () => {
  it("rejects an actual NUL before querying PostgreSQL", async () => {
    const query = jest.fn();
    const manager = { query } as unknown as EntityManager;

    await expect(
      normalizeUserEmail(
        manager,
        "user" + String.fromCharCode(0) + "@example.test",
      ),
    ).rejects.toThrow("Invalid email");

    expect(query).not.toHaveBeenCalled();
  });
  it("trims login email before validation", () => {
    const dto = plainToInstance(LoginDto, {
      email: "  User@Example.TEST  ",
      password: "password123",
    });

    expect(dto.email).toBe("User@Example.TEST");
    expect(validateSync(dto)).toHaveLength(0);
  });

  it("trims registration email before validation", () => {
    const dto = plainToInstance(RegisterDto, {
      email: String.fromCharCode(9) +
        "User@example.test" +
        String.fromCharCode(160),
      name: "User",
      password: "password123",
    });

    expect(dto.email).toBe("User@example.test");
    expect(validateSync(dto)).toHaveLength(0);
  });

  it.each([
    null,
    123,
    {},
    "",
    "   ",
    "invalid-email",
    "a".repeat(256) + "@example.test",
  ])("rejects invalid email %p", (email) => {
    const login = plainToInstance(LoginDto, {
      email,
      password: "password123",
    });

    const registration = plainToInstance(RegisterDto, {
      email,
      password: "password123",
      name: "User",
    });

    expect(validateSync(login).some(
      (error) => error.property === "email",
    )).toBe(true);

    expect(validateSync(registration).some(
      (error) => error.property === "email",
    )).toBe(true);
  });
});
