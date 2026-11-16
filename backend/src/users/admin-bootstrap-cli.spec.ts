import { DataSource } from "typeorm";
import {
  parseBootstrapCommand,
  assertBootstrapSchemaReady,
} from "./admin-bootstrap-cli";

describe("Operator bootstrap CLI contract", () => {
  it("accepts the exact create command without password arguments", () => {
    expect(parseBootstrapCommand([
      "bootstrap", "create",
      "--email", "owner@example.test",
      "--name", "Administrator",
    ])).toEqual({
      mode: "create",
      email: "owner@example.test",
      name: "Administrator",
    });
  });

  it("accepts the exact promotion identity", () => {
    expect(parseBootstrapCommand([
      "bootstrap", "promote",
      "--user-id", "123",
      "--email", "owner@example.test",
    ])).toEqual({
      mode: "promote",
      userId: 123,
      email: "owner@example.test",
    });
  });

  const invalidCommands: string[][] = [
    [],
    ["bootstrap", "delete"],
    ["bootstrap", "create", "--email", "a@b.test"],
    [
      "bootstrap", "create", "--email", "a@b.test",
      "--name", "Admin", "--password", "not-allowed",
    ],
    [
      "bootstrap", "promote", "--user-id", "0",
      "--email", "a@b.test",
    ],
    [
      "bootstrap", "promote", "--user-id", "01",
      "--email", "a@b.test",
    ],
    [
      "bootstrap", "promote", "--user-id", "2147483648",
      "--email", "a@b.test",
    ],
    [
      "bootstrap", "promote", "--user-id", "1.5",
      "--email", "a@b.test",
    ],
    [
      "bootstrap", "promote", "--email", "a@b.test",
      "--user-id", "1",
    ],
  ];

  it.each(invalidCommands.map((args) => ({ args })))(
    "rejects unsupported arguments $args",
    ({ args }) => {
      expect(() => parseBootstrapCommand(args))
        .toThrow("INVALID_BOOTSTRAP_ARGUMENTS");
    },
  );

  function fixture(rows: unknown[]) {
    const query = jest.fn().mockResolvedValue(rows);

    const db = {
      migrations: [
        { name: "First1746824900000" },
        { name: "Second1792831600000" },
      ],
      query,
    } as unknown as DataSource;

    return { db, query };
  }

  const first = {
    timestamp: "1746824900000",
    name: "First1746824900000",
  };

  const second = {
    timestamp: "1792831600000",
    name: "Second1792831600000",
  };

  it("accepts the exact installed migration inventory", async () => {
    const { db, query } = fixture([second, first]);

    await expect(assertBootstrapSchemaReady(db))
      .resolves.toBeUndefined();

    expect(query).toHaveBeenCalledTimes(1);

    expect(query).toHaveBeenCalledWith(
      'SELECT "timestamp"::text AS timestamp, name FROM public.migrations',
    );
  });

  it.each([
    { rows: [] },
    { rows: [first] },
    { rows: [first, first] },
    { rows: [first, { ...second, name: "Unknown1792831600000" }] },
    { rows: [first, second, { ...second, name: "Extra1792831600000" }] },
  ])("rejects incorrect migration inventory %j", async ({ rows }) => {
    const { db } = fixture(rows);

    await expect(assertBootstrapSchemaReady(db))
      .rejects.toThrow("BOOTSTRAP_SCHEMA_NOT_READY");
  });

  it("fails closed without creating the migrations table", async () => {
    const { db, query } = fixture([]);

    query.mockRejectedValueOnce(new Error("relation does not exist"));

    await expect(assertBootstrapSchemaReady(db))
      .rejects.toThrow("BOOTSTRAP_SCHEMA_NOT_READY");

    expect(query).toHaveBeenCalledTimes(1);
  });
});
