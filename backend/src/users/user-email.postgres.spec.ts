import { randomUUID } from "node:crypto";
import { DataSource, QueryRunner } from "typeorm";
import { CreateUsersTable1746824900000 } from "../migrations/1746824900000-CreateUsersTable";
import { AddUserRolesAndSessionVersion1792831400000 } from "../migrations/1792831400000-AddUserRolesAndSessionVersion";
import { NormalizeUserEmails1792831600000 } from "../migrations/1792831600000-NormalizeUserEmails";
import { normalizeUserEmail } from "./user-email";

const databaseUrl = process.env.HOMECLOUD_TEST_DATABASE_URL;
const postgres = databaseUrl ? describe : describe.skip;

postgres("Canonical user email migration", () => {
  async function withHistoricalUsers(
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

      const schema = `email_migration_${randomUUID().replace(/-/g, "")}`;

      await runner.query(`CREATE SCHEMA "${schema}"`);
      await runner.query(`SET LOCAL search_path TO "${schema}"`);

      await new CreateUsersTable1746824900000().up(runner);
      await new AddUserRolesAndSessionVersion1792831400000().up(runner);

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

  it("normalizes emails without changing account IDs, passwords, roles, quota or session version", async () => {
    await withHistoricalUsers(async (runner) => {
      await runner.query(`
        INSERT INTO users
          (email, password, name, "isActive", role,
           "sessionVersion", "storageQuota", "storageUsed")
        VALUES
          ('  Admin@Example.TEST  ', 'hash-one', 'Admin', true,
           'ADMIN', 5, 10000, 123),
          ('SECOND@Example.TEST', 'hash-two', 'Second', false,
           'USER', 8, 20000, 456)
      `);

      const before = await runner.query(
        "SELECT * FROM users ORDER BY id",
      ) as Record<string, unknown>[];

      const migration = new NormalizeUserEmails1792831600000();
      await migration.up(runner);

      const after = await runner.query(
        "SELECT * FROM users ORDER BY id",
      );

      expect(after).toEqual(
        before.map((user, index) => ({
          ...user,
          email: [
            "admin@example.test",
            "second@example.test",
          ][index],
        })),
      );

      await expect(normalizeUserEmail(
        runner.manager,
        String.fromCharCode(9) +
          "ADMIN@Example.TEST" +
          String.fromCharCode(160),
      )).resolves.toBe("admin@example.test");

      await runner.query("SAVEPOINT invalid_email");

      await expect(runner.query(`
        UPDATE users SET email = 'UPPER@Example.TEST'
        WHERE id = 1
      `)).rejects.toMatchObject({
        driverError: { code: "23514" },
      });

      await runner.query("ROLLBACK TO SAVEPOINT invalid_email");
      await runner.query("RELEASE SAVEPOINT invalid_email");

      await runner.query("SAVEPOINT duplicate_email");

      await expect(runner.query(`
        INSERT INTO users (email, password, name)
        VALUES ('admin@example.test', 'hash-three', 'Duplicate')
      `)).rejects.toMatchObject({
        driverError: { code: "23505" },
      });

      await runner.query("ROLLBACK TO SAVEPOINT duplicate_email");
      await runner.query("RELEASE SAVEPOINT duplicate_email");

      await migration.down(runner);

      expect(await runner.query(
        "SELECT * FROM users ORDER BY id",
      )).toEqual(after);

      await migration.up(runner);

      expect(await runner.query(
        "SELECT * FROM users ORDER BY id",
      )).toEqual(after);
    });
  }, 30000);

  it("blocks canonical collisions before changing either historical user", async () => {
    await withHistoricalUsers(async (runner) => {
      await runner.query(`
        INSERT INTO users (email, password, name)
        VALUES
          ('Admin@Example.TEST', 'hash-one', 'First'),
          (' admin@example.test ', 'hash-two', 'Second')
      `);

      const before = await runner.query(
        "SELECT * FROM users ORDER BY id",
      );

      const migration = new NormalizeUserEmails1792831600000();

      await expect(migration.up(runner)).rejects.toThrow(
        "Email normalization blocked: canonical email collisions",
      );

      expect(await runner.query(
        "SELECT * FROM users ORDER BY id",
      )).toEqual(before);

      const [constraint] = await runner.query(`
        SELECT count(*)::int AS count
          FROM pg_constraint
         WHERE conrelid = 'users'::regclass
           AND conname = 'users_email_canonical_check'
      `);

      expect(constraint.count).toBe(0);
    });
  }, 30000);

  it("fails closed for an empty canonical address without changing the account", async () => {
    await withHistoricalUsers(async (runner) => {
      await runner.query(`
        INSERT INTO users (email, password, name)
        VALUES ('   ', 'hash-one', 'Historical')
      `);

      const before = await runner.query(
        "SELECT * FROM users ORDER BY id",
      );

      const migration = new NormalizeUserEmails1792831600000();

      await expect(migration.up(runner)).rejects.toThrow(
        "Email normalization blocked: invalid canonical addresses",
      );

      expect(await runner.query(
        "SELECT * FROM users ORDER BY id",
      )).toEqual(before);
    });
  }, 30000);
});
