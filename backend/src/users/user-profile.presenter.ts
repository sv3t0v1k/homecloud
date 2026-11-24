import { UserEntity, UserRole } from "../entities/user.entity";

export function presentUserProfile(user: UserEntity) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isActive: user.isActive,
    isEmailVerified: user.isEmailVerified,
    avatar: user.avatar,
    storageQuota: user.storageQuota,
    storageUsed: user.storageUsed,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    role: user.role,
    capabilities: {
      manageUsers:
        user.isActive === true && user.role === UserRole.ADMIN,
    },
  };
}
