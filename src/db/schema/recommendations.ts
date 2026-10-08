import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { categories, products, productVariants } from "./catalog";
import { orders } from "./orders";
import { users } from "./users";
import {
  interestDimensionEnum,
  popularityScopeEnum,
  recommendationEventTypeEnum,
  recommendationTypeEnum,
} from "./enums";
import { idColumn, moneyZero, timestamps, timestampsNoUpdate } from "./helpers";

/**
 * Part 13 — Recommendation, personalization & discovery intelligence.
 *
 * Design rules that shaped every table here:
 *
 * 1. **Extend the event stream, do not fork it.** Behavioural signals land in
 *    the existing `analytics_events` table (see migration 0008, which adds the
 *    columns it was missing). Only *recommendation* impressions get their own
 *    table, because they carry attribution state — position, algorithm
 *    version, the request that produced them — and arrive at a much higher
 *    volume than purchases do.
 * 2. **Expensive work is precomputed, context is applied at request time.**
 *    `product_similarity`, `product_co_purchases` and `product_popularity` are
 *    written by background jobs. A page render reads them and re-ranks; it
 *    never recomputes a similarity matrix.
 * 3. **Weighted, not boolean.** Interest is a real number per (subject,
 *    dimension, key), so "viewed Nike once" and "bought Nike four times" are
 *    distinguishable — which a yes/no flag cannot express.
 * 4. **Every ranking is versioned and explainable.** `algorithm_version` is
 *    stored on the request and on every event derived from it, so a metric
 *    can always be attributed to the code that produced it and rolled back.
 */

/* ═══════════════════════════════════════════════════════════════════════
 * RECOMMENDATION REQUESTS
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * One row per recommendation API call.
 *
 * This is the join point that makes the whole system measurable: impressions
 * reference it, clicks reference the impression, and a purchase is attributed
 * by walking back to it. Without it there is no way to answer "did this
 * ranking change help?" — only "did sales move?".
 *
 * It also carries the debugging record: candidate count vs. result count and
 * whether a fallback was used, which is what distinguishes "the engine found
 * nothing relevant" from "the engine was down".
 */
export const recommendationRequests = pgTable(
  "recommendation_requests",
  {
    ...idColumn,
    /** The id returned to the client, echoed back on impression/click events. */
    recommendationId: text("recommendation_id").notNull(),
    recommendationType: recommendationTypeEnum("recommendation_type").notNull(),
    /** Null for anonymous traffic — never inferred or back-filled. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    /** Salted hash, matching `search_events.session_hash`. Never a raw IP. */
    sessionHash: text("session_hash"),
    /** The product the request was seeded from, for product-page slots. */
    contextProductId: uuid("context_product_id").references(() => products.id, { onDelete: "set null" }),
    contextCategoryId: uuid("context_category_id").references(() => categories.id, { onDelete: "set null" }),
    algorithmVersion: text("algorithm_version").notNull(),
    /** Active experiment variant, when the subject was bucketed into one. */
    experimentVariant: text("experiment_variant"),
    candidateCount: integer("candidate_count").notNull().default(0),
    resultCount: integer("result_count").notNull().default(0),
    tookMs: integer("took_ms"),
    /** HIT | MISS | SKIP — whether a cached candidate set was reused. */
    cacheStatus: text("cache_status").notNull().default("MISS"),
    /** True when a fallback ladder was used instead of the primary strategy. */
    fallbackUsed: boolean("fallback_used").notNull().default(false),
    /** Which rung of the ladder, so a fallback rate is attributable. */
    fallbackReason: text("fallback_reason"),
    ...timestampsNoUpdate,
  },
  (table) => [
    uniqueIndex("recommendation_requests_recommendation_id_key").on(table.recommendationId),
    index("recommendation_requests_type_time_idx").on(table.recommendationType, sql`${table.createdAt} desc`),
    index("recommendation_requests_user_idx").on(table.userId, sql`${table.createdAt} desc`),
    index("recommendation_requests_session_idx").on(table.sessionHash, sql`${table.createdAt} desc`),
    check("recommendation_requests_candidate_count_non_negative", sql`${table.candidateCount} >= 0`),
    check("recommendation_requests_result_count_non_negative", sql`${table.resultCount} >= 0`),
    // A result can never exceed the candidate pool it was drawn from.
    check("recommendation_requests_result_within_candidates", sql`${table.resultCount} <= ${table.candidateCount}`),
  ],
);

/* ═══════════════════════════════════════════════════════════════════════
 * RECOMMENDATION EVENTS (impression → click → cart → purchase)
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * What happened to a recommended product after it was shown.
 *
 * Append-only. `SHOWN` rows are written when a client reports an impression;
 * `CLICKED`, `ADDED_TO_CART` and `PURCHASED` rows carry an
 * `attributedRequestId` when they can be tied back to a specific impression,
 * and leave it null when they cannot — a purchase the shopper made
 * independently is recorded as a purchase, not laundered into a
 * recommendation conversion.
 *
 * `position` is stored rather than derived because the ordering a shopper saw
 * is a fact about that impression, not something recomputable later.
 */
export const recommendationEvents = pgTable(
  "recommendation_events",
  {
    ...idColumn,
    eventType: recommendationEventTypeEnum("event_type").notNull(),
    recommendationType: recommendationTypeEnum("recommendation_type").notNull(),
    /** The request that produced the shown item. Null for unattributed events. */
    attributedRequestId: uuid("attributed_request_id").references(() => recommendationRequests.id, {
      onDelete: "set null",
    }),
    recommendationId: text("recommendation_id"),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "set null" }),
    /** 1-based slot the item occupied. */
    position: integer("position"),
    algorithmVersion: text("algorithm_version"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    sessionHash: text("session_hash"),
    /** Revenue credited to a PURCHASED event, in minor units. */
    revenuePaise: moneyZero("revenue_paise"),
    /** The order a PURCHASED event came from, when one exists. */
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    ...timestampsNoUpdate,
  },
  (table) => [
    index("recommendation_events_type_time_idx").on(table.eventType, sql`${table.createdAt} desc`),
    index("recommendation_events_request_idx").on(table.attributedRequestId),
    index("recommendation_events_product_idx").on(table.productId, sql`${table.createdAt} desc`),
    index("recommendation_events_rec_type_time_idx").on(
      table.recommendationType,
      table.eventType,
      sql`${table.createdAt} desc`,
    ),
    // Attribution needs this: "purchases within N days of an impression".
    index("recommendation_events_attribution_idx").on(table.productId, table.eventType, sql`${table.createdAt} desc`),
    check("recommendation_events_position_positive", sql`${table.position} IS NULL OR ${table.position} >= 1`),
  ],
);

/* ═══════════════════════════════════════════════════════════════════════
 * USER INTEREST SIGNALS
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * The raw material of personalization: one weighted row per
 * (subject, dimension, key).
 *
 * A subject is either a signed-in user or an anonymous session — exactly one
 * of the two is set, enforced by a check constraint, because a row belonging
 * to both would double-count and a row belonging to neither is meaningless.
 *
 * `rawWeight` accumulates the un-decayed total; the profile applies time decay
 * on read. Storing the decayed value instead would make the decay function
 * impossible to change without re-deriving history.
 */
export const userInterestSignals = pgTable(
  "user_interest_signals",
  {
    ...idColumn,
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    sessionHash: text("session_hash"),
    dimension: interestDimensionEnum("dimension").notNull(),
    /** The category id, brand id, or attribute key this weight belongs to. */
    key: text("key").notNull(),
    /** Undecayed accumulated weight. Decay is applied when the profile is built. */
    rawWeight: real("raw_weight").notNull().default(0),
    /** How many events contributed — lets a rare strong signal beat a common weak one. */
    eventCount: integer("event_count").notNull().default(0),
    /** Strongest single signal seen (PURCHASE outranks VIEW). */
    strongestEvent: text("strongest_event"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    ...timestampsNoUpdate,
  },
  (table) => [
    // Upsert target: one row per subject per dimension per key.
    uniqueIndex("user_interest_signals_subject_key").on(
      table.userId,
      table.sessionHash,
      table.dimension,
      table.key,
    ),
    index("user_interest_signals_user_weight_idx").on(table.userId, sql`${table.rawWeight} desc`),
    index("user_interest_signals_session_weight_idx").on(table.sessionHash, sql`${table.rawWeight} desc`),
    index("user_interest_signals_dimension_idx").on(table.dimension, table.key),
    check("user_interest_signals_event_count_non_negative", sql`${table.eventCount} >= 0`),
    check("user_interest_signals_raw_weight_non_negative", sql`${table.rawWeight} >= 0`),
    // Exactly one subject. Both null is an orphan; both set is a double count.
    check(
      "user_interest_signals_exactly_one_subject",
      sql`(${table.userId} IS NULL) <> (${table.sessionHash} IS NULL)`,
    ),
  ],
);

/* ═══════════════════════════════════════════════════════════════════════
 * USER INTEREST PROFILES
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * The decayed, normalized snapshot the ranking engine actually reads.
 *
 * Materialized rather than computed per request because building it means
 * scanning every signal row for a subject and applying decay — too slow to do
 * on a page render, and identical for every request within the cache window.
 *
 * `interests` is keyed by dimension:
 *   { CATEGORY: { "<id>": 0.87 }, BRAND: { "<id>": 0.72 }, ... }
 * Weights are normalized to 0–1 within each dimension, so a user with 200
 * signals is not systematically scored higher than one with 5.
 */
export const userInterestProfiles = pgTable(
  "user_interest_profiles",
  {
    ...idColumn,
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    sessionHash: text("session_hash"),
    interests: jsonb("interests").$type<Record<string, Record<string, number>>>().notNull().default({}),
    /** Estimated preferred price band in minor units, derived per category. */
    pricePreference: jsonb("price_preference").$type<Record<string, { minPaise: number; maxPaise: number }>>()
      .notNull()
      .default({}),
    /** How much evidence backs this profile — gates whether to personalize at all. */
    confidence: real("confidence").notNull().default(0),
    signalCount: integer("signal_count").notNull().default(0),
    /** Decay function + params used, so a profile is reproducible. */
    decayVersion: text("decay_version").notNull().default("exponential-v1"),
    computedAt: timestamp("computed_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    ...timestampsNoUpdate,
  },
  (table) => [
    uniqueIndex("user_interest_profiles_user_key").on(table.userId),
    uniqueIndex("user_interest_profiles_session_key").on(table.sessionHash),
    index("user_interest_profiles_computed_idx").on(sql`${table.computedAt} desc`),
    check("user_interest_profiles_confidence_range", sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`),
    check("user_interest_profiles_signal_count_non_negative", sql`${table.signalCount} >= 0`),
    check(
      "user_interest_profiles_exactly_one_subject",
      sql`(${table.userId} IS NULL) <> (${table.sessionHash} IS NULL)`,
    ),
  ],
);

/* ═══════════════════════════════════════════════════════════════════════
 * PRODUCT SIMILARITY (precomputed)
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * Content-based similarity, computed offline by `npm run recommendations:compute`.
 *
 * This is deliberately **similarity**, not complementarity: a phone case scores
 * high on co-purchase and low here, because it shares no category, brand or
 * attributes with the phone. Conflating the two is what makes a
 * "similar products" rail fill up with socks.
 *
 * `sources` records which signals contributed and by how much, which is what
 * lets the admin debugger answer "why is this similar?" without re-deriving it.
 */
export const productSimilarity = pgTable(
  "product_similarity",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    similarProductId: uuid("similar_product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** 0–1, comparable across products because the scoring is normalized. */
    score: real("score").notNull().default(0),
    /** Which weight profile produced it — similarity is category-specific. */
    algorithm: text("algorithm").notNull().default("content-v1"),
    /** Per-signal contributions, for the explanation layer and the debugger. */
    sources: jsonb("sources").$type<Record<string, number>>().notNull().default({}),
    computedAt: timestamp("computed_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.productId, table.similarProductId] }),
    // The hot path: "top N similar to X", already ordered.
    index("product_similarity_lookup_idx").on(table.productId, sql`${table.score} desc`),
    index("product_similarity_reverse_idx").on(table.similarProductId),
    check("product_similarity_not_self", sql`${table.productId} != ${table.similarProductId}`),
    check("product_similarity_score_range", sql`${table.score} >= 0 AND ${table.score} <= 1`),
  ],
);

/* ═══════════════════════════════════════════════════════════════════════
 * CO-PURCHASE (precomputed)
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * Purchase co-occurrence with the three association metrics that make it
 * trustworthy.
 *
 * Raw counts alone would recommend toilet paper with everything, because
 * everyone buys it. `lift` is the column that fixes this: it is confidence
 * divided by how often the companion is bought anyway, so a genuinely
 * *associated* item scores high and a merely *popular* one scores near 1.
 *
 *   support    = P(A and B)                how common the pair is
 *   confidence = P(B | A)                 given A, how often B follows
 *   lift       = confidence / P(B)        association beyond base popularity
 */
export const productCoPurchases = pgTable(
  "product_co_purchases",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    coProductId: uuid("co_product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** Distinct orders containing both. */
    orderCount: integer("order_count").notNull().default(0),
    support: real("support").notNull().default(0),
    confidence: real("confidence").notNull().default(0),
    lift: real("lift").notNull().default(0),
    computedAt: timestamp("computed_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.productId, table.coProductId] }),
    // Ranked lookup, filtered to pairs with real association rather than noise.
    index("product_co_purchases_lookup_idx").on(table.productId, sql`${table.lift} desc`),
    index("product_co_purchases_confidence_idx").on(table.productId, sql`${table.confidence} desc`),
    check("product_co_purchases_not_self", sql`${table.productId} != ${table.coProductId}`),
    check("product_co_purchases_order_count_positive", sql`${table.orderCount} >= 1`),
    check("product_co_purchases_support_range", sql`${table.support} >= 0 AND ${table.support} <= 1`),
    check("product_co_purchases_confidence_range", sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`),
    check("product_co_purchases_lift_non_negative", sql`${table.lift} >= 0`),
  ],
);

/* ═══════════════════════════════════════════════════════════════════════
 * POPULARITY & TRENDING (precomputed)
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * Popularity, scoped, with momentum kept separate from lifetime totals.
 *
 * One row per (product, scope, scopeId). GLOBAL uses an empty `scopeId`;
 * CATEGORY and BRAND carry the id they describe.
 *
 * `score` is lifetime-weighted and `trendingScore` is momentum — the ratio of
 * recent attention to the product's own baseline. Keeping them apart is what
 * stops a three-year-old bestseller from being permanently labelled
 * "trending", which is the failure mode of a single combined number.
 */
export const productPopularity = pgTable(
  "product_popularity",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    scope: popularityScopeEnum("scope").notNull().default("GLOBAL"),
    /** Empty string for GLOBAL, so the primary key stays non-nullable. */
    scopeId: text("scope_id").notNull().default(""),
    viewCount: integer("view_count").notNull().default(0),
    addToCartCount: integer("add_to_cart_count").notNull().default(0),
    wishlistCount: integer("wishlist_count").notNull().default(0),
    purchaseCount: integer("purchase_count").notNull().default(0),
    revenuePaise: moneyZero("revenue_paise"),
    /** Lifetime popularity, blended from the counters above. */
    score: real("score").notNull().default(0),
    /** Momentum: recent activity against this product's own baseline. */
    trendingScore: real("trending_score").notNull().default(0),
    /** Conversion rate, so popularity is not purely a traffic measure. */
    conversionRate: real("conversion_rate").notNull().default(0),
    windowDays: integer("window_days").notNull().default(30),
    computedAt: timestamp("computed_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.productId, table.scope, table.scopeId] }),
    index("product_popularity_scope_score_idx").on(table.scope, table.scopeId, sql`${table.score} desc`),
    index("product_popularity_trending_idx").on(table.scope, table.scopeId, sql`${table.trendingScore} desc`),
    check("product_popularity_view_count_non_negative", sql`${table.viewCount} >= 0`),
    check("product_popularity_purchase_count_non_negative", sql`${table.purchaseCount} >= 0`),
    check("product_popularity_score_non_negative", sql`${table.score} >= 0`),
    check("product_popularity_conversion_rate_range", sql`${table.conversionRate} >= 0 AND ${table.conversionRate} <= 1`),
    check("product_popularity_window_days_positive", sql`${table.windowDays} >= 1`),
  ],
);

/* ═══════════════════════════════════════════════════════════════════════
 * CONFIGURATION, EXPERIMENTS, METRICS
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * Ranking weights and policy per recommendation type.
 *
 * One active configuration per type, enforced by a partial unique index — the
 * same shape `search_ranking_configs` uses, because the rollback story is the
 * same: activate the previous version and the new one steps down.
 *
 * `params` holds the type-specific policy that is *not* a weight: diversity
 * budget, exploration probability, upsell price ceiling, exclusion rules.
 */
export const recommendationConfigs = pgTable(
  "recommendation_configs",
  {
    ...idColumn,
    recommendationType: recommendationTypeEnum("recommendation_type").notNull(),
    version: text("version").notNull(),
    label: text("label").notNull().default("Default"),
    weights: jsonb("weights").$type<Record<string, number>>().notNull(),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
    isActive: boolean("is_active").notNull().default(false),
    notes: text("notes"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("recommendation_configs_type_version_key").on(table.recommendationType, table.version),
    uniqueIndex("recommendation_configs_single_active_key")
      .on(table.recommendationType, table.isActive)
      .where(sql`${table.isActive} = true`),
  ],
);

/** A/B slots, so a new ranking can be tried on a slice of traffic. */
export const recommendationExperiments = pgTable(
  "recommendation_experiments",
  {
    ...idColumn,
    key: text("key").notNull(),
    name: text("name").notNull(),
    recommendationType: recommendationTypeEnum("recommendation_type").notNull(),
    variants: jsonb("variants").$type<Array<{ name: string; configVersion: string; weight: number }>>()
      .notNull(),
    isActive: boolean("is_active").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
    ...timestampsNoUpdate,
  },
  (table) => [
    uniqueIndex("recommendation_experiments_key_active_key").on(table.key).where(sql`${table.isActive} = true`),
    index("recommendation_experiments_type_idx").on(table.recommendationType),
  ],
);

/**
 * Daily rollup per recommendation type.
 *
 * Pre-aggregated because CTR and revenue-per-impression are dashboard queries
 * run far more often than the underlying events change, and scanning the event
 * table for a 30-day chart is the kind of query that gets a dashboard turned
 * off.
 */
export const recommendationMetrics = pgTable(
  "recommendation_metrics",
  {
    ...idColumn,
    bucketDate: date("bucket_date", { mode: "string" }).notNull(),
    recommendationType: recommendationTypeEnum("recommendation_type").notNull(),
    algorithmVersion: text("algorithm_version").notNull().default(""),
    impressions: integer("impressions").notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
    addToCarts: integer("add_to_carts").notNull().default(0),
    purchases: integer("purchases").notNull().default(0),
    revenuePaise: moneyZero("revenue_paise"),
    /** Clicks / impressions, stored so a chart needs no division. */
    ctr: real("ctr").notNull().default(0),
    computedAt: timestamp("computed_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("recommendation_metrics_bucket_key").on(
      table.bucketDate,
      table.recommendationType,
      table.algorithmVersion,
    ),
    index("recommendation_metrics_type_date_idx").on(table.recommendationType, sql`${table.bucketDate} desc`),
    check("recommendation_metrics_impressions_non_negative", sql`${table.impressions} >= 0`),
    // A click without an impression is a tracking bug, not a metric.
    check("recommendation_metrics_clicks_within_impressions", sql`${table.clicks} <= ${table.impressions}`),
    check("recommendation_metrics_ctr_range", sql`${table.ctr} >= 0 AND ${table.ctr} <= 1`),
  ],
);

/* ── Types ─────────────────────────────────────────────────────────────── */
export type RecommendationRequest = typeof recommendationRequests.$inferSelect;
export type RecommendationEvent = typeof recommendationEvents.$inferSelect;
export type UserInterestSignal = typeof userInterestSignals.$inferSelect;
export type UserInterestProfile = typeof userInterestProfiles.$inferSelect;
export type ProductSimilarity = typeof productSimilarity.$inferSelect;
export type ProductCoPurchase = typeof productCoPurchases.$inferSelect;
export type ProductPopularity = typeof productPopularity.$inferSelect;
export type RecommendationConfig = typeof recommendationConfigs.$inferSelect;
export type RecommendationExperiment = typeof recommendationExperiments.$inferSelect;
export type RecommendationMetric = typeof recommendationMetrics.$inferSelect;
