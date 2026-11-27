import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Request, UseGuards } from "@nestjs/common";
import { Request as ExpressRequest } from "express";
import { AuthGuard } from "@nestjs/passport";
import { UpdatesService } from "./updates.service";
import { UpdateInstallService } from "./update-install.service";
import { IsString, Matches } from "class-validator";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { UserEntity, UserRole } from "../entities/user.entity";
import { UserInfo } from "../auth/jwt.strategy";
import { sessionVersionMatches } from "../auth/session-token";

type AuthenticatedRequest = ExpressRequest & { user: UserInfo };

class InstallRequestDto {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  manifestSha256!: string;
}

@Controller("updates")
@UseGuards(AuthGuard("jwt"))
export class UpdatesController {
  constructor(
    private readonly updates: UpdatesService,
    private readonly installation: UpdateInstallService,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
  ) {}

  private async hasUpdateAccess(actor: UserInfo): Promise<boolean> {
    if (!this.updates.isAdmin(actor.userId)) return false;

    // JWT claims are not an authority for current administrative roles.
    const user = await this.users.findOne({
      where: { id: actor.userId },
      select: {
        id: true,
        role: true,
        isActive: true,
        sessionVersion: true,
      },
    });

    return !!user &&
      user.id === actor.userId &&
      user.isActive === true &&
      user.role === UserRole.ADMIN &&
      sessionVersionMatches(actor.sessionVersion, user.sessionVersion);
  }

  @Get("access")
  async access(@Request() req: AuthenticatedRequest) {
    return { admin: await this.hasUpdateAccess(req.user) };
  }

  @Get()
  async check(@Request() req: AuthenticatedRequest) {
    if (!(await this.hasUpdateAccess(req.user))) throw new ForbiddenException();
    return this.updates.check();
  }
  @Get("installations/current")
  async installationStatus(@Request() req: AuthenticatedRequest) {
    if (!(await this.hasUpdateAccess(req.user))) throw new ForbiddenException();
    return this.installation.status();
  }

  @Post("installations")
  @HttpCode(202)
  async requestInstallation(@Request() req: AuthenticatedRequest,
                      @Body() dto: InstallRequestDto) {
    if (!(await this.hasUpdateAccess(req.user))) throw new ForbiddenException();
    return this.installation.submit(dto.manifestSha256);
  }
}
