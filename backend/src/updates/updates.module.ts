import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { UserEntity } from "../entities/user.entity";
import { AuthModule } from "../auth/auth.module";
import { UpdatesController } from "./updates.controller";
import { UpdatesService } from "./updates.service";
import { UpdateInstallService } from "./update-install.service";

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([UserEntity])],
  controllers: [UpdatesController],
  providers: [UpdatesService, UpdateInstallService],
})
export class UpdatesModule {}
