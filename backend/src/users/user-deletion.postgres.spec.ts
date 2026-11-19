import { randomUUID } from "node:crypto";
import { DataSource, QueryRunner } from "typeorm";
import { UserDeletionCleanup1792831700000 } from "../migrations/1792831700000-UserDeletionCleanup";

const databaseUrl = process.env.HOMECLOUD_TEST_DATABASE_URL;
const postgres = databaseUrl ? describe : describe.skip;

postgres("Durable user deletion cleanup migration", () => {
  async function withJournal(
    test: (runner: QueryRunner) => Promise<void>,
  ) {
    const db = new DataSource({
      type: "postgres",
      url: databaseUrl,
    });

    await db.initialize();
    const runner = db.createQueryRunner();

    try {
      await runner.connect();
      await runner.startTransaction();

      const schema = `user_deletion_${randomUUID().replace(/-/g, "")}`;
      await runner.query(`CREATE SCHEMA "${schema}"`);
      await runner.query(`SET LOCAL search_path TO "${schema}"`);

      await test(runner);
    } finally {
      try {
        if (runner.isTransactionActive) {
          await runner.rollbackTransaction();
        }
      } finally {
        await runner.release();
        await db.destroy();
      }
    }
  }

  it("refuses to drop retained cleanup and allows only an empty rollback", async () => {
    await withJournal(async (runner) => {
      const migration = new UserDeletionCleanup1792831700000();
      await migration.up(runner);

      await runner.query(`
        INSERT INTO "user_deletion_operations" ("userId", payload)
        VALUES (1, '{"files":[{"path":"/fixture/removed"}],"uploads":[]}')
      `);

      await runner.query("SAVEPOINT retained_cleanup");
      await expect(migration.down(runner)).rejects.toThrow(
        "Nonempty user deletion journal cannot be dropped",
      );
      await runner.query("ROLLBACK TO SAVEPOINT retained_cleanup");
      await runner.query("RELEASE SAVEPOINT retained_cleanup");

      expect(await runner.query(
        `SELECT "userId", payload FROM "user_deletion_operations"`,
      )).toEqual([{
        userId: 1,
        payload: {
          files: [{ path: "/fixture/removed" }],
          uploads: [],
        },
      }]);

      await runner.query(`DELETE FROM "user_deletion_operations"`);
      await migration.down(runner);

      expect(await runner.query(`
        SELECT count(*)::int AS count FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'user_deletion_operations'
      `)).toEqual([{ count: 0 }]);
    });
  });

  it("requires a transaction for both schema directions", async () => {
    const db = new DataSource({ type: "postgres", url: databaseUrl });
    await db.initialize();
    const runner = db.createQueryRunner();

    try {
      await runner.connect();
      const migration = new UserDeletionCleanup1792831700000();

      await expect(migration.up(runner)).rejects.toThrow("requires a transaction");
      await expect(migration.down(runner)).rejects.toThrow("requires a transaction");
    } finally {
      await runner.release();
      await db.destroy();
    }
  });
});
