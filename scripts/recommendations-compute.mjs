#!/usr/bin/env node
/**
 * Recommendation offline jobs (§49, §72).
 *
 * Everything the recommender needs that is too expensive to compute during a
 * page render: product similarity, the co-purchase matrix, popularity and
 * trending scores, interest profiles, and the daily metrics rollup.
 *
 *   npm run recommendations:compute                # everything
 *   npm run recommendations:compute -- --only similarity
 *   npm run recommendations:compute -- --only co-purchase
 *   npm run recommendations:compute -- --only popularity
 *   npm run recommendations:compute -- --only profiles
 *   npm run recommendations:compute -- --only metrics
 *   npm run recommendations:compute -- --coverage   # report table coverage
 *
 * Options:
 *   --only <stage>       run one stage instead of all
 *   --batch-size <n>     products per similarity batch (default 200)
 *   --window-days <n>    popularity / co-purchase window (default 30 / 90)
 *   --limit <n>          profile / metric batch bound
 *
 * Every stage is idempotent and independently retryable. A stage that fails is
 * reported and the run exits non-zero, but the other stages still complete —
 * a stale similarity matrix with fresh popularity is far more useful than
 * nothing, and a cron job that aborts on the first error never catches up.
 */

const USAGE = `
Recommendation offline jobs.

  npm run recommendations:compute
  npm run recommendations:compute -- --only similarity --batch-size 500
  npm run recommendations:compute -- --only co-purchase --window-days 120
  npm run recommendations:compute -- --coverage

Stages: similarity, co-purchase, popularity, profiles, metrics
`.trim();

const args = process.argv.slice(2);

function arg(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
const has = (name) => args.includes(name);

if (has("--help") || has("-h")) {
  console.log(USAGE);
  process.exit(0);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

// The services are TypeScript and guarded by `server-only`, which throws outside
// the Next.js runtime. tsconfig maps that path for type-checking, but tsx does
// not apply tsconfig paths at runtime, so resolve it here to the same stub the
// test suite uses. Without this the CLI cannot import the services at all.
const { createRequire } = await import("node:module");
const { fileURLToPath } = await import("node:url");
const require_ = createRequire(import.meta.url);
const Module = require_("node:module");
const serverOnlyStub = fileURLToPath(new URL("../tests/mocks/server-only.ts", import.meta.url));
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function patched(request, ...rest) {
  if (request === "server-only") return serverOnlyStub;
  return originalResolve.call(this, request, ...rest);
};

const { db } = await import("../src/db/index.ts");
const compute = await import("../src/services/recommendations/compute.service.ts");
const profiles = await import("../src/services/recommendations/profile.service.ts");
const metrics = await import("../src/services/recommendations/metrics.service.ts");
const events = await import("../src/services/recommendations/events.service.ts");
const settings = await import("../src/services/recommendations/config.service.ts");

const only = arg("--only");
const batchSize = Number.parseInt(arg("--batch-size") ?? "200", 10);
const windowDays = Number.parseInt(arg("--window-days") ?? "30", 10);
const limit = Number.parseInt(arg("--limit") ?? "500", 10);

const STAGES = ["similarity", "co-purchase", "popularity", "profiles", "metrics"];
if (only && !STAGES.includes(only)) {
  console.error(`Unknown stage: ${only}\n\nValid stages: ${STAGES.join(", ")}`);
  process.exit(1);
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Run one stage, reporting its result. Never throws — a failing stage must not abort the batch. */
async function runStage(name, run) {
  const startedAt = Date.now();
  process.stdout.write(`· ${name} … `);
  try {
    const result = await run();
    const summary =
      typeof result === "number" ? `${result}` : `wrote ${result.wrote}, skipped ${result.skipped}`;
    process.stdout.write(`${summary} (${formatDuration(Date.now() - startedAt)})\n`);
    return { name, ok: true, ...(typeof result === "number" ? { wrote: result } : result) };
  } catch (error) {
    process.stdout.write(`FAILED (${formatDuration(Date.now() - startedAt)})\n`);
    console.error(`  ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return { name, ok: false };
  }
}

const runAll = !only;
const shouldRun = (stage) => runAll || only === stage;
const results = [];
const startedAt = Date.now();

console.log("Recommendation offline compute\n");

if (has("--coverage")) {
  const coverage = await compute.computeCoverage(db);
  console.log("Precomputed-table coverage:");
  console.log(`  searchable products   ${coverage.products}`);
  console.log(`  with similarity       ${coverage.withSimilarity} (${(coverage.similarityCoverage * 100).toFixed(1)}%)`);
  console.log(`  with co-purchase      ${coverage.withCoPurchase} (${(coverage.coPurchaseCoverage * 100).toFixed(1)}%)`);
  console.log(`  with popularity       ${coverage.withPopularity} (${(coverage.popularityCoverage * 100).toFixed(1)}%)`);
  if (coverage.similarityCoverage < 0.5) {
    console.log("\n  note: similarity coverage is low, so most requests will fall back to");
    console.log("  on-the-fly content similarity. Run the similarity stage to fix this.");
  }
  if (!only) process.exit(0);
}

if (shouldRun("similarity")) {
  results.push(
    await runStage("product similarity", () =>
      compute.computeSimilarity({ client: db, batchSize }),
    ),
  );
}

if (shouldRun("co-purchase")) {
  results.push(
    await runStage("co-purchase matrix", () =>
      compute.computeCoPurchases({ client: db, windowDays: Math.max(windowDays, 30) }),
    ),
  );
}

if (shouldRun("popularity")) {
  results.push(
    await runStage("popularity & trending", () => compute.computePopularity({ client: db, windowDays })),
  );
}

if (shouldRun("profiles")) {
  results.push(
    await runStage("interest profiles", () => profiles.rebuildProfiles({ client: db, limit })),
  );
}

if (shouldRun("metrics")) {
  // Roll up yesterday and today: yesterday is complete, today is still
  // accumulating, and an admin opening the dashboard mid-day should see
  // current numbers rather than a gap.
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  results.push(
    await runStage("metrics rollup", async () => {
      const a = await metrics.rollUpMetrics({ date: yesterday, client: db });
      const b = await metrics.rollUpMetrics({ date: today, client: db });
      return a + b;
    }),
  );
}

// ── Retention ────────────────────────────────────────────────────────────
// Pruning runs as part of the batch rather than as its own cron entry, because
// a table that grows without bound is a problem the same job that fills it
// should prevent. Bounded per run so a large backlog cannot make one nightly
// run take hours.
if (runAll) {
  const retentionDays = (await settings.getSettings(db).catch(() => null))?.retentionDays ?? 180;
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  results.push(
    await runStage("retention prune", async () => {
      const prunedEvents = await events.pruneOldEvents({ olderThan: cutoff, client: db });
      const prunedRecEvents = await metrics.pruneRecommendationEvents({ olderThan: cutoff, client: db });
      const prunedRequests = await metrics.pruneRecommendationRequests({ olderThan: cutoff, client: db });
      const prunedSessions = await profiles.pruneSessionProfiles({ olderThan: cutoff, client: db });
      return prunedEvents + prunedRecEvents + prunedRequests + prunedSessions;
    }),
  );
}

const failed = results.filter((result) => !result.ok);
const totalMs = Date.now() - startedAt;

console.log(`\nDone in ${formatDuration(totalMs)}.`);
if (failed.length > 0) {
  console.error(`\n${failed.length} stage(s) failed: ${failed.map((result) => result.name).join(", ")}`);
  console.error("The remaining stages completed. Re-running this job is safe — every stage is idempotent.");
  process.exitCode = 1;
}

await db.$client.end().catch(() => undefined);
