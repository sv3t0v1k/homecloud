import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { CreateUsersTable1746824900000 } from "../migrations/1746824900000-CreateUsersTable";
import { AddUserRolesAndSessionVersion1792831400000 } from "../migrations/1792831400000-AddUserRolesAndSessionVersion";

const databaseUrl = process.env.HOMECLOUD_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("User roles and session version migration", () => {
  it("preserves historical users and enforces database invariants", async () => {
    const db = new DataSource({
      type: "postgres",
      url: databaseUrl,
    });

    await db.initialize();
    const runner = db.createQueryRunner();

    try {
      await runner.connect();
      await runner.startTransaction();

      const schema = `admin_roles_${randomUUID().replace(/-/g, "")}`;
      await runner.query(`CREATE SCHEMA "${schema}"`);
      await runner.query(`SET LOCAL search_path TO "${schema}"`);

      await new CreateUsersTable1746824900000().up(runner);

      await runner.query(`
        INSERT INTO users
          (email, password, name, "isActive", "storageQuota", "storageUsed")
        VALUES
          ('existing@example.test', 'existing-hash', 'Existing', false, 1000, 123),
          ('active@example.test', 'active-hash', 'Active', true, 2000, 456)
      `);

      const before = await runner.query(
        "SELECT * FROM users ORDER BY id",
      );

      const migration = new AddUserRolesAndSessionVersion1792831400000();
      await migration.up(runner);

      const after = await runner.query(
        "SELECT * FROM users ORDER BY id",
      );

      expect(after).toEqual(
        before.map((user: Record<string, unknown>) => ({
          ...user,
          role: "USER",
          sessionVersion: "1",
        })),
      );

      const [created] = await runner.query(`
        INSERT INTO users (email, password, name)
        VALUES ('new@example.test', 'new-hash', 'New')
        RETURNING id, role, "sessionVersion"
      `);

      expect(created.role).toBe("USER");
      expect(created.sessionVersion).toBe("1");

      for (const statement of [
        `UPDATE users SET role='OWNER'`,
        `UPDATE users SET role=NULL`,
        `UPDATE users SET "sessionVersion"=0`,
        `UPDATE users SET "sessionVersion"=-1`,
        `UPDATE users SET "sessionVersion"=NULL`,
      ]) {
        await runner.query("SAVEPOINT invalid_user_value");

        try {
          await expect(runner.query(statement)).rejects.toBeDefined();
        } finally {
          await runner.query("ROLLBACK TO SAVEPOINT invalid_user_value");
          await runner.query("RELEASE SAVEPOINT invalid_user_value");
        }
      }

      await runner.query(
        `UPDATE users SET role='ADMIN', "sessionVersion"=2 WHERE id=$1`,
        [created.id],
      );

      const [admin] = await runner.query(
        'SELECT role, "sessionVersion" FROM users WHERE id=$1',
        [created.id],
      );

      expect(admin).toEqual({
        role: "ADMIN",
        sessionVersion: "2",
      });

      await migration.down(runner);

      const reverted = await runner.query(
        "SELECT * FROM users WHERE id = ANY($1::int[]) ORDER BY id",
        [before.map((user: { id: number }) => user.id)],
      );

      expect(reverted).toEqual(before);
    } finally {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }
      await runner.release();
      await db.destroy();
    }
  }, 30000);
});
