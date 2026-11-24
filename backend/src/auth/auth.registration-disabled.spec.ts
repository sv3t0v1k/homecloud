import {
  Controller,
  ForbiddenException,
  Get,
  INestApplication,
  ValidationPipe,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtStrategy } from "./jwt.strategy";
import { HttpExceptionFilter } from "../common/errors/http-exception.filter";
import { TransformInterceptor } from "../common/interceptors/transform.interceptor";

const SECRET = "registration-disabled-test-secret-not-production";

const denial = {
  statusCode: 403,
  code: "REGISTRATION_DISABLED",
  message: "Public registration is disabled",
};

@Controller("error-contract-probe")
class ErrorContractProbeController {
  @Get()
  execute(): never {
    throw new ForbiddenException({
      message: "Forbidden",
      code: "PRIVATE_INTERNAL_CODE",
      password: "must-not-leak",
      details: {
        credentials: "must-not-leak",
      },
    });
  }
}

describe("Public registration disabled HTTP contract", () => {
  let app: INestApplication;

  it("does not expose a production self-registration service", () => {
    expect(AuthService.prototype).not.toHaveProperty("register");
  });

  const authService = {
    register: jest.fn(),
    login: jest.fn(),
  };

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({
      controllers: [
        AuthController,
        ErrorContractProbeController,
      ],
      providers: [
        {
          provide: AuthService,
          useValue: authService,
        },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            JWT_SECRET: SECRET,
          }),
        },
        {
          provide: JwtService,
          useValue: new JwtService({ secret: SECRET }),
        },
        {
          provide: JwtStrategy,
          useValue: {
            validate: jest.fn(),
          },
        },
      ],
    }).compile();

    app = fixture.createNestApplication();

    // Use the same HTTP response pipeline as production.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new TransformInterceptor());

    app.setGlobalPrefix("api/v1");

    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  const payloads = [
    {
      name: "valid historical registration",
      body: {
        email: "owner@example.test",
        password: "password123456",
        name: "Owner",
      },
    },
    {
      name: "empty object",
      body: {},
    },
    {
      name: "missing required fields",
      body: {
        email: "owner@example.test",
      },
    },
    {
      name: "invalid email and password types",
      body: {
        email: 123,
        password: false,
        name: [],
      },
    },
    {
      name: "extra fields requesting administrator role",
      body: {
        email: "owner@example.test",
        password: "password123456",
        name: "Owner",
        role: "ADMIN",
        isActive: true,
        sessionVersion: "100",
        storageQuota: "1000000000000",
      },
    },
    {
      name: "array body",
      body: [
        {
          email: "owner@example.test",
          password: "password123456",
        },
      ],
    },
  ];

  it.each(payloads)(
    "returns stable 403 for $name without invoking registration",
    async ({ body }) => {
      const response = await request(app.getHttpServer())
        .post("/api/v1/auth/register")
        .send(body)
        .expect(403);

      expect(response.body).toEqual({
        ...denial,
        timestamp: expect.any(String),
        path: "/api/v1/auth/register",
      });

      expect(authService.register).not.toHaveBeenCalled();
      expect(authService.login).not.toHaveBeenCalled();
    },
  );

  it("rejects a request with no body", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .expect(403);

    expect(response.body).toMatchObject(denial);
    expect(authService.register).not.toHaveBeenCalled();
  });

  it("cannot be enabled by supplying an Authorization header", async () => {
    const jwt = new JwtService({ secret: SECRET });

    const token = jwt.sign({
      sub: 1,
      email: "owner@example.test",
      sv: "1",
      tokenUse: "access",
    }, { expiresIn: 60 });

    const response = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .set("Authorization", "Bearer " + token)
      .send({
        email: "new@example.test",
        password: "password123456",
        name: "New user",
      })
      .expect(403);

    expect(response.body).toMatchObject(denial);
    expect(authService.register).not.toHaveBeenCalled();
  });

  it("keeps the ordinary login endpoint and its response contract", async () => {
    authService.login.mockResolvedValue({
      accessToken: "fixture-access",
      refreshToken: "fixture-refresh",
    });

    const response = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({
        email: "owner@example.test",
        password: "password123456",
      })
      .expect(200);

    expect(response.body).toEqual({
      success: true,
      data: {
        message: "Login successful",
        accessToken: "fixture-access",
        refreshToken: "fixture-refresh",
      },
    });

    expect(authService.login).toHaveBeenCalledWith(
      "owner@example.test",
      "password123456",
    );

    expect(authService.register).not.toHaveBeenCalled();
  });

  it("does not expose arbitrary error codes or exception metadata", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/error-contract-probe")
      .expect(403);

    expect(response.body).toEqual({
      statusCode: 403,
      message: "Forbidden",
      timestamp: expect.any(String),
      path: "/api/v1/error-contract-probe",
    });

    expect(JSON.stringify(response.body))
      .not.toContain("PRIVATE_INTERNAL_CODE");

    expect(JSON.stringify(response.body))
      .not.toContain("must-not-leak");
  });
});
