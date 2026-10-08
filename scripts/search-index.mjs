#!/usr/bin/env node
/**
 * Search index management CLI.
 *
 *   npm run search:index              rebuild the whole catalog index
 *   npm run search:index -- --queue   drain the pending catalog-event queue
 *   npm run search:index -- --derived rebuild vocabulary + suggestions
 *   npm run search:index -- --category <id>
 *   npm run search:index -- --brand <id>
 *   npm run search:index -- --status
 *   npm run search:index -- --product <id>
 *
 * Progress is printed as it happens. On a large catalog a command that produces
 * no output looks hung, and "looks hung" is how an operator kills a reindex at
 * 80% and leaves the index half-built.
 *
 * Requires DATABASE_URL. Run `npm run db:migrate` first if the schema is new.
 */

import process from "node:process";

const USAGE = `Usage: npm run search:index -- [options]

  --status              show index health and exit
  --queue [batchSize]   drain the pending catalog-event queue
  --derived             rebuild the correction vocabulary and suggestion table
  --category <id>       reindex one category subtree
  --brand <id>          reindex one brand's products
  --product <id>        reindex a single product
  --batch-size <n>      products per batch (default 500)
  -h, --help            show this help

With no options, rebuilds the entire catalog index.`;

function arg(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function has(flag) {
  return process.argv.includes(flag);
}

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
const indexService = await import("../src/services/search/index.service.ts");
const { indexProduct } = await import("../src/services/catalog/search.service.ts");
const { logger } = await import("../src/lib/logger.ts");

const batchSize = Number.parseInt(arg("--batch-size") ?? "500", 10);

function formatDuration(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function progressLine(done, total, startedAt) {
  const elapsed = Date.now() - startedAt;
  const rate = done > 0 ? elapsed / done : 0;
  const remaining = rate * (total - done);
  const percent = total === 0 ? 100 : ((done / total) * 100).toFixed(1);
  process.stdout.write(
    `\r  ${done.toLocaleString("en-IN")}/${total.toLocaleString("en-IN")} (${percent}%)  ` +
      `elapsed ${formatDuration(elapsed)}  remaining ~${formatDuration(Math.round(remaining))}   `,
  );
}

async function main() {
  // ── status ─────────────────────────────────────────────────────────────
  if (has("--status")) {
    const [status, stale] = await Promise.all([
      indexService.indexStatus(db),
      indexService.countUnindexed(db),
    ]);
    console.log("Search index status");
    console.log(`  products          ${status.products.toLocaleString("en-IN")}`);
    console.log(`  indexed           ${status.indexedProducts.toLocaleString("en-IN")}`);
    console.log(`  searchable        ${status.searchableProducts.toLocaleString("en-IN")}`);
    console.log(`  stale             ${status.staleProducts.toLocaleString("en-IN")}`);
    console.log(`  missing rows      ${stale.toLocaleString("en-IN")}`);
    console.log(`  pending events    ${status.pendingEvents.toLocaleString("en-IN")}`);
    console.log(`  failed events     ${status.failedEvents.toLocaleString("en-IN")}`);
    console.log(`  last indexed at   ${status.lastIndexedAt ? status.lastIndexedAt.toISOString() : "never"}`);
    return;
  }

  // ── single product ─────────────────────────────────────────────────────
  const productId = arg("--product");
  if (productId) {
    const result = await indexProduct(productId, db);
    console.log(result.indexed ? `Indexed ${productId}` : `Removed ${productId} from the index (not publicly listed)`);
    return;
  }

  // ── event queue ────────────────────────────────────────────────────────
  if (has("--queue")) {
    console.log("Draining the catalog-event queue…");
    const result = await indexService.processIndexQueue({ batchSize, client: db });
    console.log(
      `  claimed ${result.claimed}  processed ${result.processed}  ` +
        `failed ${result.failed}  skipped ${result.skipped}  in ${formatDuration(result.tookMs)}`,
    );
    return;
  }

  // ── derived indexes ────────────────────────────────────────────────────
  if (has("--derived")) {
    console.log("Rebuilding the correction vocabulary and suggestion table…");
    const result = await indexService.refreshDerivedIndexes({ client: db });
    console.log(`  vocabulary terms   ${result.vocabularyTerms.toLocaleString("en-IN")}`);
    console.log(`  suggestion rows    ${result.suggestionRows.toLocaleString("en-IN")}`);
    console.log(`  observed terms     ${result.observedTerms.toLocaleString("en-IN")}`);
    console.log(`  took ${formatDuration(result.tookMs)}`);
    return;
  }

  // ── category / brand ───────────────────────────────────────────────────
  const categoryId = arg("--category");
  if (categoryId) {
    console.log(`Reindexing category ${categoryId} and its subtree…`);
    const result = await indexService.reindexCategory(categoryId, { client: db });
    console.log(`  indexed ${result.indexed.toLocaleString("en-IN")} products`);
    return;
  }

  const brandId = arg("--brand");
  if (brandId) {
    console.log(`Reindexing brand ${brandId}…`);
    const result = await indexService.reindexBrand(brandId, { client: db });
    console.log(`  indexed ${result.indexed.toLocaleString("en-IN")} products`);
    return;
  }

  // ── full rebuild ───────────────────────────────────────────────────────
  console.log(`Reindexing the whole catalog in batches of ${batchSize}…`);
  const startedAt = Date.now();
  const result = await indexService.reindexCatalog({
    batchSize,
    client: db,
    onProgress: ({ done, total }) => progressLine(done, total, startedAt),
  });
  process.stdout.write("\n");

  console.log(`  indexed   ${result.indexed.toLocaleString("en-IN")}`);
  console.log(`  failed    ${result.failed.toLocaleString("en-IN")}`);
  console.log(`  pending   ${result.pending.toLocaleString("en-IN")}`);
  console.log(`  took ${formatDuration(result.tookMs)}`);

  if (result.failed > 0) {
    console.error("\nSome products could not be indexed. See the log output above for ids.");
    process.exitCode = 1;
  }
}

// Silence the request-scoped logger's noise during a bulk run; errors still
// surface because they are written by the services, not by this script.
logger.debug = () => {};

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // The pool keeps the process alive; without this the CLI never exits.
    await db.$client?.end?.().catch(() => undefined);
  });
