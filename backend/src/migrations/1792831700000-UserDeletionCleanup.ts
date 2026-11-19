import { MigrationInterface, QueryRunner } from "typeorm";

export class UserDeletionCleanup1792831700000 implements MigrationInterface {
  name = "UserDeletionCleanup1792831700000";

  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive) {
      throw new Error("User deletion cleanup journal requires a transaction");
    }

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
    if (!runner.isTransactionActive) {
      throw new Error("User deletion cleanup journal requires a transaction");
    }

    await runner.query(
      `LOCK TABLE "user_deletion_operations" IN ACCESS EXCLUSIVE MODE`,
    );
    const retained: unknown[] = await runner.query(
      `SELECT 1 FROM "user_deletion_operations" LIMIT 1`,
    );

    if (retained.length !== 0) {
      throw new Error("Nonempty user deletion journal cannot be dropped");
    }

    await runner.query(`DROP TABLE "user_deletion_operations"`);
  }
}
