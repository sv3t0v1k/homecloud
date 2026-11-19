import { PassportStrategy } from "@nestjs/passport";
import { Strategy } from "passport-jwt";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { UserEntity } from "../entities/user.entity";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";
import { bearerTokenFromHeader } from "./guards/bearer-token";

import {
  AccessSessionClaims,
  parseAccessSessionClaims,
  sessionVersionMatches,
} from "./session-token";

export type JwtPayload = AccessSessionClaims;

export interface UserInfo {
  userId: number;
  email: string;
  sessionVersion: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    private configService: ConfigService,
  ) {
    super({
      jwtFromRequest: (request: Request) =>
        bearerTokenFromHeader(request.headers.authorization) ?? null,
      secretOrKey: configService.get("JWT_SECRET"),
      algorithms: ["HS256"],
    });
  }

  async validate(payload: unknown): Promise<UserInfo> {
    const claims = parseAccessSessionClaims(payload);

    if (!claims) {
      throw new UnauthorizedException();
    }

    const user = await this.userRepository.findOne({
      where: { id: claims.sub, isActive: true },
    });

    if (
      !user ||
      !sessionVersionMatches(claims.sv, user.sessionVersion)
    ) {
      throw new UnauthorizedException();
    }

    return {
      userId: user.id,
      email: user.email,
      sessionVersion: user.sessionVersion,
    };
  }
}
