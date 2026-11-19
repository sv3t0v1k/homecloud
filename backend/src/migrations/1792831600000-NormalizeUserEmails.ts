import { MigrationInterface, QueryRunner } from "typeorm";

export class NormalizeUserEmails1792831600000
  implements MigrationInterface
{
  name = "NormalizeUserEmails1792831600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!queryRunner.isTransactionActive) {
      throw new Error("Email normalization requires a transaction");
    }

    // Prevent concurrent inserts/updates between preflight and CHECK.
    await queryRunner.query(
      'LOCK TABLE "users" IN ACCESS EXCLUSIVE MODE',
    );

    // Frozen normalization definition for this migration.
    const trimCharacters = "chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760) || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279)";
    const canonical =
      `lower(btrim("email", ${trimCharacters}) COLLATE "default")`;

    const [invalid] = await queryRunner.query(`
      SELECT count(*)::int AS count
        FROM "users"
       WHERE char_length(${canonical}) NOT BETWEEN 1 AND 255
    `) as { count: number }[];

    if (invalid.count !== 0) {
      throw new Error(
        "Email normalization blocked: invalid canonical addresses",
      );
    }

    // Detect all collisions before modifying any user.
    // Do not include account emails in migration error messages.
    const [collisions] = await queryRunner.query(`
      SELECT count(*)::int AS count
        FROM (
          SELECT ${canonical} AS canonical_email
            FROM "users"
           GROUP BY canonical_email
          HAVING count(*) > 1
        ) AS conflicting_emails
    `) as { count: number }[];

    if (collisions.count !== 0) {
      throw new Error(
        "Email normalization blocked: canonical email collisions",
      );
    }

    await queryRunner.query(`
      UPDATE "users"
         SET "email" = ${canonical}
       WHERE ("email" COLLATE "C") <> (${canonical} COLLATE "C")
    `);

    await queryRunner.query(`
      ALTER TABLE "users"
        ADD CONSTRAINT "users_email_canonical_check"
        CHECK (
          char_length("email") > 0
          AND ("email" COLLATE "C") = (${canonical} COLLATE "C")
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Original casing/whitespace is intentionally not reconstructed.
    // User identities and their existing unique constraint remain intact.
    await queryRunner.query(`
      ALTER TABLE "users"
        DROP CONSTRAINT "users_email_canonical_check"
    `);
  }
}
