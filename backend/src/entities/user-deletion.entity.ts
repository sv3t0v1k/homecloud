import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
} from "typeorm";

export interface UserDeletionCleanupPayload {
  files: { path: string }[];
  uploads: {
    workspaceId: string;
    uploadId: string;
    tempPath: string;
  }[];
}

/**
 * Durable post-commit physical cleanup. There is deliberately no user FK:
 * the journal must survive the account cascade and a backend restart.
 */
@Entity("user_deletion_operations")
export class UserDeletionEntity {
  @PrimaryColumn({ type: "integer", name: "userId" })
  userId!: number;

  @Column({ type: "jsonb" })
  payload!: UserDeletionCleanupPayload;

  @CreateDateColumn({ type: "timestamptz", name: "createdAt" })
  createdAt!: Date;
}
