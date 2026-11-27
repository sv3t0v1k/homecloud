import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { DataSource } from "typeorm";

import database from "../data-source";
import { assertInheritedRootFence } from "../uploads/inherited-root-fence";
import {
  AdminBootstrapError,
  AdminBootstrapRequest,
  bootstrapAdmin,
  validInitialPassword,
} from "./admin-bootstrap";

export type BootstrapCommand =
  | { mode: "create"; email: string; name: string }
  | { mode: "promote"; userId: number; email: string };

export class BootstrapCliError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "BootstrapCliError";
  }
}

function invalidArguments(): never {
  throw new BootstrapCliError("INVALID_BOOTSTRAP_ARGUMENTS");
}

export function parseBootstrapCommand(
  args: string[],
): BootstrapCommand {
  if (args.length !== 6 || args[0] !== "bootstrap") {
    invalidArguments();
  }

  if (
    args[1] === "create" &&
    args[2] === "--email" &&
    args[4] === "--name" &&
    args[3].length > 0 &&
    args[5].length > 0
  ) {
    return {
      mode: "create",
      email: args[3],
      name: args[5],
    };
  }

  if (
    args[1] === "promote" &&
    args[2] === "--user-id" &&
    args[4] === "--email" &&
    /^[1-9][0-9]*$/.test(args[3]) &&
    args[5].length > 0
  ) {
    const userId = Number(args[3]);

    if (!Number.isSafeInteger(userId) || userId > 2147483647) {
      invalidArguments();
    }

    return {
      mode: "promote",
      userId,
      email: args[5],
    };
  }

  return invalidArguments();
}

/**
 * Read-only migration inventory check.
 *
 * Do not use TypeORM showMigrations(): it may create the migrations
 * table on an uninitialized database.
 */
export async function assertBootstrapSchemaReady(
  db: DataSource,
): Promise<void> {
  const expected = db.migrations.map(
    (migration) => migration.name || migration.constructor.name,
  ).map((name) => {
    const timestamp = name.slice(-13);

    if (!/^[0-9]{13}$/.test(timestamp)) {
      throw new BootstrapCliError("BOOTSTRAP_SCHEMA_NOT_READY");
    }

    return `${timestamp}:${name}`;
  }).sort();

  if (
    expected.length === 0 ||
    new Set(expected).size !== expected.length
  ) {
    throw new BootstrapCliError("BOOTSTRAP_SCHEMA_NOT_READY");
  }

  let actual: string[];

  try {
    const rows = await db.query(
      'SELECT "timestamp"::text AS timestamp, name FROM public.migrations',
    ) as { timestamp: string; name: string }[];

    actual = rows.map(
      (row) => `${row.timestamp}:${row.name}`,
    ).sort();
  } catch {
    throw new BootstrapCliError("BOOTSTRAP_SCHEMA_NOT_READY");
  }

  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new BootstrapCliError("BOOTSTRAP_SCHEMA_NOT_READY");
  }
}

export async function readConfirmedPassword(): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new BootstrapCliError("BOOTSTRAP_TTY_REQUIRED");
  }

  // Readline handles raw-mode input and restores the terminal on close.
  // Its output is discarded, so neither typing nor editing is echoed.
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

  const reader = createInterface({
    input: process.stdin,
    output: muted,
    terminal: true,
    historySize: 0,
  });

  const cancel = () => reader.close();

  reader.on("SIGINT", cancel);
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);

  function ask(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const onClose = () => {
        reject(new BootstrapCliError("BOOTSTRAP_INPUT_CANCELLED"));
      };

      reader.once("close", onClose);

      process.stderr.write(prompt);

      reader.question("", (answer) => {
        reader.off("close", onClose);
        process.stderr.write(String.fromCharCode(10));
        resolve(answer);
      });
    });
  }

  try {
    return await readMatchingPassword(ask);
  } finally {
    reader.close();
    reader.off("SIGINT", cancel);
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    muted.end();
  }
}

export async function readMatchingPassword(ask: (prompt: string) => Promise<string>): Promise<string> {
  for (;;) {
    const password = await ask("New administrator password: ");
    const confirmation = await ask("Repeat administrator password: ");
    if (password !== confirmation) {
      process.stderr.write("Passwords do not match; try again.\n");
    } else if (validInitialPassword(password)) {
      return password;
    } else {
      process.stderr.write("Password must be 12 or more characters, at most 72 UTF-8 bytes, and contain no NUL; try again.\n");
    }
  }
}

function assertDatabaseConfigured(): void {
  try {
    const value = process.env.DATABASE_URL;

    if (!value) {
      throw new Error();
    }

    const url = new URL(value);

    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      !url.pathname ||
      url.pathname === "/"
    ) {
      throw new Error();
    }
  } catch {
    throw new BootstrapCliError("BOOTSTRAP_DATABASE_NOT_CONFIGURED");
  }
}

export async function runBootstrapCli(
  args: string[],
): Promise<void> {
  const command = parseBootstrapCommand(args);

  // Never admit a direct, unfenced invocation, including on macOS.
  assertInheritedRootFence();

  if (
    command.mode === "create" &&
    (!process.stdin.isTTY || !process.stderr.isTTY)
  ) {
    throw new BootstrapCliError("BOOTSTRAP_TTY_REQUIRED");
  }

  assertDatabaseConfigured();

  // Explicitly prohibit schema changes during CLI initialization.
  // PostgreSQL's automatic extension installation is disabled too.
  database.setOptions({
    schema: "public",
    synchronize: false,
    migrationsRun: false,
    installExtensions: false,
    logging: false,
    extra: {
      options: "-c search_path=public",
      connectionTimeoutMillis: 10000,
    },
  });

  try {
    await database.initialize();

    await assertBootstrapSchemaReady(database);

    const request: AdminBootstrapRequest =
      command.mode === "create"
        ? {
            ...command,
            password: await readConfirmedPassword(),
          }
        : command;

    const result = await bootstrapAdmin(database, request);

    // Deliberate allowlist: never print credentials or DB details.
    process.stdout.write(
      JSON.stringify({
        status: result.status,
        userId: result.userId,
        email: result.email,
        role: result.role,
      }) + String.fromCharCode(10),
    );
  } finally {
    if (database.isInitialized) {
      await database.destroy();
    }
  }
}

if (require.main === module) {
  runBootstrapCli(process.argv.slice(2)).catch((error: unknown) => {
    const code =
      error instanceof BootstrapCliError ||
      error instanceof AdminBootstrapError
        ? error.code
        : "BOOTSTRAP_FAILED";

    // Raw database errors may contain queries or credentials.
    // Only allowlisted domain/CLI codes are written to the terminal.
    process.stderr.write(
      "STOP: " + code + String.fromCharCode(10),
    );

    process.exitCode = 1;
  });
}
