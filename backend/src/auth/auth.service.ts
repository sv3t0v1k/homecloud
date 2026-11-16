import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, EntityManager, LessThan } from "typeorm";
import { UserEntity, UserRole } from "../entities/user.entity";
import {
  isSessionVersion,
  sessionVersionMatches,
  parseRefreshSessionClaims,
  RefreshSessionClaims,
  refreshTokenDigest,
} from "./session-token";
import {
  lockSessionUser,
  revokeLockedUserSessions,
} from "./session-revocation";
import { RefreshTokenEntity } from "../entities/refresh-token.entity";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { ConfigService } from "@nestjs/config";

export type JwtPayload = RefreshSessionClaims;

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

type RefreshTransactionResult =
  { reused: true } | { reused: false; tokens: Tokens };

const WEAK_SECRETS = new Set([
  "changeme",
  "changeme-change-in-production",
  "change-me-in-production",
  "secret",
  "password",
  "jwt_secret",
  "your-secret-key",
  "",
]);

@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthService.name);

  private cleanupInterval?: ReturnType<typeof setInterval>;

  constructor(
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    @InjectRepository(RefreshTokenEntity)
    private refreshTokenRepository: Repository<RefreshTokenEntity>,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  onModuleInit(): void {
    this.cleanupExpiredTokens().catch(() => {
      this.logger.error("Initial expired token cleanup failed");
    });
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredTokens().catch(() => {
        this.logger.error("Periodic expired token cleanup failed");
      });
    }, 3600_000);
  }

  onModuleDestroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
  }

  async register(
    email: string,
    password: string,
    name?: string,
  ): Promise<Tokens> {
    const hashedPassword = await bcrypt.hash(password, 12);

    return this.refreshTokenRepository.manager.transaction(
      async (manager) => {
        const existing = await manager.findOne(UserEntity, {
          where: { email },
        });

        if (existing) {
          throw new ConflictException("User with this email already exists");
        }

        const user = manager.create(UserEntity, {
          email,
          password: hashedPassword,
          name: name || email.split("@")[0],
          role: UserRole.USER,
          sessionVersion: "1",
        });

        const saved = await manager.save(user);

        return this.generateTokens(manager, saved);
      },
    );
  }

  async login(email: string, password: string): Promise<Tokens> {
    const snapshot = await this.userRepository.findOne({
      where: { email },
    });

    if (!snapshot || !snapshot.isActive) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const valid = await bcrypt.compare(password, snapshot.password);

    if (!valid) {
      throw new UnauthorizedException("Invalid credentials");
    }

    return this.refreshTokenRepository.manager.transaction(
      async (manager) => {
        const user = await lockSessionUser(manager, snapshot.id);

        if (
          !user ||
          !user.isActive ||
          user.email !== snapshot.email ||
          user.password !== snapshot.password ||
          !sessionVersionMatches(
            snapshot.sessionVersion,
            user.sessionVersion,
          )
        ) {
          throw new UnauthorizedException("Invalid credentials");
        }

        return this.generateTokens(manager, user);
      },
    );
  }

  async refresh(userId: number, refreshToken: string): Promise<Tokens> {
    const verified = await this.verifyRefreshToken(refreshToken);

    if (verified.sub !== userId) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    const result = await this.refreshTokenRepository.manager.transaction(
      async (manager: EntityManager): Promise<RefreshTransactionResult> => {
        const user = await lockSessionUser(manager, userId);

        // Expiration is checked again after waiting for the row lock.
        const claims = await this.verifyRefreshToken(refreshToken);

        if (
          !user ||
          !user.isActive ||
          claims.sub !== user.id ||
          !sessionVersionMatches(claims.sv, user.sessionVersion)
        ) {
          throw new UnauthorizedException("Invalid refresh token");
        }

        const storedToken = await this.findAndLockRefreshToken(
          manager,
          userId,
          refreshToken,
        );

        if (!storedToken) {
          throw new UnauthorizedException("Invalid refresh token");
        }

        if (storedToken.expiresAt.getTime() <= Date.now()) {
          throw new UnauthorizedException("Refresh token expired");
        }

        if (storedToken.revoked) {
          await revokeLockedUserSessions(manager, user);
          return { reused: true };
        }

        const issued = await this.issueTokens(user);
        const newTokenHash = refreshTokenDigest(issued.tokens.refreshToken);

        const updated = await manager.update(
          RefreshTokenEntity,
          { id: storedToken.id, revoked: false },
          {
            revoked: true,
            revokedAt: new Date(),
            replacedBy: newTokenHash,
          },
        );

        if (updated.affected !== 1) {
          await revokeLockedUserSessions(manager, user);
          return { reused: true };
        }

        const entity = manager.create(RefreshTokenEntity, {
          tokenHash: newTokenHash,
          expiresAt: issued.expiresAt,
          userId,
        });

        await manager.save(entity);

        return { reused: false, tokens: issued.tokens };
      },
    );

    // Reuse revocation must commit before returning an authentication error.
    if (result.reused) {
      throw new UnauthorizedException("Refresh token was reused");
    }

    return result.tokens;
  }

  async logout(
    userId: number,
    refreshToken: string,
    sessionVersion: string,
  ): Promise<void> {
    if (!refreshToken) return;

    await this.refreshTokenRepository.manager.transaction(async (manager) => {
      const user = await lockSessionUser(manager, userId);

      if (
        !user ||
        !user.isActive ||
        !sessionVersionMatches(sessionVersion, user.sessionVersion)
      ) {
        throw new UnauthorizedException();
      }

      const initialToken = await this.findAndLockRefreshToken(
        manager,
        userId,
        refreshToken,
      );

      if (!initialToken) return;

      let storedToken: RefreshTokenEntity = initialToken;
      const visitedHashes = new Set<string>();

      while (storedToken.replacedBy) {
        if (visitedHashes.has(storedToken.replacedBy)) return;
        visitedHashes.add(storedToken.replacedBy);

        const replacement: RefreshTokenEntity | null = await manager.findOne(
          RefreshTokenEntity,
          {
            where: { tokenHash: storedToken.replacedBy, userId },
            lock: { mode: "pessimistic_write" },
          },
        );

        if (!replacement) return;
        storedToken = replacement;
      }

      if (storedToken.revoked) return;

      await manager.update(
        RefreshTokenEntity,
        { id: storedToken.id, revoked: false },
        { revoked: true, revokedAt: new Date() },
      );
    });
  }

  async revokeAllUserTokens(userId: number): Promise<void> {
    await this.refreshTokenRepository.manager.transaction(
      async (manager) => {
        const user = await lockSessionUser(manager, userId);

        if (!user) {
          throw new UnauthorizedException();
        }

        await revokeLockedUserSessions(manager, user);
      },
    );
  }

  private async findAndLockRefreshToken(
    manager: EntityManager,
    userId: number,
    refreshToken: string,
  ): Promise<RefreshTokenEntity | null> {
    return manager.findOne(RefreshTokenEntity, {
      where: {
        userId,
        tokenHash: refreshTokenDigest(refreshToken),
      },
      lock: { mode: "pessimistic_write" },
    });
  }

  async changePassword(
    userId: number,
    oldPassword: string,
    newPassword: string,
    sessionVersion: string,
  ): Promise<void> {
    const snapshot = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (
      !snapshot ||
      !snapshot.isActive ||
      !sessionVersionMatches(sessionVersion, snapshot.sessionVersion)
    ) {
      throw new UnauthorizedException();
    }

    const valid = await bcrypt.compare(oldPassword, snapshot.password);

    if (!valid) {
      throw new UnauthorizedException("Current password is incorrect");
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await this.refreshTokenRepository.manager.transaction(
      async (manager) => {
        const user = await lockSessionUser(manager, userId);

        if (
          !user ||
          !user.isActive ||
          user.password !== snapshot.password ||
          !sessionVersionMatches(sessionVersion, user.sessionVersion)
        ) {
          throw new UnauthorizedException();
        }

        const updated = await manager.update(
          UserEntity,
          { id: user.id },
          { password: hashedPassword },
        );

        if (updated.affected !== 1) {
          throw new Error("Password update failed");
        }

        await revokeLockedUserSessions(manager, user);
      },
    );
  }

  async validateUser(
    email: string,
    password: string,
  ): Promise<UserEntity | null> {
    const user = await this.userRepository.findOne({ where: { email } });
    if (!user || !user.isActive) return null;

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return null;

    return user;
  }

  async validateJwtSecret(): Promise<{ valid: boolean; message: string }> {
    const secret = this.configService.get("JWT_SECRET") || "";
    if (WEAK_SECRETS.has(secret.trim().toLowerCase())) {
      return {
        valid: false,
        message:
          "JWT_SECRET is weak or default. Set a strong secret in production.",
      };
    }
    if (secret.length < 32) {
      return {
        valid: false,
        message: "JWT_SECRET must be at least 32 characters.",
      };
    }
    return { valid: true, message: "JWT_SECRET is strong." };
  }

  async validateRefreshSecret(): Promise<{ valid: boolean; message: string }> {
    const secret = this.configService.get("JWT_REFRESH_SECRET") || "";
    if (WEAK_SECRETS.has(secret.trim().toLowerCase())) {
      return {
        valid: false,
        message:
          "JWT_REFRESH_SECRET is weak or default. Set a strong secret in production.",
      };
    }
    if (secret.length < 32) {
      return {
        valid: false,
        message: "JWT_REFRESH_SECRET must be at least 32 characters.",
      };
    }
    return { valid: true, message: "JWT_REFRESH_SECRET is strong." };
  }

  private async issueTokens(
    user: UserEntity,
  ): Promise<{ tokens: Tokens; expiresAt: Date }> {
    if (!isSessionVersion(user.sessionVersion)) {
      throw new Error("Invalid stored session version");
    }

    const identity = {
      sub: user.id,
      email: user.email,
      sv: user.sessionVersion,
    };

    const accessToken = this.jwtService.sign(
      { ...identity, tokenUse: "access" },
      {
        secret: this.configService.get("JWT_SECRET"),
        expiresIn: this.configService.get("JWT_EXPIRES_IN") || "15m",
        algorithm: "HS256",
      },
    );

    const refreshToken = this.jwtService.sign(
      {
        ...identity,
        tokenUse: "refresh",
        jti: randomUUID(),
      },
      {
        secret: this.configService.get("JWT_REFRESH_SECRET"),
        expiresIn: this.configService.get("JWT_REFRESH_EXPIRES_IN") || "7d",
        algorithm: "HS256",
      },
    );

    const claims = await this.verifyRefreshToken(refreshToken);

    return {
      tokens: { accessToken, refreshToken },
      expiresAt: new Date(claims.exp * 1000),
    };
  }

  private async generateTokens(
    manager: EntityManager,
    user: UserEntity,
  ): Promise<Tokens> {
    const issued = await this.issueTokens(user);

    const entity = manager.create(RefreshTokenEntity, {
      tokenHash: refreshTokenDigest(issued.tokens.refreshToken),
      expiresAt: issued.expiresAt,
      userId: user.id,
    });

    await manager.save(entity);

    return issued.tokens;
  }

  async verifyRefreshToken(token: string): Promise<RefreshSessionClaims> {
    try {
      const payload: unknown = this.jwtService.verify(token, {
        secret: this.configService.get("JWT_REFRESH_SECRET"),
        algorithms: ["HS256"],
      });

      const claims = parseRefreshSessionClaims(payload);

      if (!claims) {
        throw new UnauthorizedException("Invalid refresh token");
      }

      return claims;
    } catch {
      throw new UnauthorizedException("Invalid refresh token");
    }
  }

  async cleanupExpiredTokens(): Promise<void> {
    const result = await this.refreshTokenRepository.delete({
      expiresAt: LessThan(new Date()),
    });
    if (result.affected && result.affected > 0) {
      this.logger.log(`Cleaned up ${result.affected} expired refresh token(s)`);
    }
  }

  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 12);
  }
}
