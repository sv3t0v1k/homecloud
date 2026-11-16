import { MigrationInterface, QueryRunner } from "typeorm";

export class AddUserRolesAndSessionVersion1792831400000
  implements MigrationInterface
{
  name = "AddUserRolesAndSessionVersion1792831400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN "role" varchar(16) NOT NULL DEFAULT 'USER',
        ADD COLUMN "sessionVersion" bigint NOT NULL DEFAULT 1,
        ADD CONSTRAINT "users_role_check"
          CHECK ("role" IN ('ADMIN', 'USER')),
        ADD CONSTRAINT "users_session_version_positive"
          CHECK ("sessionVersion" > 0)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        DROP CONSTRAINT "users_session_version_positive",
        DROP CONSTRAINT "users_role_check",
        DROP COLUMN "sessionVersion",
        DROP COLUMN "role"
    `);
  }
}
