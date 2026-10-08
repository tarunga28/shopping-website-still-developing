/**
 * Apply every committed SQL migration, in `_journal.json` order.
 *
 * The migrations in `drizzle/*.sql` are hand-written and idempotent, so this
 * runner is intentionally simple: it records what it has applied in
 * `schema_migrations` and skips those on later runs, but re-running a migration
 * is safe by construction.
 *
 *   DATABASE_URL=postgresql://… npm run db:migrate
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";

const ROOT = resolve(import.meta.dirname, "..");
const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write("DATABASE_URL is required (see .env.example).\n");
  process.exit(1);
}

const journal = JSON.parse(readFileSync(join(ROOT, "drizzle/meta/_journal.json"), "utf8"));
const tags = journal.entries.map((entry) => entry.tag);

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      tag text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const applied = new Set(
    (await client.query("SELECT tag FROM schema_migrations")).rows.map((row) => row.tag),
  );

  let run = 0;
  for (const tag of tags) {
    // 0000–0002 predate the hand-written SQL files; `db:push` covers them.
    const file = join(ROOT, "drizzle", `${tag}.sql`);
    if (!existsSync(file)) {
      process.stdout.write(`· ${tag} (no SQL file — covered by drizzle-kit push)\n`);
      continue;
    }
    if (applied.has(tag)) {
      process.stdout.write(`· ${tag} (already applied)\n`);
      continue;
    }
    const sql = readFileSync(file, "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (tag) VALUES ($1) ON CONFLICT DO NOTHING", [tag]);
      await client.query("COMMIT");
      process.stdout.write(`✓ ${tag}\n`);
      run += 1;
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`${tag}: ${error.message}`);
    }
  }
  process.stdout.write(run === 0 ? "Database is up to date.\n" : `Applied ${run} migration(s).\n`);
} finally {
  await client.end();
}
