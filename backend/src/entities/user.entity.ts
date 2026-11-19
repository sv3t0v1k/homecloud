import {
  Entity,
  Check,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from "typeorm";
import { FileEntity } from "./file.entity";
import { RefreshTokenEntity } from "./refresh-token.entity";
import { CANONICAL_EMAIL_CHECK } from "../users/user-email";

export enum UserRole {
  ADMIN = "ADMIN",
  USER = "USER",
}

@Entity("users")
@Check("users_email_canonical_check", CANONICAL_EMAIL_CHECK)
@Check("users_role_check", `"role" IN ('ADMIN', 'USER')`)
@Check("users_session_version_positive", `"sessionVersion" > 0`)
export class UserEntity {
  @PrimaryGeneratedColumn()
  id!: number;

@Column({ unique: true, length: 255, name: "email" })
  email!: string;

  @Column({ length: 255, name: "password" })
  password!: string;

  @Column({ length: 100, default: "User", name: "name" })
  name!: string;

  @Column({ default: true, name: "isActive" })
  isActive!: boolean;

  @Column({
    type: "varchar",
    length: 16,
    default: UserRole.USER,
    name: "role",
  })
  role!: UserRole;

  @Column({
    type: "bigint",
    default: "1",
    name: "sessionVersion",
  })
  sessionVersion!: string;

  @Column({ default: false, name: "isEmailVerified" })
  isEmailVerified!: boolean;

  @Column({ length: 255, nullable: true, name: "avatar" })
  avatar!: string;

  @Column({ default: 0, name: "storageQuota", type: "bigint" })
  storageQuota!: number;

  @Column({ default: 0, name: "storageUsed", type: "bigint" })
  storageUsed!: number;

  @CreateDateColumn({ name: "createdAt" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updatedAt" })
  updatedAt!: Date;

  @OneToMany(() => FileEntity, (file) => file.user)
  files!: FileEntity[];

  @OneToMany(() => RefreshTokenEntity, (rt) => rt.user)
  refreshTokens!: RefreshTokenEntity[];
}
