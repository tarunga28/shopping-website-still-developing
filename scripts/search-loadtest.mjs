#!/usr/bin/env node
/**
 * Search load test.
 *
 *   npm run search:loadtest
 *   npm run search:loadtest -- --url http://127.0.0.1:3000 --concurrency 20 --seconds 30
 *
 * Fires concurrent search and autocomplete requests against a running server and
 * reports latency percentiles, throughput, and the error rate.
 *
 * ## Why percentiles and not an average
 *
 * An average latency of 80 ms can hide a p99 of 3 seconds, and the p99 is what a
 * shopper experiences as "search is broken". This script reports p50/p95/p99
 * alongside the mean so the tail is visible.
 *
 * ## What it deliberately does not do
 *
 * It does not measure database CPU or memory — that belongs to your
 * infrastructure monitoring. It measures what the client can observe: response
 * time, throughput, and correctness under concurrency.
 *
 * Requires a running server (`npm run dev` or `npm run start`).
 */

import process from "node:process";

const USAGE = `Usage: npm run search:loadtest -- [options]

  --url <base>          server base URL (default http://127.0.0.1:3000)
  --concurrency <n>     parallel clients (default 10)
  --seconds <n>         run duration (default 15)
  --seed <n>            random seed for reproducibility (default 42)
  -h, --help            show this help`;

function arg(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

const BASE_URL = String(arg("--url", "http://127.0.0.1:3000")).replace(/\/+$/, "");
const CONCURRENCY = Math.max(1, Math.min(Number.parseInt(arg("--concurrency", "10"), 10) || 10, 200));
const DURATION_SECONDS = Math.max(1, Math.min(Number.parseInt(arg("--seconds", "15"), 10) || 15, 300));
const SEED = Number.parseInt(arg("--seed", "42"), 10) || 42;

/**
 * A query mix shaped like real traffic.
 *
 * Weighted towards short, common queries with a tail of long, filtered, and
 * misspelled ones, because that is what production search actually sees. Testing
 * only "shirt" would report a latency the real workload does not have.
 */
const QUERY_MIX = [
  { weight: 18, queries: ["shirt", "tee", "hoodie", "mug", "poster", "cap", "tote"] },
  { weight: 12, queries: ["black shirt", "cotton tee", "gift mug", "new arrival"] },
  { weight: 8, queries: ["organic", "premium", "classic", "vintage", "limited"] },
  { weight: 6, queries: ["shirt under 1000", "gift under 500", "tee below 800"] },
  { weight: 5, queries: ["iphne", "shrit", "hodie", "mugg", "poster"] },
  { weight: 4, queries: ["ink", "line", "ink line", "inkline"] },
  { weight: 3, queries: ["a", "xy", "zzz", "qqqq", "asdf"] },
  { weight: 2, queries: ["best shirt for gifting under 1500 rupees", "cotton tshirt size large black"] },
];

/** Deterministic PRNG so two runs with the same seed produce the same traffic. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const random = makeRandom(SEED);

function pickQuery() {
  const totalWeight = QUERY_MIX.reduce((sum, group) => sum + group.weight, 0);
  let roll = random() * totalWeight;
  for (const group of QUERY_MIX) {
    roll -= group.weight;
    if (roll <= 0) {
      return group.queries[Math.floor(random() * group.queries.length)];
    }
  }
  return QUERY_MIX[0].queries[0];
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index];
}

/**
 * One client loop: issues requests back-to-back for the run duration.
 *
 * Back-to-back rather than on a fixed schedule, because the question is "how much
 * load can this take", and a fixed schedule would under-load a fast server.
 */
async function runClient(label, deadline, stats) {
  while (Date.now() < deadline) {
    const useAutocomplete = random() < 0.3;
    const query = pickQuery();
    const url = useAutocomplete
      ? `${BASE_URL}/api/search/suggestions?q=${encodeURIComponent(query.slice(0, 4))}&limit=8`
      : `${BASE_URL}/api/search?q=${encodeURIComponent(query)}&limit=24&sort=relevance`;

    const startedAt = process.hrtime.bigint();
    try {
      const response = await fetch(url);
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const kind = useAutocomplete ? "autocomplete" : "search";

      // The body is consumed even on success: an unread body leaves the socket
      // unusable and would distort the throughput figure.
      await response.text();

      if (response.ok) {
        stats[kind].ok += 1;
        stats[kind].latencies.push(elapsedMs);
      } else if (response.status === 429) {
        // Rate limited. Counted separately from errors because this is the
        // limiter working as designed, not a failure of the search path.
        stats[kind].rateLimited += 1;
      } else {
        stats[kind].errors += 1;
        stats[kind].statusCodes[response.status] = (stats[kind].statusCodes[response.status] ?? 0) + 1;
      }
      stats[kind].total += 1;
    } catch {
      const bucket = useAutocomplete ? "autocomplete" : "search";
      stats[bucket].errors += 1;
      stats[bucket].total += 1;
    }
  }
  void label;
}

async function main() {
  console.log(`Search load test → ${BASE_URL}`);
  console.log(`  concurrency ${CONCURRENCY}  duration ${DURATION_SECONDS}s  seed ${SEED}`);
  console.log("");

  // Fail fast with a clear message rather than reporting 100% errors.
  try {
    const probe = await fetch(`${BASE_URL}/api/health`);
    if (!probe.ok) throw new Error(`health check returned ${probe.status}`);
  } catch (error) {
    console.error(`Cannot reach ${BASE_URL}: ${error instanceof Error ? error.message : error}`);
    console.error("Start the server first:  npm run dev");
    process.exit(1);
  }

  const stats = {
    search: { total: 0, ok: 0, errors: 0, rateLimited: 0, latencies: [], statusCodes: {} },
    autocomplete: { total: 0, ok: 0, errors: 0, rateLimited: 0, latencies: [], statusCodes: {} },
  };

  const startedAt = Date.now();
  const deadline = startedAt + DURATION_SECONDS * 1000;

  const clients = Array.from({ length: CONCURRENCY }, (_unused, index) =>
    runClient(`client-${index}`, deadline, stats),
  );
  await Promise.all(clients);

  const elapsedSeconds = (Date.now() - startedAt) / 1000;

  for (const kind of ["search", "autocomplete"]) {
    const bucket = stats[kind];
    const sorted = [...bucket.latencies].sort((a, b) => a - b);
    const mean = sorted.length
      ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length
      : 0;
    const errorRate = bucket.total === 0 ? 0 : bucket.errors / bucket.total;

    console.log(`${kind.toUpperCase()}`);
    console.log(`  requests    ${bucket.total.toLocaleString("en-IN")}`);
    console.log(`  served      ${bucket.ok.toLocaleString("en-IN")} (${(bucket.ok / elapsedSeconds).toFixed(1)} req/s)`);
    console.log(`  rate-limited ${bucket.rateLimited.toLocaleString("en-IN")}`);
    console.log(`  errors      ${bucket.errors} (${(errorRate * 100).toFixed(2)}%)`);
    if (Object.keys(bucket.statusCodes).length > 0) {
      console.log(
        `  statuses    ${Object.entries(bucket.statusCodes)
          .map(([code, count]) => `${code}×${count}`)
          .join(", ")}`,
      );
    }
    if (sorted.length > 0) {
      // Measured over served requests only. Latency of a rejected request says
      // nothing about the search path.
      console.log(`  latency     min ${sorted[0].toFixed(1)} ms  p50 ${percentile(sorted, 0.5).toFixed(1)} ms   (served only)`);
      console.log(`              p95 ${percentile(sorted, 0.95).toFixed(1)} ms  p99 ${percentile(sorted, 0.99).toFixed(1)} ms`);
      console.log(`              max ${sorted[sorted.length - 1].toFixed(1)} ms  mean ${mean.toFixed(1)} ms  over ${sorted.length} samples`);
    }
    console.log("");
  }

  const totalErrors = stats.search.errors + stats.autocomplete.errors;
  const totalServed = stats.search.ok + stats.autocomplete.ok;
  const totalLimited = stats.search.rateLimited + stats.autocomplete.rateLimited;
  const totalRequests = stats.search.total + stats.autocomplete.total;
  const errorRate = totalRequests === 0 ? 0 : totalErrors / totalRequests;

  console.log(`Overall: ${totalRequests.toLocaleString("en-IN")} requests in ${elapsedSeconds.toFixed(1)}s`);
  console.log(`  served       ${totalServed.toLocaleString("en-IN")} (${(totalServed / elapsedSeconds).toFixed(1)} req/s)`);
  console.log(`  rate-limited ${totalLimited.toLocaleString("en-IN")}`);
  console.log(`  errors       ${totalErrors} (${(errorRate * 100).toFixed(2)}%)`);

  if (totalLimited > 0) {
    console.log(
      `\nNote: ${totalLimited} requests were rate-limited. The per-IP limit ` +
        `(search 60/min, autocomplete 180/min) is the binding constraint at this ` +
        `concurrency, so "served req/s" reflects the limiter, not the engine.\n` +
        `To measure engine throughput, start the server with ` +
        `SEARCH_LOADTEST=200 (the value is the limit multiplier), which relaxes ` +
        `those limits for the run.`,
    );
  }

  // A load test that reports success while requests are failing is worse than no
  // load test, so a real error rate above 1% is a non-zero exit. Rate limiting is
  // excluded: it is a configured protection, not a fault.
  if (errorRate > 0.01) {
    console.error("\nError rate above 1% — investigate before trusting the latency numbers.");
    process.exitCode = 1;
  }
  if (totalServed < 10) {
    console.error("\nToo few served requests to report meaningful latency.");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
