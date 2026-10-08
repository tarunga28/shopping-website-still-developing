/**
 * Prove `drizzle/0007_search_discovery.sql` actually builds the Part 12 schema.
 *
 * `npm run db:parity` cannot prove this. Its baseline database is generated
 * from the current Drizzle schema, which already contains `src/db/schema/
 * search.ts` — so every `CREATE TABLE IF NOT EXISTS` in 0007 is a no-op there,
 * and parity would pass against an empty or wrong file.
 *
 * This check instead builds the *pre-Part-12* database (the current schema with
 * `search.ts` removed from the barrel, and the Part 12 columns/indexes absent),
 * applies 0006 then 0007, and diffs the result against the real schema. Any
 * difference is a statement in 0007 that is missing or wrong.
 *
 *   node scripts/verify-0007.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = Number(process.env.VERIFY_0007_PORT ?? 55443);
const USER = "postgres";
const PASSWORD = "postgres";

const log = (m) => process.stderr.write(`[verify-0007] ${m}\n`);
let exitCode = 0;

/** Collect the fact set (columns, indexes, constraints) of a database. */
async function facts(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const out = new Set();
  const columns = await client.query(`
    SELECT table_name, column_name, data_type, is_nullable, coalesce(column_default,'') AS d
      FROM information_schema.columns WHERE table_schema='public'`);
  for (const r of columns.rows) {
    out.add(`column:${r.table_name}.${r.column_name}|${r.data_type}|${r.is_nullable}|${r.d}`);
  }
  const indexes = await client.query(`SELECT indexdef FROM pg_indexes WHERE schemaname='public'`);
  for (const r of indexes.rows) {
    out.add(`index:${r.indexdef.replace(/"/g, "").replace(/public\./g, "").replace(/\s+/g, " ").trim().toLowerCase()}`);
  }
  const checks = await client.query(`
    SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE connamespace='public'::regnamespace`);
  for (const r of checks.rows) {
    out.add(`constraint:${r.t}.${r.conname}|${r.def.replace(/\s+/g, " ").trim().toLowerCase()}`);
  }
  await client.end();
  return out;
}

/** Generate DDL for a schema directory into a scratch folder. */
function generateDDL(schemaDir, outDir, name) {
  rmSync(outDir, { recursive: true, force: true });
  const configPath = join(ROOT, `.verify0007-${name}.json`);
  writeFileSync(configPath, JSON.stringify({ dialect: "postgresql", schema: schemaDir, out: `./${outDir.replace(ROOT + "/", "")}` }));
  const gen = spawnSync("npx", ["drizzle-kit", "generate", `--config=${configPath}`, `--name=${name}`], {
    cwd: ROOT, encoding: "utf8",
  });
  rmSync(configPath, { force: true });
  if (gen.status !== 0) throw new Error(`drizzle-kit generate failed for ${name}: ${gen.stdout}${gen.stderr}`);
  return readdirSync(outDir).filter((f) => f.endsWith(".sql")).sort()
    .map((f) => readFileSync(join(outDir, f), "utf8")).join("\n");
}

const dataDir = mkdtempSync(join(tmpdir(), "inkline-0007-"));
let pgServer;

try {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  pgServer = new EmbeddedPostgres({
    databaseDir: dataDir, user: USER, password: PASSWORD, port: PORT,
    persistent: true, onLog: () => {}, onError: (m) => process.stderr.write(`[pg] ${m}\n`),
  });
  await pgServer.initialise();
  await pgServer.start();
  await pgServer.createDatabase("target");
  await pgServer.createDatabase("expected");
  const targetUrl = `postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/target`;
  const expectedUrl = `postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/expected`;
  log("cluster up");

  // ── Build the pre-Part-12 schema: current tables minus search.ts ──────────
  const staging = join(ROOT, ".verify0007-base");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  for (const file of readdirSync(join(ROOT, "src/db/schema"))) {
    if (file === "search.ts" || file === "index.ts") continue;
    writeFileSync(join(staging, file), readFileSync(join(ROOT, "src/db/schema", file), "utf8"));
  }
  // Barrel without the Part 12 module.
  writeFileSync(
    join(staging, "index.ts"),
    readdirSync(staging).filter((f) => f.endsWith(".ts") && f !== "index.ts")
      .map((f) => `export * from "./${f.replace(/\.ts$/, "")}";`).join("\n") + "\n",
  );

  const baseSql = generateDDL(staging, join(ROOT, ".verify0007-out-base"), "base");
  rmSync(staging, { recursive: true, force: true });

  // Strip the Part 12 columns/indexes that 0006-era product_search_index and
  // search_query_logs did not have, so 0007's ALTERs are exercised for real.
  const PART12_LOG_COLS = ["corrected_query", "was_corrected", "ranking_version", "experiment_variant", "filter_signature"];
  const baseLines = baseSql.split("\n").filter((line) => {
    if (/search_query_logs_version_time_idx|product_search_index_(facet_brand|facet_category|rating|updated)_idx/.test(line)) return false;
    for (const col of PART12_LOG_COLS) {
      if (new RegExp(`^\\s*"${col}"\\s`).test(line)) return false;
    }
    return true;
  });

  const client = pgServer.getPgClient("target");
  await client.connect();
  await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS unaccent;");
  await client.query(baseLines.join("\n"));
  log("pre-Part-12 schema applied (search.ts excluded, Part 12 columns stripped)");

  // Sanity: the Part 12 tables must genuinely be absent before we run 0007.
  const before = (await client.query(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN
      ('search_vocabulary','search_history','search_events','search_ranking_configs','search_experiments','search_settings')`,
  )).rows[0].n;
  await client.end();
  if (before !== 0) throw new Error(`baseline already had ${before} Part 12 tables — the test proves nothing`);
  log("confirmed: 0 of 6 Part 12 tables present before 0007");

  // ── Apply the migrations under test ───────────────────────────────────────
  for (const file of ["0006_product_intelligence.sql", "0007_search_discovery.sql"]) {
    const c = pgServer.getPgClient("target");
    await c.connect();
    await c.query(readFileSync(join(ROOT, "drizzle", file), "utf8"));
    await c.end();
    log(`applied ${file}`);
  }

  // ── Expected: the real, current schema ────────────────────────────────────
  const expectedSql = generateDDL("./src/db/schema/index.ts", join(ROOT, ".verify0007-out-exp"), "expected");
  const ec = pgServer.getPgClient("expected");
  await ec.connect();
  await ec.query("CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS unaccent;");
  await ec.query(expectedSql);
  await ec.end();

  const got = await facts(targetUrl);
  const want = await facts(expectedUrl);

  const missing = [...want].filter((f) => !got.has(f)).sort();
  const extra = [...got].filter((f) => !want.has(f)).sort();

  if (missing.length || extra.length) {
    process.stderr.write(`\n✗ 0007 does not reproduce the Part 12 schema.\n`);
    if (missing.length) {
      process.stderr.write(`\n  Missing (${missing.length}):\n`);
      for (const f of missing.slice(0, 40)) process.stderr.write(`    - ${f}\n`);
    }
    if (extra.length) {
      process.stderr.write(`\n  Unexpected (${extra.length}):\n`);
      for (const f of extra.slice(0, 40)) process.stderr.write(`    + ${f}\n`);
    }
    exitCode = 1;
  } else {
    log(`✓ 0006 + 0007 rebuild the Part 12 schema exactly (${want.size} facts, 0 drift)`);
  }
} catch (error) {
  process.stderr.write(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`);
  exitCode = 1;
} finally {
  for (const dir of [".verify0007-out-base", ".verify0007-out-exp", ".verify0007-base"]) {
    rmSync(join(ROOT, dir), { recursive: true, force: true });
  }
  try { await pgServer?.stop(); } catch { /* down */ }
  rmSync(dataDir, { recursive: true, force: true });
}

process.exit(exitCode);
