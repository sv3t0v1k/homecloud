import { MigrationInterface, QueryRunner } from "typeorm";

export class RevokeLegacyRefreshTokens1792831500000
  implements MigrationInterface
{
  name = "RevokeLegacyRefreshTokens1792831500000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Old refresh credentials must never regain validity.
    // Preserve history and leave canonical SHA-256 records untouched.
    await queryRunner.query(`
      UPDATE "refresh_tokens"
         SET "revoked" = TRUE,
             "revoked_at" = CURRENT_TIMESTAMP
       WHERE "revoked" = FALSE
         AND (
           length("token_hash") <> 71
           OR "token_hash" !~ '^sha256:[0-9a-f]{64}$'
         )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Security data migration: intentionally irreversible.
    // Reverting metadata must not reactivate revoked credentials.
    void queryRunner;
  }
}
