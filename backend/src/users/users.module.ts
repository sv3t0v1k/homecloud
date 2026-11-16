import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { UserEntity } from "../entities/user.entity";
import { UsersService } from "./users.service";
import { UsersController } from "./users.controller";
import { AdminUsersController } from "./admin-users.controller";
import { AdminUsersReadService } from "./admin-users-read.service";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [TypeOrmModule.forFeature([UserEntity]), AuthModule],
  providers: [UsersService, AdminUsersReadService],
  controllers: [UsersController, AdminUsersController],
  exports: [UsersService],
})
export class UsersModule {}
