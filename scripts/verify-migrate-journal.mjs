/**
 * Guard: `npm run db:migrate` must apply every migration that exists on disk.
 *
 * `scripts/migrate.mjs` takes its list of tags from `drizzle/meta/_journal.json`.
 * A migration file committed to `drizzle/` but missing from the journal is
 * therefore applied by nothing in production — silently. `scripts/test-db.mjs`
 * cannot catch this because it carries its own hardcoded list.
 *
 * This boots a disposable cluster, runs the real migrator against an empty
 * database, and fails if any `drizzle/*.sql` file was skipped.
 *
 *   node scripts/verify-migrate-journal.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = Number(process.env.VERIFY_MIGRATE_PORT ?? 55442);
const DB_NAME = "inkline_migrate_check";
const USER = "postgres";
const PASSWORD = "postgres";

const log = (message) => process.stderr.write(`[verify-migrate] ${message}\n`);

// Every hand-written migration that must end up applied.
const onDisk = readdirSync(join(ROOT, "drizzle"))
  .filter((file) => /^\d{4}_.*\.sql$/.test(file))
  .sort();

const dataDir = mkdtempSync(join(tmpdir(), "inkline-migrate-"));
let pg;
let exitCode = 0;

try {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: true,
    onLog: () => {},
    onError: (message) => process.stderr.write(`[pg] ${message}\n`),
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB_NAME);
  const url = `postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DB_NAME}`;
  log(`cluster up on port ${PORT}`);

  // Migrations 0000-0002 predate the hand-written SQL files and are covered by
  // `drizzle-kit push`; 0003+ are incremental and ALTER the tables they create.
  // So a fresh deploy starts from the generated base schema. Apply it here,
  // which is exactly what scripts/test-db.mjs does.
  const outDir = join(ROOT, ".verify-migrate-schema");
  const configPath = join(ROOT, ".verify-migrate-drizzle.json");
  rmSync(outDir, { recursive: true, force: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      dialect: "postgresql",
      schema: "./src/db/schema/index.ts",
      out: "./.verify-migrate-schema",
    }),
  );
  const gen = spawnSync("npx", ["drizzle-kit", "generate", `--config=${configPath}`, "--name=verifymigrate"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (gen.status !== 0) {
    process.stderr.write(`${gen.stdout ?? ""}${gen.stderr ?? ""}`);
    throw new Error("drizzle-kit generate failed");
  }
  const schemaSql = readdirSync(outDir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(join(outDir, file), "utf8"))
    .join("\n");
  rmSync(outDir, { recursive: true, force: true });
  rmSync(configPath, { force: true });

  const base = pg.getPgClient(DB_NAME);
  await base.connect();
  await base.query("CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS unaccent;");
  await base.query(schemaSql);
  await base.end();
  log("base schema applied (stands in for migrations 0000-0002)");

  // Run the real migrator, exactly as a deploy would.
  const migrate = spawnSync("node", ["scripts/migrate.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: url },
  });
  process.stdout.write(migrate.stdout ?? "");
  if (migrate.stderr) process.stderr.write(migrate.stderr);
  if (migrate.status !== 0) throw new Error(`migrate.mjs exited ${migrate.status}`);

  // What did the migrator actually record?
  const client = pg.getPgClient(DB_NAME);
  await client.connect();
  const applied = new Set(
    (await client.query("SELECT tag FROM schema_migrations")).rows.map((row) => row.tag),
  );
  log(`recorded migrations: ${[...applied].sort().join(", ")}`);

  const missing = onDisk.filter((file) => !applied.has(file.replace(/\.sql$/, "")));
  if (missing.length > 0) {
    process.stderr.write(
      `\nFAIL  these migrations exist on disk but were never applied:\n` +
        missing.map((file) => `        drizzle/${file}`).join("\n") +
        `\n\n      They are missing from drizzle/meta/_journal.json, which is the\n` +
        `      only list scripts/migrate.mjs reads. A production deploy would\n` +
        `      silently ship without them.\n`,
    );
    exitCode = 1;
  } else {
    log(`✓ all ${onDisk.length} migrations on disk were applied`);
  }

  // And the Part 12 tables must physically exist, not merely be recorded.
  const tables = (
    await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE 'search\\_%' ORDER BY table_name`,
    )
  ).rows.map((row) => row.table_name);
  log(`search_* tables present: ${tables.length ? tables.join(", ") : "(none)"}`);
  if (tables.length === 0) {
    process.stderr.write("\nFAIL  no search_* tables exist after migrating.\n");
    exitCode = 1;
  }

  await client.end();
} catch (error) {
  process.stderr.write(`\nFAIL  ${error instanceof Error ? error.message : String(error)}\n`);
  exitCode = 1;
} finally {
  try {
    await pg?.stop();
  } catch {
    /* already down */
  }
  rmSync(dataDir, { recursive: true, force: true });
}

process.exit(exitCode);
