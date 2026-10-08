/**
 * Relevance ranking — configurable, layered, versioned.
 *
 * ## Why the weights are data, not literals
 *
 * Every number that decides what a shopper sees first lives in a named weight in
 * `RankingWeights`, stored in `search_ranking_configs`. Two reasons:
 *
 * 1. Tuning relevance must not require a deploy, and a bad change must be
 *    revertable by flipping `is_active` back to the previous row.
 * 2. An unexplained literal buried in a SQL expression is unreviewable. "Why is
 *    this product first?" has to have an answer.
 *
 * ## The layers
 *
 *   1. Text relevance      — did the words match, and where?
 *   2. Entity relevance    — did the brand/category/attribute match?
 *   3. Availability        — can it actually be bought?
 *   4. Commercial          — is it popular, is it selling?
 *   5. Quality             — is it well rated, is it fresh?
 *   6. Personalization     — off until real signals exist
 *
 * Layers 4 and 5 are deliberately small relative to 1 and 2. A bestseller that
 * does not match the query must not outrank a direct match: the weights are
 * scaled so commercial and quality signals can reorder *close* matches but
 * cannot promote an irrelevant product past a relevant one. `assertLayerBalance`
 * enforces that invariant rather than leaving it to review.
 */

import type {
  RankingConfig,
  RankingWeightKey,
  RankingWeights,
  ScoreBreakdown,
} from "@/lib/search/types";

/** The complete weight set, with the baseline values used to seed v1. */
export const DEFAULT_WEIGHTS: RankingWeights = {
  exactSku: 1000,
  exactName: 400,
  prefixName: 220,
  tokenName: 120,
  exactBrand: 160,
  exactCategory: 120,
  attributeMatch: 90,
  tagMatch: 60,
  descriptionMatch: 20,
  // Commercial and quality signals are deliberately small. At their maximum they
  // sum to ~100, below tokenName (120), so they can reorder close matches but
  // can never promote a product that does not match the query's terms.
  popularity: 0.25,
  rating: 8,
  reviewVolume: 2,
  salesVelocity: 10,
  freshness: 5,
  fuzzyPenalty: 0.55,
  outOfStockPenalty: 150,
};

export const RANKING_WEIGHT_KEYS: readonly RankingWeightKey[] = Object.keys(
  DEFAULT_WEIGHTS,
) as RankingWeightKey[];

export const DEFAULT_RANKING_VERSION = "v1";

export const DEFAULT_RANKING_CONFIG: RankingConfig = {
  version: DEFAULT_RANKING_VERSION,
  label: "Default ranking",
  weights: DEFAULT_WEIGHTS,
  outOfStockMode: "DEMOTE",
  fuzzyThreshold: 0.35,
  maxEditDistance: 1,
};

/**
 * Coerce a stored `weights` blob into a validated `RankingWeights`.
 *
 * Unknown keys are rejected rather than ignored: a typo in a stored weight
 * (`exactBrnad`) would otherwise silently leave the real signal at its default
 * and the operator would see "my change did nothing" with no explanation.
 */
export function parseWeights(value: unknown): { weights: RankingWeights; errors: string[] } {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { weights: DEFAULT_WEIGHTS, errors: ["weights must be an object"] };
  }

  const record = value as Record<string, unknown>;
  const known = new Set<string>(RANKING_WEIGHT_KEYS);

  for (const key of Object.keys(record)) {
    if (!known.has(key)) errors.push(`unknown ranking weight "${key}"`);
  }
  for (const key of RANKING_WEIGHT_KEYS) {
    if (!(key in record)) errors.push(`missing ranking weight "${key}"`);
  }

  const weights = { ...DEFAULT_WEIGHTS };
  for (const key of RANKING_WEIGHT_KEYS) {
    const raw = record[key];
    if (raw === undefined) continue;
    const numeric = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(numeric)) {
      errors.push(`ranking weight "${key}" is not a number`);
      continue;
    }
    if (numeric < 0) {
      errors.push(`ranking weight "${key}" must not be negative`);
      continue;
    }
    weights[key] = numeric;
  }

  return { weights: errors.length ? DEFAULT_WEIGHTS : weights, errors };
}

/**
 * Coerce a full stored config row.
 *
 * Returns the default config with an error list rather than throwing, because a
 * broken ranking configuration must not take search down — falling back to v1
 * and logging is the correct degradation.
 */
export function parseRankingConfig(row: {
  version: string;
  label?: string | null;
  weights: unknown;
  outOfStockMode?: string | null;
  fuzzyThreshold?: number | null;
  maxEditDistance?: number | null;
}): { config: RankingConfig; errors: string[] } {
  const { weights, errors } = parseWeights(row.weights);

  const mode = row.outOfStockMode ?? "DEMOTE";
  if (mode !== "HIDE" && mode !== "DEMOTE" && mode !== "ONLY_IF_EMPTY") {
    errors.push(`outOfStockMode must be HIDE, DEMOTE or ONLY_IF_EMPTY, got "${mode}"`);
  }

  const rawFuzzy = row.fuzzyThreshold ?? DEFAULT_RANKING_CONFIG.fuzzyThreshold;
  const fuzzyValid = Number.isFinite(rawFuzzy) && rawFuzzy >= 0 && rawFuzzy <= 1;
  if (!fuzzyValid) errors.push("fuzzyThreshold must be between 0 and 1");

  const rawEditDistance = row.maxEditDistance ?? DEFAULT_RANKING_CONFIG.maxEditDistance;
  const editDistanceValid =
    Number.isInteger(rawEditDistance) && rawEditDistance >= 0 && rawEditDistance <= 3;
  if (!editDistanceValid) errors.push("maxEditDistance must be an integer between 0 and 3");

  return {
    config: {
      version: row.version,
      label: row.label ?? "Ranking",
      weights,
      outOfStockMode: errors.some((error) => error.startsWith("outOfStockMode"))
        ? "DEMOTE"
        : (mode as RankingConfig["outOfStockMode"]),
      // Fall back on any invalid value, not only a non-numeric one: an
      // out-of-range threshold that is merely flagged would still be applied.
      fuzzyThreshold: fuzzyValid ? rawFuzzy : DEFAULT_RANKING_CONFIG.fuzzyThreshold,
      maxEditDistance: editDistanceValid ? rawEditDistance : DEFAULT_RANKING_CONFIG.maxEditDistance,
    },
    errors,
  };
}

/**
 * Guard the layer-balance invariant.
 *
 * The failure this prevents is the quiet one: someone raises `popularity` to
 * make bestsellers surface, and search silently stops being a search. The check
 * is that the strongest possible commercial+quality contribution stays below the
 * weakest meaningful text match.
 */
export function assertLayerBalance(weights: RankingWeights): string[] {
  const problems: string[] = [];

  // Maximum commercial + quality contribution, assuming every signal maxes out.
  // The bounds here are the real ones: popularity is capped at 100, rating at 5,
  // review volume is log-scaled and capped at 10, velocity capped at 1, and
  // freshness at 1.
  const maxCommercialQuality =
    weights.popularity * 100 +
    weights.rating * 5 +
    weights.reviewVolume * 10 +
    weights.salesVelocity +
    weights.freshness;

  // The boundary that matters is a NAME match, not a description match. Two
  // products that both match only in their description may legitimately be
  // reordered by popularity — both are relevant. What must never happen is a
  // bestseller that does not match the name outranking one that does, so
  // commercial+quality has to stay below the weakest name signal.
  if (maxCommercialQuality >= weights.tokenName) {
    problems.push(
      `commercial+quality signals can outweigh a name match ` +
        `(${maxCommercialQuality.toFixed(1)} >= ${weights.tokenName}); ` +
        `an irrelevant bestseller could outrank a product that matches the name`,
    );
  }

  if (weights.exactName <= weights.prefixName) {
    problems.push("exactName must exceed prefixName: an exact match outranks a prefix match");
  }
  if (weights.prefixName <= weights.tokenName) {
    problems.push("prefixName must exceed tokenName: a prefix match outranks a loose token match");
  }
  if (weights.tokenName <= weights.descriptionMatch) {
    problems.push("tokenName must exceed descriptionMatch: a name match outranks a description match");
  }
  if (weights.exactSku <= weights.exactName) {
    problems.push("exactSku must exceed exactName: a typed SKU is the strongest possible signal");
  }
  if (weights.outOfStockPenalty <= 0) {
    problems.push("outOfStockPenalty must be positive, or DEMOTE mode does nothing");
  }

  return problems;
}

/* ── Scoring ─────────────────────────────────────────────────────────── */

/** The raw signals a candidate produced, before weighting. */
export interface RankSignals {
  /** Name matched exactly (folded, whole-string equality). */
  exactName: boolean;
  /** Name starts with the query. */
  prefixName: boolean;
  /** Fraction of query terms present in the name, 0..1. */
  nameTokenCoverage: number;
  /** SKU or barcode matched exactly. */
  exactSku: boolean;
  /** Description matched. */
  descriptionMatch: boolean;
  /** Brand matched the extracted brand entity. */
  exactBrand: boolean;
  /** Category matched the extracted category entity. */
  exactCategory: boolean;
  /** Number of extracted attributes the product satisfies. */
  attributeMatches: number;
  /** Number of query tags matched. */
  tagMatches: number;
  /** 0..100, bounded. */
  popularity: number;
  /** 0..5, or null when unrated. */
  ratingAverage: number | null;
  /** Raw count; log-scaled internally. */
  ratingCount: number;
  /** 0..1 normalized recent sales. */
  salesVelocity: number;
  /** 0..1, 1 being just published. */
  freshness: number;
  /** True when the match came from fuzzy/corrected text. */
  fuzzy: boolean;
  /** Similarity of the fuzzy match, 0..1. */
  fuzzySimilarity: number;
  inStock: boolean;
}

export const NO_SIGNALS: RankSignals = {
  exactName: false,
  prefixName: false,
  nameTokenCoverage: 0,
  exactSku: false,
  descriptionMatch: false,
  exactBrand: false,
  exactCategory: false,
  attributeMatches: 0,
  tagMatches: 0,
  popularity: 0,
  ratingAverage: null,
  ratingCount: 0,
  salesVelocity: 0,
  freshness: 0,
  fuzzy: false,
  fuzzySimilarity: 0,
  inStock: true,
};

/**
 * Log-scale a review count into 0..10.
 *
 * Linear scaling would let a product with 10,000 mediocre reviews dominate one
 * with 400 excellent ones. Log scaling keeps volume a tiebreaker, which is what
 * it should be: it measures confidence in the rating, not quality.
 */
export function reviewVolumeScore(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(10, Math.log10(count + 1) * 3.33);
}

/**
 * Compute the layered score for one candidate.
 *
 * Pure and synchronous so it can run over thousands of candidates per request,
 * and so the same function can be unit-tested against hand-computed examples.
 */
export function scoreCandidate(
  signals: RankSignals,
  weights: RankingWeights,
  options: { outOfStockMode?: RankingConfig["outOfStockMode"] } = {},
): ScoreBreakdown {
  const mode = options.outOfStockMode ?? "DEMOTE";

  // ── Layer 1: text relevance ──────────────────────────────────────────
  let text = 0;
  if (signals.exactSku) text += weights.exactSku;
  if (signals.exactName) text += weights.exactName;
  else if (signals.prefixName) text += weights.prefixName;
  if (signals.nameTokenCoverage > 0) text += weights.tokenName * signals.nameTokenCoverage;
  if (signals.descriptionMatch) text += weights.descriptionMatch;

  // ── Layer 2: entity relevance ────────────────────────────────────────
  let entity = 0;
  if (signals.exactBrand) entity += weights.exactBrand;
  if (signals.exactCategory) entity += weights.exactCategory;
  if (signals.attributeMatches > 0) {
    // Diminishing returns: the first matching attribute says a lot, the fifth
    // says very little, so this is capped rather than linear.
    entity += weights.attributeMatch * Math.min(signals.attributeMatches, 3);
  }
  if (signals.tagMatches > 0) entity += weights.tagMatch * Math.min(signals.tagMatches, 3);

  // ── Layer 3: availability ────────────────────────────────────────────
  let availability = 0;
  let penalties = 0;
  if (!signals.inStock && mode === "DEMOTE") {
    penalties += weights.outOfStockPenalty;
  }

  // ── Layer 4: commercial ──────────────────────────────────────────────
  const commercial =
    weights.popularity * clamp(signals.popularity, 0, 100) +
    weights.salesVelocity * clamp(signals.salesVelocity, 0, 1);

  // ── Layer 5: quality ─────────────────────────────────────────────────
  // An unrated product is scored as neutral (3.0), not zero: a new product with
  // no reviews yet must not be buried beneath everything that has one review.
  const rating = signals.ratingAverage === null ? 3 : clamp(signals.ratingAverage, 0, 5);
  const quality =
    weights.rating * rating +
    weights.reviewVolume * reviewVolumeScore(signals.ratingCount) +
    weights.freshness * clamp(signals.freshness, 0, 1);

  // ── Fuzzy penalty ────────────────────────────────────────────────────
  if (signals.fuzzy) {
    // Scaled by how weak the fuzzy match was: a near-miss costs little, a
    // barely-plausible correction costs a lot.
    const weakness = 1 - clamp(signals.fuzzySimilarity, 0, 1);
    penalties += weights.fuzzyPenalty * text * weakness;
  }

  // ── Layer 6: personalization ─────────────────────────────────────────
  // Intentionally always zero. The layer exists so that adding it later is a
  // change to one function rather than a re-plumbing of the scorer.
  const personalization = 0;

  const total = Math.max(0, text + entity + availability + commercial + quality + personalization - penalties);

  return {
    text: round(text),
    entity: round(entity),
    availability: round(availability),
    commercial: round(commercial),
    quality: round(quality),
    personalization: round(personalization),
    penalties: round(penalties),
    total: round(total),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Order candidates by score, deterministically.
 *
 * The tiebreak on id is not cosmetic: without it, two products with equal scores
 * swap places between requests, which makes pagination repeat and skip items.
 */
export function sortByScore<T extends { score: number; productId: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.score - a.score || a.productId.localeCompare(b.productId));
}

/**
 * Apply the out-of-stock policy to an ordered list.
 *
 * HIDE drops unavailable items. DEMOTE keeps the caller's order (the penalty is
 * already in the score). ONLY_IF_EMPTY shows unavailable items only when there
 * is nothing else — which is what a sparse catalog needs to avoid an empty page.
 */
export function applyOutOfStockPolicy<T extends { inStock: boolean }>(
  items: readonly T[],
  mode: RankingConfig["outOfStockMode"],
): T[] {
  if (mode === "DEMOTE") return [...items];
  if (mode === "HIDE") return items.filter((item) => item.inStock);
  const available = items.filter((item) => item.inStock);
  return available.length > 0 ? available : [...items];
}

/** A human-readable explanation, for the admin "why this result?" panel. */
export function explainScore(breakdown: ScoreBreakdown, signals: RankSignals): string[] {
  const lines: string[] = [];
  if (signals.exactSku) lines.push("Exact SKU or barcode match");
  if (signals.exactName) lines.push("Product name matched exactly");
  else if (signals.prefixName) lines.push("Product name matched by prefix");
  else if (signals.nameTokenCoverage > 0)
    lines.push(`Name matched ${Math.round(signals.nameTokenCoverage * 100)}% of the query terms`);
  if (signals.exactBrand) lines.push("Brand matched");
  if (signals.exactCategory) lines.push("Category matched");
  if (signals.attributeMatches > 0) lines.push(`${signals.attributeMatches} attribute(s) matched`);
  if (signals.descriptionMatch) lines.push("Mentioned in the description");
  if (signals.fuzzy) lines.push(`Matched approximately (${Math.round(signals.fuzzySimilarity * 100)}% similar)`);
  if (!signals.inStock) lines.push("Out of stock — demoted");
  lines.push(
    `Score ${breakdown.total} = text ${breakdown.text} + entity ${breakdown.entity} ` +
      `+ commercial ${breakdown.commercial} + quality ${breakdown.quality} − penalties ${breakdown.penalties}`,
  );
  return lines;
}
