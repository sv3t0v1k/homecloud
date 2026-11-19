import { MigrationInterface, QueryRunner } from "typeorm";

export class UserDeletionCleanup1792831700000 implements MigrationInterface {
  name = "UserDeletionCleanup1792831700000";

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE "user_deletion_operations" (
        "userId" integer PRIMARY KEY,
        "payload" jsonb NOT NULL
          CONSTRAINT "CHK_user_deletion_payload"
          CHECK (jsonb_typeof("payload") = 'object'),
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP TABLE "user_deletion_operations"`);
  }
}
