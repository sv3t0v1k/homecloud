import {
  Controller,
  Get,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";

import { JwtGuard } from "../auth/guards/jwt.guard";
import { UserInfo } from "../auth/jwt.strategy";
import { AdminUsersReadService } from "./admin-users-read.service";
import { AdminUsersWriteService } from "./admin-users-write.service";

type AuthenticatedRequest = Request & {
  user: UserInfo;
};

// Preserve duplicate and unknown query fields so the strict runtime
// DTO parser can reject them. Do not silently discard prototype keys.
function rawListQuery(request: Request): Record<string, unknown> {
  const query: Record<string, unknown> = Object.create(null);
  const separator = request.originalUrl.indexOf("?");

  if (separator < 0) {
    return query;
  }

  const params = new URLSearchParams(
    request.originalUrl.slice(separator + 1),
  );

  for (const [key, value] of params.entries()) {
    query[key] = Object.prototype.hasOwnProperty.call(query, key)
      ? null
      : value;
  }

  return query;
}

@Controller("admin/users")
@UseGuards(JwtGuard)
export class AdminUsersController {
  constructor(
    private readonly users: AdminUsersReadService,
    private readonly writes: AdminUsersWriteService,
  ) {}

  @Post()
  async create(@Req() request: AuthenticatedRequest) {
    return this.writes.create(
      {
        userId: request.user.userId,
        sessionVersion: request.user.sessionVersion,
      },
      request.body,
    );
  }

  @Put(":id/password")
  async changePassword(@Req() request: AuthenticatedRequest) {
    return this.writes.changePassword(
      {
        userId: request.user.userId,
        sessionVersion: request.user.sessionVersion,
      },
      request.params.id,
      request.body,
    );
  }

  @Get()
  async list(@Req() request: AuthenticatedRequest) {
    return this.users.list(
      {
        userId: request.user.userId,
        sessionVersion: request.user.sessionVersion,
      },
      rawListQuery(request),
    );
  }

  @Get(":id")
  async get(@Req() request: AuthenticatedRequest) {
    return this.users.get(
      {
        userId: request.user.userId,
        sessionVersion: request.user.sessionVersion,
      },
      request.params.id,
    );
  }
}
