import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { UserEntity } from "../entities/user.entity";
import { UsersService } from "./users.service";
import { UsersController } from "./users.controller";
import { AdminUsersController } from "./admin-users.controller";
import { AdminUsersReadService } from "./admin-users-read.service";
import { AdminUsersWriteService } from "./admin-users-write.service";
import { AuthModule } from "../auth/auth.module";
import { StorageModule } from "../storage/storage.module";
import { AdminUserDeletionService } from "./admin-user-deletion.service";
import { UserDeletionEntity } from "../entities/user-deletion.entity";

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, UserDeletionEntity]),
    AuthModule,
    StorageModule,
  ],
  providers: [
    UsersService,
    AdminUsersReadService,
    AdminUsersWriteService,
    AdminUserDeletionService,
  ],
  controllers: [UsersController, AdminUsersController],
  exports: [UsersService],
})
export class UsersModule {}
