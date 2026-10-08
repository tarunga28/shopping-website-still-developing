import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { brands, categories, products } from "./catalog";
import { users } from "./users";
import { idColumn } from "./helpers";

/**
 * Part 12 — Search & discovery.
 *
 * Everything here exists to make search a first-class capability rather than a
 * `LIKE` query. Two principles shaped the tables:
 *
 * 1. **No private data.** Analytics rows carry a salted `session_hash`, never a
 *    raw IP or user id. Search history is the one place a user id appears, and
 *    it is the user's own row, readable only by them.
 * 2. **Reusable models, not new ones.** Synonyms, suggestions, and the search
 *    index stay in `catalog-intelligence.ts` where Part 11 put them. This file
 *    adds only what Part 12 genuinely needs: vocabulary, history, click events,
 *    ranking configuration, and experiment slots.
 */

/* ═══════════════════════════════════════════════════════════════════════
 * SPELL-CORRECTION VOCABULARY
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * The dictionary typo correction is allowed to correct *to*.
 *
 * This table is the difference between controlled typo tolerance and guessing.
 * A query is only ever corrected to a term that actually exists in the catalog
 * (a product word, a brand, a category, an attribute value, or a tag), so
 * "iphne" becomes "iphone" because "iphone" is a real brand in this store — not
 * because some distance function thought it was close.
 *
 * Kept separate from `product_search_index` on purpose: the index holds one row
 * per product, but the vocabulary holds one row per *term*, which is what a
 * correction lookup needs and is orders of magnitude smaller to scan.
 */
export const searchVocabulary = pgTable(
  "search_vocabulary",
  {
    ...idColumn,
    /** Folded, tokenized term. This is what corrections map to. */
    term: text("term").notNull(),
    /** Where the term came from — used to weight and to explain a correction. */
    source: text("source").notNull().default("PRODUCT"),
    /** How many documents contain the term. Rare terms are weak corrections. */
    documentCount: integer("document_count").notNull().default(1),
    /** Optional brand/category this term is known to refer to. */
    brandId: uuid("brand_id").references(() => brands.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "cascade" }),
    /** Trigram text for similarity lookups; equals `term` unless folded differently. */
    trigramText: text("trigram_text").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // A term from two sources is still one vocabulary entry; the source column
    // records the strongest one.
    uniqueIndex("search_vocabulary_term_key").on(table.term),
    index("search_vocabulary_trigram_idx").using("gin", sql`${table.trigramText} gin_trgm_ops`),
    index("search_vocabulary_source_idx").on(table.source, sql`${table.documentCount} desc`),
    check("search_vocabulary_document_count_positive", sql`${table.documentCount} >= 1`),
    check("search_vocabulary_term_not_empty", sql`length(${table.term}) > 0`),
  ],
);

/* ═══════════════════════════════════════════════════════════════════════
 * SEARCH HISTORY (authenticated users only)
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * Recent searches for a signed-in user.
 *
 * Unique per (user, normalized query) and upserted, so searching "nike shoes"
 * forty times produces one row with `searchCount = 40` rather than forty rows.
 * That is both the right privacy posture and the reason the table cannot grow
 * without bound.
 *
 * Anonymous visitors keep their history in the browser only; nothing is stored
 * server-side for them, because a session-keyed server history would be a
 * de-anonymized browsing record.
 */
export const searchHistory = pgTable(
  "search_history",
  {
    ...idColumn,
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** As typed, so the user recognises it in their own list. */
    rawQuery: text("raw_query").notNull(),
    /** Folded form; the uniqueness key, so "Nike Shoes" and "nike shoes" merge. */
    normalizedQuery: text("normalized_query").notNull(),
    resultCount: integer("result_count").notNull().default(0),
    searchCount: integer("search_count").notNull().default(1),
    lastSearchedAt: timestamp("last_searched_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("search_history_user_query_key").on(table.userId, table.normalizedQuery),
    index("search_history_user_recent_idx").on(table.userId, sql`${table.lastSearchedAt} desc`),
    check("search_history_search_count_positive", sql`${table.searchCount} >= 1`),
    check("search_history_result_count_non_negative", sql`${table.resultCount} >= 0`),
  ],
);

/* ═══════════════════════════════════════════════════════════════════════
 * SEARCH EVENTS (clicks, add-to-cart, purchase)
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * What a shopper did after a search.
 *
 * This is the table that turns search from a guess into a measurement: without
 * click position and outcome there is no way to tell whether a ranking change
 * helped. Rows are append-only and never updated.
 *
 * `searchLogId` links back to the query that produced the click, so
 * click-through rate is computable per query. It is nullable because a purchase
 * can be attributed to a search the shopper ran in an earlier session, and a
 * dangling foreign key would be worse than a null.
 */
export const searchEvents = pgTable(
  "search_events",
  {
    ...idColumn,
    searchLogId: uuid("search_log_id"),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    /** 1-based position in the results the shopper saw. */
    position: integer("position"),
    eventType: text("event_type").notNull().default("CLICK"),
    /** Salted session hash; the same value used on the query log. */
    sessionHash: text("session_hash"),
    /** Ranking version that produced the results, for A/B comparison. */
    rankingVersion: text("ranking_version"),
    /** Experiment variant the session was bucketed into, when one was active. */
    experimentVariant: text("experiment_variant"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("search_events_log_idx").on(table.searchLogId),
    index("search_events_type_time_idx").on(table.eventType, sql`${table.createdAt} desc`),
    index("search_events_product_idx").on(table.productId, sql`${table.createdAt} desc`),
    check("search_events_position_positive", sql`${table.position} IS NULL OR ${table.position} >= 1`),
  ],
);

/* ═══════════════════════════════════════════════════════════════════════
 * RANKING CONFIGURATION
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * Ranking weights and search behaviour, keyed by version.
 *
 * Weights live in the database rather than in source for one reason: a
 * merchandiser tuning relevance must not need a deploy, and a bad change must be
 * revertable by switching `is_active` back to the previous row.
 *
 * `weights` is a jsonb object of number-valued keys validated by
 * `src/lib/search/ranking.ts` on read — the column is deliberately schemaless so
 * a new signal does not require a migration, but an unknown key is rejected
 * rather than silently ignored.
 */
export const searchRankingConfigs = pgTable(
  "search_ranking_configs",
  {
    ...idColumn,
    /** e.g. "v1", "v2". Recorded on every query log and search event. */
    version: text("version").notNull(),
    label: text("label").notNull().default("Default ranking"),
    weights: jsonb("weights").notNull(),
    /**
     * Out-of-stock handling: HIDE | DEMOTE | ONLY_IF_EMPTY.
     * A product decision, so it is configuration rather than a code branch.
     */
    outOfStockMode: text("out_of_stock_mode").notNull().default("DEMOTE"),
    /** Minimum similarity before fuzzy matching is attempted at all. */
    fuzzyThreshold: real("fuzzy_threshold").notNull().default(0.35),
    /** Edit distance allowed for spell correction. 0 disables correction. */
    maxEditDistance: integer("max_edit_distance").notNull().default(1),
    isActive: boolean("is_active").notNull().default(false),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("search_ranking_configs_version_key").on(table.version),
    // Exactly one active configuration. A partial unique index expresses that
    // directly, so a second `is_active = true` row cannot be inserted.
    uniqueIndex("search_ranking_configs_single_active_key")
      .on(table.isActive)
      .where(sql`${table.isActive} = true`),
    check(
      "search_ranking_configs_fuzzy_threshold_range",
      sql`${table.fuzzyThreshold} >= 0 AND ${table.fuzzyThreshold} <= 1`,
    ),
    check(
      "search_ranking_configs_edit_distance_range",
      sql`${table.maxEditDistance} >= 0 AND ${table.maxEditDistance} <= 3`,
    ),
    check(
      "search_ranking_configs_out_of_stock_mode_valid",
      sql`${table.outOfStockMode} IN ('HIDE', 'DEMOTE', 'ONLY_IF_EMPTY')`,
    ),
  ],
);

/* ═══════════════════════════════════════════════════════════════════════
 * EXPERIMENTS (A/B foundation)
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * Ranking experiments.
 *
 * Deliberately minimal: a key, two-or-more named variants each pointing at a
 * ranking configuration version, and a traffic split. The measurement side is
 * already covered by `search_events` carrying `experimentVariant`, so this table
 * only has to answer "which variant was this session in?"
 *
 * Bucketing is by session hash so a shopper sees a consistent ranking for the
 * duration of the experiment — re-bucketing per request would make the results
 * flicker and the data meaningless.
 */
export const searchExperiments = pgTable(
  "search_experiments",
  {
    ...idColumn,
    key: text("key").notNull(),
    name: text("name").notNull(),
    /** [{ variant: "a", rankingVersion: "v1", weight: 50 }, ...] */
    variants: jsonb("variants").notNull(),
    isActive: boolean("is_active").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("search_experiments_key_active_key")
      .on(table.key)
      .where(sql`${table.isActive} = true`),
  ],
);

/* ═══════════════════════════════════════════════════════════════════════
 * SEARCH CONFIGURATION (feature flags & limits)
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * Non-ranking search settings: cache TTLs, result limits, feature toggles.
 *
 * Separate from the ranking config because these change for operational reasons
 * (a cache TTL during a traffic spike) and should never be tangled up with a
 * relevance version that is being A/B tested.
 */
export const searchSettings = pgTable(
  "search_settings",
  {
    key: text("key").primaryKey(),
    value: jsonb("value").notNull(),
    description: text("description"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);

/* ═══════════════════════════════════════════════════════════════════════
 * TYPES
 * ═══════════════════════════════════════════════════════════════════════ */

export type SearchVocabularyTerm = typeof searchVocabulary.$inferSelect;
export type NewSearchVocabularyTerm = typeof searchVocabulary.$inferInsert;
export type SearchHistoryEntry = typeof searchHistory.$inferSelect;
export type NewSearchHistoryEntry = typeof searchHistory.$inferInsert;
export type SearchEvent = typeof searchEvents.$inferSelect;
export type NewSearchEvent = typeof searchEvents.$inferInsert;
export type SearchRankingConfig = typeof searchRankingConfigs.$inferSelect;
export type NewSearchRankingConfig = typeof searchRankingConfigs.$inferInsert;
export type SearchExperiment = typeof searchExperiments.$inferSelect;
export type NewSearchExperiment = typeof searchExperiments.$inferInsert;
export type SearchSetting = typeof searchSettings.$inferSelect;

/** Where a vocabulary term came from. Drives correction confidence. */
export const VOCABULARY_SOURCES = [
  "PRODUCT",
  "BRAND",
  "CATEGORY",
  "ATTRIBUTE",
  "TAG",
  "QUERY",
] as const;
export type VocabularySource = (typeof VOCABULARY_SOURCES)[number];

export const SEARCH_EVENT_TYPES = ["CLICK", "ADD_TO_CART", "PURCHASE", "NO_CLICK"] as const;
export type SearchEventType = (typeof SEARCH_EVENT_TYPES)[number];

export const OUT_OF_STOCK_MODES = ["HIDE", "DEMOTE", "ONLY_IF_EMPTY"] as const;
export type OutOfStockMode = (typeof OUT_OF_STOCK_MODES)[number];
