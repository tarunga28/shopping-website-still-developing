import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { searchExperiments, searchRankingConfigs, searchSettings } from "@/db/schema";
import type { DbClient } from "@/db/utils";
import { withTransaction } from "@/db/utils";
import {
  DEFAULT_RANKING_CONFIG,
  parseRankingConfig,
  assertLayerBalance,
  parseWeights,
} from "@/lib/search/ranking";
import type { RankingConfig, RankingWeights } from "@/lib/search/types";
import { logger } from "@/lib/logger";

/**
 * Ranking configuration and experiment bucketing.
 *
 * The invariant this module protects: **search always has a ranking
 * configuration.** A missing, malformed, or unbalanced configuration falls back
 * to the compiled-in default and is logged, because a relevance change that
 * breaks loading must degrade search rather than take it down.
 */

let cached: { config: RankingConfig; loadedAt: number } | null = null;
const CACHE_TTL_MS = 30_000;

/**
 * The active ranking configuration.
 *
 * Never throws. If the database has no usable row, the compiled-in v1 default is
 * returned so that a fresh install or a botched admin edit cannot break search.
 */
export async function getActiveRankingConfig(client: DbClient = db): Promise<RankingConfig> {
  const now = Date.now();
  if (cached && now - cached.loadedAt < CACHE_TTL_MS) return cached.config;

  try {
    const [row] = await client
      .select()
      .from(searchRankingConfigs)
      .where(eq(searchRankingConfigs.isActive, true))
      .limit(1);

    if (!row) {
      logger.warn("no active search ranking configuration; using compiled-in defaults");
      return DEFAULT_RANKING_CONFIG;
    }

    const { config, errors } = parseRankingConfig(row);
    if (errors.length) {
      logger.error(`ranking configuration "${row.version}" is invalid; using defaults`, {
        errors,
        version: row.version,
      });
      return DEFAULT_RANKING_CONFIG;
    }

    const balance = assertLayerBalance(config.weights);
    if (balance.length) {
      // Not fatal, but it is exactly the mistake that silently turns search into
      // a bestseller list, so it is logged at error level.
      logger.error(`ranking configuration "${config.version}" is unbalanced`, { problems: balance });
    }

    cached = { config, loadedAt: now };
    return config;
  } catch (error) {
    logger.error("could not load the ranking configuration; using defaults", {
      error: error instanceof Error ? error.message : String(error),
    });
    return DEFAULT_RANKING_CONFIG;
  }
}

/** Drop the cached configuration. Called after an admin edit. */
export function invalidateRankingConfigCache(): void {
  cached = null;
}

export async function listRankingConfigs(client: DbClient = db) {
  const rows = await client.select().from(searchRankingConfigs);
  return rows.map((row) => ({
    ...row,
    validation: parseRankingConfig(row).errors,
    balance: assertLayerBalance(parseWeights(row.weights).weights),
  }));
}

/**
 * Save a ranking configuration.
 *
 * Rejects an unbalanced configuration outright. The alternative — accepting it
 * and letting the storefront silently degrade — is how a bad relevance change
 * reaches every shopper unnoticed.
 */
export async function saveRankingConfig(
  input: {
    version: string;
    label?: string;
    weights: unknown;
    outOfStockMode?: "HIDE" | "DEMOTE" | "ONLY_IF_EMPTY";
    fuzzyThreshold?: number;
    maxEditDistance?: number;
    notes?: string;
    activate?: boolean;
  },
  client: DbClient = db,
): Promise<{ version: string }> {
  const { config, errors } = parseRankingConfig({
    version: input.version,
    label: input.label,
    weights: input.weights,
    outOfStockMode: input.outOfStockMode,
    fuzzyThreshold: input.fuzzyThreshold,
    maxEditDistance: input.maxEditDistance,
  });
  if (errors.length) {
    const { ValidationError } = await import("@/lib/errors");
    throw new ValidationError(`Invalid ranking configuration: ${errors.join("; ")}`);
  }

  const balance = assertLayerBalance(config.weights);
  if (balance.length) {
    const { ValidationError } = await import("@/lib/errors");
    throw new ValidationError(`Ranking weights are unbalanced: ${balance.join("; ")}`);
  }

  await withTransaction(async (tx) => {
    if (input.activate) {
      // Exactly one active row, enforced both here and by a partial unique index.
      await tx.update(searchRankingConfigs).set({ isActive: false });
    }

    const [existing] = await tx
      .select({ id: searchRankingConfigs.id })
      .from(searchRankingConfigs)
      .where(eq(searchRankingConfigs.version, input.version))
      .limit(1);

    if (existing) {
      await tx
        .update(searchRankingConfigs)
        .set({
          label: config.label,
          weights: config.weights,
          outOfStockMode: config.outOfStockMode,
          fuzzyThreshold: config.fuzzyThreshold,
          maxEditDistance: config.maxEditDistance,
          notes: input.notes ?? null,
          isActive: input.activate ?? false,
          updatedAt: new Date(),
        })
        .where(eq(searchRankingConfigs.id, existing.id));
    } else {
      await tx.insert(searchRankingConfigs).values({
        version: config.version,
        label: config.label,
        weights: config.weights,
        outOfStockMode: config.outOfStockMode,
        fuzzyThreshold: config.fuzzyThreshold,
        maxEditDistance: config.maxEditDistance,
        notes: input.notes ?? null,
        isActive: input.activate ?? false,
      });
    }
  });

  invalidateRankingConfigCache();
  return { version: config.version };
}

/* ── Experiments ─────────────────────────────────────────────────────── */

export interface ExperimentVariant {
  variant: string;
  rankingVersion: string;
  weight: number;
}

export interface ResolvedExperiment {
  key: string;
  variant: string;
  rankingVersion: string;
}

/**
 * Bucket a session into the active experiment, if any.
 *
 * Bucketing is a pure function of the session hash, so the same shopper lands in
 * the same variant on every request. Re-bucketing per request would make results
 * flicker and would make the experiment data meaningless.
 *
 * Returns null when there is no active experiment, which is the normal case.
 */
export async function resolveExperiment(
  sessionHash: string | null | undefined,
  client: DbClient = db,
): Promise<ResolvedExperiment | null> {
  if (!sessionHash) return null;

  const [experiment] = await client
    .select()
    .from(searchExperiments)
    .where(eq(searchExperiments.isActive, true))
    .limit(1);
  if (!experiment) return null;

  const variants = parseVariants(experiment.variants);
  if (variants.length === 0) return null;

  // FNV-1a over the session hash: cheap, deterministic, and uniform enough for
  // traffic splitting. Not cryptographic, and it does not need to be — the input
  // is already a hash.
  const bucket = fnv1a(sessionHash) % 100;
  let cumulative = 0;
  for (const variant of variants) {
    cumulative += variant.weight;
    if (bucket < cumulative) {
      return { key: experiment.key, variant: variant.variant, rankingVersion: variant.rankingVersion };
    }
  }
  return null;
}

function parseVariants(value: unknown): ExperimentVariant[] {
  if (!Array.isArray(value)) return [];
  const out: ExperimentVariant[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const variant = typeof record.variant === "string" ? record.variant : null;
    const rankingVersion = typeof record.rankingVersion === "string" ? record.rankingVersion : null;
    const weight = typeof record.weight === "number" ? record.weight : 0;
    if (!variant || !rankingVersion || weight <= 0) continue;
    out.push({ variant, rankingVersion, weight });
  }
  return out;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    // 32-bit multiply, kept in range with >>> 0.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/* ── Operational settings ────────────────────────────────────────────── */

const settingsCache = new Map<string, { value: unknown; loadedAt: number }>();

/**
 * Read an operational setting with a fallback.
 *
 * The fallback is required, not optional: these settings govern cache TTLs and
 * result limits, and a missing row must produce working defaults rather than an
 * undefined that propagates into a query.
 */
export async function getSetting<T>(key: string, fallback: T, client: DbClient = db): Promise<T> {
  const cachedEntry = settingsCache.get(key);
  if (cachedEntry && Date.now() - cachedEntry.loadedAt < CACHE_TTL_MS) {
    return (cachedEntry.value as T) ?? fallback;
  }

  try {
    const [row] = await client.select().from(searchSettings).where(eq(searchSettings.key, key)).limit(1);
    const value = row ? (row.value as T) : fallback;
    settingsCache.set(key, { value, loadedAt: Date.now() });
    return value ?? fallback;
  } catch (error) {
    logger.warn(`could not read search setting "${key}"; using fallback`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}

export async function setSetting(
  key: string,
  value: unknown,
  description?: string,
  client: DbClient = db,
): Promise<void> {
  await client
    .insert(searchSettings)
    .values({ key, value, description: description ?? null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: searchSettings.key,
      set: { value, description: description ?? null, updatedAt: new Date() },
    });
  settingsCache.delete(key);
}

export function invalidateSettingsCache(): void {
  settingsCache.clear();
}

export type { RankingWeights };
