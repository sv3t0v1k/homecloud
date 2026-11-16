import { parseDatabaseSize } from "../common/database-size";
import { Injectable, Logger, ForbiddenException, NotFoundException, BadRequestException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, EntityManager } from "typeorm";
import { UserEntity } from "../entities/user.entity";
import { normalizeUserEmail } from "./user-email";
import type { UpdateProfileDto } from "./dtos/update-profile.dto";

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
  ) {}

  async findById(id: number): Promise<UserEntity | null> {
    return this.userRepository.findOne({ where: { id } });
  }

  async findByEmail(email: string): Promise<UserEntity | null> {
    const canonicalEmail = await normalizeUserEmail(
      this.userRepository.manager,
      email,
    );

    return this.userRepository.findOne({
      where: { email: canonicalEmail },
    });
  }

  async updateProfile(
    id: number,
    data: UpdateProfileDto,
  ): Promise<UserEntity> {
    const changes: UpdateProfileDto = {};

    if (data.name !== undefined) {
      if (typeof data.name !== "string" || data.name.length > 100) {
        throw new BadRequestException("Invalid profile name");
      }
      changes.name = data.name;
    }

    if (data.avatar !== undefined) {
      if (
        data.avatar !== null &&
        (typeof data.avatar !== "string" || data.avatar.length > 255)
      ) {
        throw new BadRequestException("Invalid profile avatar");
      }
      changes.avatar = data.avatar;
    }

    if (Object.keys(changes).length > 0) {
      await this.userRepository.update(id, changes);
    }
    const user = await this.findById(id);
    if (!user) throw new NotFoundException("User not found");
    return user;
  }

  async updateStorageUsed(
    id: number,
    bytes: number,
    manager?: EntityManager,
  ): Promise<void> {
    bytes = parseDatabaseSize(bytes);
    if (bytes === 0) {
      return;
    }

    const repository = manager
      ? manager.getRepository(UserEntity)
      : this.userRepository;

    const result = await repository
      .createQueryBuilder()
      .update(UserEntity)
      .set({ storageUsed: () => `"storageUsed" + ${bytes}` })
      .where('id = :id AND "storageUsed" + :bytes <= "storageQuota"', {
        id,
        bytes,
      })
      .execute();

    if (result.affected !== 1) {
      const user = await repository.findOne({ where: { id } });
      if (!user) {
        throw new NotFoundException("User not found");
      }
      const storageUsed = parseDatabaseSize(user.storageUsed);
      const storageQuota = parseDatabaseSize(user.storageQuota);
      if (parseDatabaseSize(storageUsed + bytes) > storageQuota) {
        throw new ForbiddenException("Storage quota exceeded");
      }
      throw new BadRequestException("Storage quota update failed");
    }
  }

  async decrementStorageUsed(
    id: number,
    bytes: number,
    manager?: EntityManager,
  ): Promise<void> {
    bytes = parseDatabaseSize(bytes);
    if (bytes === 0) {
      return;
    }

    const repository = manager
      ? manager.getRepository(UserEntity)
      : this.userRepository;

    const result = await repository
      .createQueryBuilder()
      .update(UserEntity)
      .set({ storageUsed: () => `"storageUsed" - ${bytes}` })
      .where('id = :id AND "storageUsed" >= :bytes', { id, bytes })
      .execute();

    if (result.affected === 0) {
      const user = await repository.findOne({ where: { id } });
      if (!user) {
        throw new NotFoundException("User not found");
      }
      if (parseDatabaseSize(user.storageUsed) < bytes) {
        throw new BadRequestException(
          "Storage used would go negative — data inconsistency detected",
        );
      }
      throw new BadRequestException(
        "Concurrent storage modification — please retry",
      );
    }
  }
}
