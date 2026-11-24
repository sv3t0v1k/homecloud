import {
  Controller,
  Get,
  Patch,
  Body,
  UseGuards,
  Request as NestRequest,
  NotFoundException,
} from "@nestjs/common";
import { Request as ExpressRequest } from "express";
import { UsersService } from "./users.service";
import { JwtGuard } from "../auth/guards/jwt.guard";
import { UpdateProfileDto } from "./dtos/update-profile.dto";
import { presentUserProfile } from "./user-profile.presenter";

@Controller("users")
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get("me")
  @UseGuards(JwtGuard)
  async getMe(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
  ) {
    const user = await this.usersService.findById(req.user.userId);
    if (!user) {
      throw new NotFoundException("User not found");
    }
    return presentUserProfile(user);
  }

  @Patch("me")
  @UseGuards(JwtGuard)
  async updateProfile(
    @NestRequest() req: ExpressRequest & { user: { userId: number } },
    @Body() dto: UpdateProfileDto,
  ) {
    const user = await this.usersService.updateProfile(req.user.userId, dto);
    return presentUserProfile(user);
  }
}
