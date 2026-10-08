import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { recommendationConfigs, recommendationExperiments } from "@/db/schema";
import type { DbClient } from "@/db/utils";
import { logger } from "@/lib/logger";
import { assertWeightBalance, DEFAULT_RANKING_WEIGHTS, weightsForType } from "@/lib/recommendations/ranking";
import { DIVERSITY_BUDGETS } from "@/lib/recommendations/diversity";
import { exclusionPolicyFor } from "@/lib/recommendations/policy";
import type { RankingWeights, RecommendationType } from "@/lib/recommendations/types";
import { DEFAULT_DECAY } from "@/lib/recommendations/decay";

/**
 * Recommendation configuration, experiments and feature flags.
 *
 * Everything here is data, not code, so an operator can retune a rail without
 * a deploy — and, more importantly, without a rollback. Activating a previous
 * config version is the rollback.
 *
 * Reads fall back to compiled defaults on any failure. A misconfigured
 * recommendation engine should degrade to the defaults that shipped, not throw
 * on a product page.
 */

/**
 * Feature flags.
 *
 * Compiled defaults live here so a flag is meaningful before any row exists.
 * Every flag defaults to the *safe* state: a new capability starts off, and is
 * turned on deliberately, because the alternative is a config typo silently
 * enabling an untested ranking in production.
 */
export const DEFAULT_FEATURE_FLAGS = {
  personalizedRecommendations: true,
  collaborativeFiltering: false,
  trendingEngine: true,
  crossSell: true,
  upsell: true,
  explanations: true,
  exploration: true,
  sellerDiversification: true,
  /** Cold-start exposure for products with no behavioural history. */
  coldStartBoost: true,
} as const;

/**
 * Widened to `boolean` rather than the literal types `as const` would infer.
 *
 * Without this, `flags.explanations` has type `true`, so a check like
 * `flags.explanations === false` is a compile error — and the flag could never
 * actually be turned off, which defeats the purpose of §63.
 */
export type FeatureFlags = { [K in keyof typeof DEFAULT_FEATURE_FLAGS]: boolean };

/** Runtime tunables, with the values the engine is built around. */
export const DEFAULT_SETTINGS = {
  candidateLimit: 200,
  explorationProbability: 0.12,
  attributionWindowDays: 7,
  profileMaxAgeMinutes: 10,
  sessionProfileMaxAgeMinutes: 5,
  decayHalfLifeDays: DEFAULT_DECAY.halfLifeDays,
  /** Below this confidence the engine stops pretending to personalize. */
  minPersonalizationConfidence: 0.15,
  /** Impressions of the same product before it is treated as over-exposed. */
  overExposureImpressions: 12,
  retentionDays: 180,
} as const;

export type RecommendationSettings = typeof DEFAULT_SETTINGS;

const SETTINGS_KEY = "recommendations.settings";
const FLAGS_KEY = "recommendations.flags";

/**
 * Read a settings row, merged over the compiled defaults.
 *
 * Merging rather than replacing means a row that sets one key does not
 * silently reset the other twelve to zero — which is the failure mode of
 * storing a whole config blob and writing it from a partial form.
 */
export async function getSettings(client: DbClient = db): Promise<RecommendationSettings> {
  try {
    const rows = await client.execute<{ value: unknown }>(sql`
      select value from search_settings where key = ${SETTINGS_KEY} limit 1
    `);
    const raw = rows.rows[0]?.value;
    if (raw && typeof raw === "object") {
      return { ...DEFAULT_SETTINGS, ...(raw as Partial<RecommendationSettings>) };
    }
  } catch (error) {
    logger.warn("failed to read recommendation settings; using defaults", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { ...DEFAULT_SETTINGS };
}

export async function getFeatureFlags(client: DbClient = db): Promise<FeatureFlags> {
  try {
    const rows = await client.execute<{ value: unknown }>(sql`
      select value from search_settings where key = ${FLAGS_KEY} limit 1
    `);
    const raw = rows.rows[0]?.value;
    if (raw && typeof raw === "object") {
      return { ...DEFAULT_FEATURE_FLAGS, ...(raw as Partial<FeatureFlags>) };
    }
  } catch (error) {
    logger.warn("failed to read recommendation flags; using defaults", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { ...DEFAULT_FEATURE_FLAGS };
}

export async function saveSettings(
  patch: Partial<RecommendationSettings>,
  client: DbClient = db,
): Promise<RecommendationSettings> {
  const current = await getSettings(client);
  const next = { ...current, ...patch };
  await client.execute(sql`
    insert into search_settings (key, value, description, updated_at)
    values (${SETTINGS_KEY}, ${JSON.stringify(next)}::jsonb,
            'Recommendation engine runtime tunables', now())
    on conflict (key) do update
       set value = excluded.value, updated_at = now()
  `);
  return next;
}

export async function saveFeatureFlags(
  patch: Partial<FeatureFlags>,
  client: DbClient = db,
): Promise<FeatureFlags> {
  const current = await getFeatureFlags(client);
  const next = { ...current, ...patch };
  await client.execute(sql`
    insert into search_settings (key, value, description, updated_at)
    values (${FLAGS_KEY}, ${JSON.stringify(next)}::jsonb,
            'Recommendation feature flags', now())
    on conflict (key) do update
       set value = excluded.value, updated_at = now()
  `);
  return next;
}

/* ── Ranking configs ──────────────────────────────────────────────────── */

export interface ResolvedConfig {
  type: RecommendationType;
  version: string;
  weights: RankingWeights;
  params: Record<string, unknown>;
  /** Where the config came from — the debugger shows this. */
  source: "database" | "compiled";
}

/**
 * The active config for a type, or the compiled default.
 *
 * A stored config is validated on read, not just on save. A weight set that
 * was balanced when written can become unbalanced if the defaults it was
 * merged against change, and shipping that would silently turn the rail into a
 * bestseller list.
 */
export async function getConfig(
  type: RecommendationType,
  client: DbClient = db,
): Promise<ResolvedConfig> {
  const compiled = weightsForType(type);
  try {
    const [row] = await client
      .select({
        version: recommendationConfigs.version,
        weights: recommendationConfigs.weights,
        params: recommendationConfigs.params,
      })
      .from(recommendationConfigs)
      .where(and(eq(recommendationConfigs.recommendationType, type), eq(recommendationConfigs.isActive, true)))
      .limit(1);

    if (!row) {
      return {
        type,
        version: "compiled-v1",
        weights: compiled,
        params: defaultParams(type),
        source: "compiled",
      };
    }

    const weights = { ...compiled, ...(row.weights as Partial<RankingWeights>) };
    assertWeightBalance(weights);
    return {
      type,
      version: row.version,
      weights,
      params: { ...defaultParams(type), ...((row.params ?? {}) as Record<string, unknown>) },
      source: "database",
    };
  } catch (error) {
    // An unbalanced stored config is a real error, but the shopper should not
    // pay for it — fall back to the compiled weights and log loudly.
    logger.warn("stored recommendation config rejected; using compiled defaults", {
      type,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      type,
      version: "compiled-v1",
      weights: compiled,
      params: defaultParams(type),
      source: "compiled",
    };
  }
}

/** Non-weight policy that travels with a config. */
function defaultParams(type: RecommendationType): Record<string, unknown> {
  return {
    diversity: DIVERSITY_BUDGETS[type],
    exclusions: exclusionPolicyFor(type),
  };
}

export async function listConfigs(
  options: { type?: RecommendationType } = {},
  client: DbClient = db,
): Promise<
  Array<{
    id: string;
    recommendationType: RecommendationType;
    version: string;
    label: string;
    isActive: boolean;
    weights: Record<string, number>;
    params: Record<string, unknown>;
    notes: string | null;
    updatedAt: Date;
  }>
> {
  const filters = options.type ? [eq(recommendationConfigs.recommendationType, options.type)] : [];
  const rows = await client
    .select()
    .from(recommendationConfigs)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(recommendationConfigs.recommendationType, desc(recommendationConfigs.updatedAt));

  return rows.map((row) => ({
    id: row.id,
    recommendationType: row.recommendationType,
    version: row.version,
    label: row.label,
    isActive: row.isActive,
    weights: row.weights as Record<string, number>,
    params: row.params as Record<string, unknown>,
    notes: row.notes,
    updatedAt: row.updatedAt,
  }));
}

/**
 * Create a config version.
 *
 * Validates the weight balance before writing, so an unbalanced set cannot be
 * stored and then silently ignored on read — which would look like the save
 * succeeding while having no effect.
 */
export async function saveConfig(
  input: {
    recommendationType: RecommendationType;
    version: string;
    label?: string;
    weights: Partial<RankingWeights>;
    params?: Record<string, unknown>;
    activate?: boolean;
    notes?: string | null;
  },
  client: DbClient = db,
): Promise<{ id: string; version: string; isActive: boolean }> {
  const merged = { ...DEFAULT_RANKING_WEIGHTS, ...weightsForType(input.recommendationType), ...input.weights };
  assertWeightBalance(merged);

  const params = { ...defaultParams(input.recommendationType), ...(input.params ?? {}) };
  const activate = input.activate ?? false;

  if (activate) {
    // Stepping the current active config down first keeps the partial unique
    // index satisfiable — two active rows for one type cannot coexist.
    await client
      .update(recommendationConfigs)
      .set({ isActive: false })
      .where(
        and(
          eq(recommendationConfigs.recommendationType, input.recommendationType),
          eq(recommendationConfigs.isActive, true),
        ),
      );
  }

  const [row] = await client
    .insert(recommendationConfigs)
    .values({
      recommendationType: input.recommendationType,
      version: input.version,
      label: input.label ?? "Custom",
      weights: merged,
      params,
      isActive: activate,
      notes: input.notes ?? null,
    })
    .onConflictDoUpdate({
      target: [recommendationConfigs.recommendationType, recommendationConfigs.version],
      set: {
        label: input.label ?? "Custom",
        weights: merged,
        params,
        isActive: activate,
        notes: input.notes ?? null,
        updatedAt: new Date(),
      },
    })
    .returning({ id: recommendationConfigs.id });

  if (!row) throw new Error("failed to persist recommendation config");
  return { id: row.id, version: input.version, isActive: activate };
}

/** Roll back: activate a previously stored version. */
export async function activateConfigVersion(
  input: { recommendationType: RecommendationType; version: string },
  client: DbClient = db,
): Promise<boolean> {
  const [existing] = await client
    .select({ id: recommendationConfigs.id, weights: recommendationConfigs.weights })
    .from(recommendationConfigs)
    .where(
      and(
        eq(recommendationConfigs.recommendationType, input.recommendationType),
        eq(recommendationConfigs.version, input.version),
      ),
    )
    .limit(1);
  if (!existing) return false;

  // Re-validate before activating: the invariant is checked against the
  // *current* defaults, which may have changed since the version was written.
  assertWeightBalance({
    ...DEFAULT_RANKING_WEIGHTS,
    ...(existing.weights as Partial<RankingWeights>),
  });

  await client
    .update(recommendationConfigs)
    .set({ isActive: false })
    .where(
      and(
        eq(recommendationConfigs.recommendationType, input.recommendationType),
        eq(recommendationConfigs.isActive, true),
      ),
    );
  await client
    .update(recommendationConfigs)
    .set({ isActive: true, updatedAt: new Date() })
    .where(eq(recommendationConfigs.id, existing.id));
  return true;
}

/* ── Experiments ──────────────────────────────────────────────────────── */

export interface ExperimentVariant {
  name: string;
  configVersion: string;
  weight: number;
}

/**
 * Bucket a subject into an experiment variant.
 *
 * Deterministic on the subject id, so a shopper sees the same variant across
 * requests and across page loads. Random bucketing per request would split one
 * shopper's impressions across variants and make the comparison meaningless.
 */
export function bucketVariant(
  subjectKey: string | null,
  variants: readonly ExperimentVariant[],
): ExperimentVariant | null {
  if (!subjectKey || variants.length === 0) return null;
  // FNV-1a: cheap, stable, and well-distributed for this purpose. A crypto hash
  // would be slower for no benefit — this is bucketing, not security.
  let hash = 0x811c9dc5;
  for (let i = 0; i < subjectKey.length; i += 1) {
    hash ^= subjectKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const total = variants.reduce((sum, variant) => sum + Math.max(0, variant.weight), 0);
  if (total <= 0) return null;
  let threshold = (Math.abs(hash) % 1000) / 1000 * total;
  for (const variant of variants) {
    threshold -= Math.max(0, variant.weight);
    if (threshold <= 0) return variant;
  }
  return variants[variants.length - 1] ?? null;
}

/**
 * Resolve the experiment variant for a subject and type.
 *
 * Returns null when no experiment is active, which is the common case — the
 * engine then uses the type's normal config.
 */
export async function resolveExperiment(
  input: { type: RecommendationType; subjectKey: string | null },
  client: DbClient = db,
): Promise<{ experimentId: string; variant: ExperimentVariant } | null> {
  if (!input.subjectKey) return null;
  try {
    const [experiment] = await client
      .select()
      .from(recommendationExperiments)
      .where(
        and(
          eq(recommendationExperiments.recommendationType, input.type),
          eq(recommendationExperiments.isActive, true),
        ),
      )
      .limit(1);
    if (!experiment) return null;

    const variants = experiment.variants as unknown as ExperimentVariant[];
    if (!Array.isArray(variants) || variants.length === 0) return null;

    const variant = bucketVariant(input.subjectKey, variants);
    return variant ? { experimentId: experiment.id, variant } : null;
  } catch (error) {
    logger.warn("failed to resolve recommendation experiment", {
      type: input.type,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function saveExperiment(
  input: {
    key: string;
    name: string;
    recommendationType: RecommendationType;
    variants: ExperimentVariant[];
    activate?: boolean;
  },
  client: DbClient = db,
): Promise<{ id: string }> {
  const totalWeight = input.variants.reduce((sum, variant) => sum + Math.max(0, variant.weight), 0);
  if (totalWeight <= 0) throw new Error("experiment variants must have a positive total weight");
  if (input.variants.length < 2) throw new Error("an experiment needs at least two variants");

  if (input.activate) {
    await client
      .update(recommendationExperiments)
      .set({ isActive: false })
      .where(eq(recommendationExperiments.key, input.key));
  }

  const [row] = await client
    .insert(recommendationExperiments)
    .values({
      key: input.key,
      name: input.name,
      recommendationType: input.recommendationType,
      variants: input.variants,
      isActive: input.activate ?? false,
      startedAt: input.activate ? new Date() : null,
    })
    .returning({ id: recommendationExperiments.id });
  if (!row) throw new Error("failed to persist experiment");
  return { id: row.id };
}

export const RECOMMENDATION_CONFIG_INTERNALS = { defaultParams, bucketVariant };
