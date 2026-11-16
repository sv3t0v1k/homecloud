import { Test } from "@nestjs/testing";
import { ValidationPipe, NotFoundException } from "@nestjs/common";
import { getRepositoryToken } from "@nestjs/typeorm";
import { JwtStrategy } from "../auth/jwt.strategy";
import { JwtService } from "@nestjs/jwt";
import { ConfigModule } from "@nestjs/config";
import request from "supertest";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";
import { UserEntity, UserRole } from "../entities/user.entity";

const CONFIG = {
  NODE_ENV: "production",
  FRONTEND_URL: "https://app.example.ru",
  JWT_SECRET: "strong-access-secret-1234567890ab",
  JWT_REFRESH_SECRET: "strong-refresh-secret-1234567890ab",
  JWT_EXPIRES_IN: "15m",
  JWT_REFRESH_EXPIRES_IN: "7d",
};

const AUTH = { Authorization: "Bearer header.payload.signature" };

/**
 * Phase 11.2C — regression coverage for users not-found error contracts.
 * Real controller + real UsersService + mocked repository + JwtGuard (mocked
 * JwtService). Proves HTTP semantics only; JWT cryptography is not exercised.
 */
describe("UsersController not-found contracts (Phase 11.2C)", () => {
  let app: any;
  let repo: { findOne: jest.Mock; update: jest.Mock };

  beforeAll(async () => {
    repo = { findOne: jest.fn(), update: jest.fn() };

    const mod = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [() => CONFIG] })],
      controllers: [UsersController],
      providers: [
        UsersService,
        { provide: getRepositoryToken(UserEntity), useValue: repo },
        {
          provide: JwtService,
          useValue: { verify: jest.fn(() => ({ sub: 1, email: "u@t.c" })), sign: jest.fn() },
        },
        { provide: JwtStrategy, useValue: { validate: async () => ({ userId: 1, email: "u@t.c" }) } },
      ],
    }).compile();

    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.setGlobalPrefix("api/v1");
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => jest.clearAllMocks());

  it("GET /me existing → 200 and password is excluded", async () => {
    repo.findOne.mockResolvedValue({
      id: 1,
      email: "u@t.c",
      name: "U",
      password: "secret-hash",
      role: UserRole.USER,
      sessionVersion: "17",
      refreshTokens: [{ tokenHash: "internal-refresh-hash" }],
      internalField: "internal-value",
    });

    const res = await request(app.getHttpServer())
      .get("/api/v1/users/me")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.password).toBeUndefined();
    expect(res.body.email).toBe("u@t.c");
    expect(res.body.role).toBe(UserRole.USER);
    expect(res.body.sessionVersion).toBeUndefined();
    expect(res.body.refreshTokens).toBeUndefined();
    expect(res.body.internalField).toBeUndefined();
    expect(repo.findOne).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it("GET /me missing → 404", async () => {
    repo.findOne.mockResolvedValue(null);

    const res = await request(app.getHttpServer())
      .get("/api/v1/users/me")
      .set(AUTH);

    expect(res.status).toBe(404);
  });

  it("PATCH /me existing → 200 and password is excluded", async () => {
    repo.update.mockResolvedValue({ affected: 1 });
    repo.findOne.mockResolvedValue({
      id: 1,
      email: "u@t.c",
      name: "New",
      password: "secret-hash",
      role: UserRole.USER,
      sessionVersion: "17",
    });

    const res = await request(app.getHttpServer())
      .patch("/api/v1/users/me")
      .set(AUTH)
      .send({ name: "New" });

    expect(res.status).toBe(200);
    expect(res.body.password).toBeUndefined();
    expect(res.body.name).toBe("New");
    expect(res.body.role).toBe(UserRole.USER);
    expect(res.body.sessionVersion).toBeUndefined();
  });

  it.each([
    { role: UserRole.ADMIN },
    { sessionVersion: "999" },
    { isActive: false },
    { storageQuota: "999999999" },
    { storageUsed: "0" },
    { password: "changed-password" },
    { email: "other@example.com" },
    { isEmailVerified: true },
  ])("PATCH /me rejects privileged fields: %j", async (body) => {
    const res = await request(app.getHttpServer())
      .patch("/api/v1/users/me")
      .set(AUTH)
      .send(body);

    expect(res.status).toBe(400);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("service persists only explicitly allowed profile fields", async () => {
    repo.update.mockResolvedValue({ affected: 1 });
    repo.findOne.mockResolvedValue({
      id: 1,
      name: "New",
      role: UserRole.USER,
    });

    const service = new UsersService(repo as any);

    const injected = {
      name: "New",
      role: UserRole.ADMIN,
      storageQuota: "999999",
      sessionVersion: "99",
      password: "injected-password",
      isActive: false,
    };

    await service.updateProfile(1, injected);

    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith(1, { name: "New" });
  });

  it("preserves clearing a nullable avatar", async () => {
    repo.update.mockResolvedValue({ affected: 1 });
    repo.findOne.mockResolvedValue({ id: 1, avatar: null });

    const res = await request(app.getHttpServer())
      .patch("/api/v1/users/me")
      .set(AUTH)
      .send({ avatar: null });

    expect(res.status).toBe(200);
    expect(repo.update).toHaveBeenCalledWith(1, { avatar: null });
    expect(res.body.avatar).toBeNull();
  });

  it("empty profile update performs no database mutation", async () => {
    repo.findOne.mockResolvedValue({ id: 1, name: "U" });

    const service = new UsersService(repo as any);
    await service.updateProfile(1, {});

    expect(repo.update).not.toHaveBeenCalled();
  });

  it("PATCH /me missing → 404", async () => {
    repo.update.mockResolvedValue({ affected: 0 });
    repo.findOne.mockResolvedValue(null);

    const res = await request(app.getHttpServer())
      .patch("/api/v1/users/me")
      .set(AUTH)
      .send({ name: "Ghost" });

    expect(res.status).toBe(404);
  });

  it("UsersService.updateProfile throws NotFoundException (not generic Error) for absent user", async () => {
    repo.update.mockResolvedValue({ affected: 0 });
    repo.findOne.mockResolvedValue(null);

    const service = new UsersService(repo as any);
    await expect(service.updateProfile(999, { name: "Ghost" })).rejects.toThrow(
      NotFoundException,
    );
  });
});
