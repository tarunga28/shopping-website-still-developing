import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { brands, categories, productVariants, products } from "./catalog";
import {
  attributeTypeEnum,
  catalogEventTypeEnum,
  discountTypeEnum,
  inventoryOperationEnum,
  inventoryReferenceEnum,
  priceRuleTypeEnum,
  productRelationTypeEnum,
} from "./enums";
import { idColumn, timestamps, timestampsNoUpdate, tsvector } from "./helpers";
import { users } from "./users";

/* ═══════════════════════════════════════════════════════════════════════
 * ATTRIBUTE ENGINE
 *
 * Three layers, deliberately normalized so a new axis ("Storage", "Fit",
 * "Wattage") is a row, not a schema change:
 *
 *   attributeDefinitions   the axis itself           Size / Storage / Material
 *   attributeOptions       curated values per axis   S, M, L  ·  128GB, 256GB
 *   productAttributeAxes   which axes a product uses (+ their order)
 *   variantAttributes      one row per (variant, axis) → option or free text
 *   productAttributes      non-variant product-level attributes
 *   productSpecifications  grouped spec table shown on the PDP
 *
 * `variantAttributes` stores BOTH `optionId` and `valueText`. `valueText` is
 * the denormalized display value (so listing a product needs no join), while
 * `optionId` keeps the value in a controlled vocabulary when one exists.
 * ═════════════════════════════════════════════════════════════════════ */

export const attributeDefinitions = pgTable(
  "attribute_definitions",
  {
    ...idColumn,
    /** Canonical machine code, e.g. "size", "storage", "material". */
    code: text("code").notNull(),
    name: text("name").notNull(),
    valueType: attributeTypeEnum("value_type").notNull().default("TEXT"),
    /** Axes a variant is generated from. Non-axes are product-level specs. */
    isVariantAxis: boolean("is_variant_axis").notNull().default(false),
    /** Required on every variant of a product that opts into this axis. */
    isRequired: boolean("is_required").notNull().default(false),
    /** Free-text values allowed, or must they come from `attributeOptions`. */
    allowCustomValues: boolean("allow_custom_values").notNull().default(true),
    unit: text("unit"),
    /** Colour swatch support. */
    isSwatch: boolean("is_swatch").notNull().default(false),
    displayOrder: integer("display_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("attribute_definitions_code_key").on(table.code),
    index("attribute_definitions_axis_idx").on(table.isVariantAxis, table.displayOrder),
    index("attribute_definitions_active_idx").on(table.isActive),
    check("attribute_definitions_order_non_negative", sql`${table.displayOrder} >= 0`),
  ],
);

export const attributeOptions = pgTable(
  "attribute_options",
  {
    ...idColumn,
    definitionId: uuid("definition_id")
      .notNull()
      .references(() => attributeDefinitions.id, { onDelete: "cascade" }),
    /** Canonical machine value, e.g. "256gb", "black". */
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    /** Hex swatch when the axis is a colour. */
    hex: text("hex"),
    /** Numeric rank so "S < M < L" and "128GB < 256GB" sort sensibly. */
    sortOrder: integer("sort_order").notNull().default(0),
    /** Numeric interpretation (grams, GB, cm) for range filters and sorting. */
    numericValue: numeric("numeric_value", { precision: 18, scale: 4 }),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("attribute_options_definition_slug_key").on(table.definitionId, table.slug),
    index("attribute_options_definition_order_idx").on(table.definitionId, table.sortOrder, table.label),
    index("attribute_options_active_idx").on(table.isActive),
    check("attribute_options_order_non_negative", sql`${table.sortOrder} >= 0`),
  ],
);

/** Which axes a product uses, and in which order the storefront renders them. */
export const productAttributeAxes = pgTable(
  "product_attribute_axes",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    definitionId: uuid("definition_id")
      .notNull()
      .references(() => attributeDefinitions.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    /** Axis required on every variant of THIS product (overrides the definition). */
    isRequired: boolean("is_required").notNull().default(true),
  },
  (table) => [
    primaryKey({ columns: [table.productId, table.definitionId] }),
    uniqueIndex("product_attribute_axes_position_key").on(table.productId, table.position),
    index("product_attribute_axes_definition_idx").on(table.definitionId),
    check("product_attribute_axes_position_non_negative", sql`${table.position} >= 0`),
  ],
);

/** One row per (variant, axis). Unique so a variant can never be "M / M". */
export const variantAttributes = pgTable(
  "variant_attributes",
  {
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    definitionId: uuid("definition_id")
      .notNull()
      .references(() => attributeDefinitions.id, { onDelete: "cascade" }),
    optionId: uuid("option_id").references(() => attributeOptions.id, { onDelete: "set null" }),
    /** Denormalized display value — set from the option, or free text. */
    valueText: text("value_text").notNull(),
    /** Lowercased for case-insensitive combo matching and duplicate detection. */
    valueKey: text("value_key").notNull(),
    valueNumeric: numeric("value_numeric", { precision: 18, scale: 4 }),
  },
  (table) => [
    primaryKey({ columns: [table.variantId, table.definitionId] }),
    /**
     * Per-product attribute-set uniqueness is enforced by
     * `product_variants_attribute_combo_key` (see catalog.ts) — a unique index
     * over the combo hash — so it holds under concurrent inserts rather than
     * only in application code.
     */
    index("variant_attributes_product_definition_idx").on(table.productId, table.definitionId),
    index("variant_attributes_option_idx").on(table.optionId),
    index("variant_attributes_value_idx").on(table.definitionId, table.valueKey),
    check("variant_attributes_value_not_blank", sql`length(btrim(${table.valueText})) > 0`),
  ],
);

/** Product-level (non-variant) attributes, e.g. Material = Organic cotton. */
export const productAttributes = pgTable(
  "product_attributes",
  {
    ...idColumn,
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    definitionId: uuid("definition_id")
      .notNull()
      .references(() => attributeDefinitions.id, { onDelete: "cascade" }),
    optionId: uuid("option_id").references(() => attributeOptions.id, { onDelete: "set null" }),
    valueText: text("value_text"),
    valueNumeric: numeric("value_numeric", { precision: 18, scale: 4 }),
    valueBoolean: boolean("value_boolean"),
    ...timestampsNoUpdate,
  },
  (table) => [
    uniqueIndex("product_attributes_unique_key").on(table.productId, table.definitionId),
    index("product_attributes_definition_idx").on(table.definitionId, table.valueText),
    check(
      "product_attributes_has_value",
      sql`${table.valueText} IS NOT NULL OR ${table.valueNumeric} IS NOT NULL OR ${table.valueBoolean} IS NOT NULL`,
    ),
  ],
);

/** Grouped specification table rendered on the PDP ("Display: 6.3 inch"). */
export const productSpecifications = pgTable(
  "product_specifications",
  {
    ...idColumn,
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    groupName: text("group_name").notNull().default("General"),
    label: text("label").notNull(),
    value: text("value").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [
    uniqueIndex("product_specifications_unique_key").on(
      table.productId,
      sql`lower(${table.groupName})`,
      sql`lower(${table.label})`,
    ),
    index("product_specifications_product_idx").on(table.productId, table.groupName, table.sortOrder),
    check("product_specifications_order_non_negative", sql`${table.sortOrder} >= 0`),
  ],
);

/* ═══════════════════════════════════════════════════════════════════════
 * INVENTORY LEDGER
 *
 * Append-only. Quantity is never edited in place: every movement writes a
 * row carrying previous/changed/new, so `stock_quantity` can always be
 * re-derived and audited by replaying the ledger.
 * ═════════════════════════════════════════════════════════════════════ */

export const inventoryLedger = pgTable(
  "inventory_ledger",
  {
    ...idColumn,
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    previousQuantity: integer("previous_quantity").notNull(),
    /** Signed: positive for STOCK_IN/RETURN/RELEASED, negative for SALE/DAMAGE. */
    quantityChanged: integer("quantity_changed").notNull(),
    newQuantity: integer("new_quantity").notNull(),
    operation: inventoryOperationEnum("operation").notNull(),
    referenceType: inventoryReferenceEnum("reference_type").notNull().default("MANUAL"),
    /** Idempotency + traceability: order id, import batch, return id… */
    referenceId: text("reference_id"),
    reason: text("reason"),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    ...timestampsNoUpdate,
  },
  (table) => [
    index("inventory_ledger_variant_time_idx").on(table.variantId, sql`${table.createdAt} desc`, table.id),
    index("inventory_ledger_product_time_idx").on(table.productId, sql`${table.createdAt} desc`),
    index("inventory_ledger_operation_idx").on(table.operation),
    index("inventory_ledger_reference_idx").on(table.referenceType, table.referenceId),
    index("inventory_ledger_actor_idx").on(table.actorId),
    /**
     * An idempotency key makes a replayed webhook a no-op instead of a second
     * stock deduction. NULL means "no dedupe required" (manual adjustments).
     */
    uniqueIndex("inventory_ledger_idempotency_key")
      .on(table.variantId, table.operation, table.referenceId)
      .where(sql`${table.referenceId} IS NOT NULL`),
    check("inventory_ledger_new_is_consistent", sql`${table.previousQuantity} + ${table.quantityChanged} = ${table.newQuantity}`),
    check("inventory_ledger_new_non_negative", sql`${table.newQuantity} >= 0`),
    check("inventory_ledger_changed_non_zero", sql`${table.quantityChanged} != 0`),
  ],
);

/* ═══════════════════════════════════════════════════════════════════════
 * PRICING ENGINE
 *
 * `products.basePrice` / `compareAtPrice` and the variant prices are the
 * LIST price. Discounts are rows here, applied by `pricing.ts` in a fixed
 * pipeline: base → AUTOMATIC → CAMPAIGN/SELLER → SCHEDULED → (coupon, later).
 * Keeping discounts out of the price column means the original price is
 * always recoverable and a campaign can end by date without a data migration.
 * ═════════════════════════════════════════════════════════════════════ */

export const productPriceRules = pgTable(
  "product_price_rules",
  {
    ...idColumn,
    /** Product-wide rule when `variantId` is NULL. */
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
    ruleType: priceRuleTypeEnum("rule_type").notNull().default("AUTOMATIC"),
    discountType: discountTypeEnum("discount_type").notNull(),
    /** PERCENTAGE → 0–100 (2 dp precision ×100 stored as bp is overkill here). */
    discountValue: integer("discount_value").notNull(),
    /** PERCENTAGE caps the discount at this many paise. */
    maxDiscountPaise: integer("max_discount_paise"),
    /** Applied lowest-first; ties break on createdAt. */
    priority: integer("priority").notNull().default(100),
    /** Stop after the first matching rule of this type instead of stacking. */
    stackable: boolean("stackable").notNull().default(true),
    name: text("name").notNull().default("Discount"),
    /** Seller-specific pricing: rule applies only to this seller's storefront. */
    sellerId: uuid("seller_id").references(() => users.id, { onDelete: "set null" }),
    startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }),
    endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    index("product_price_rules_product_idx").on(table.productId, table.ruleType, table.priority),
    index("product_price_rules_variant_idx").on(table.variantId),
    index("product_price_rules_active_window_idx")
      .on(table.productId, sql`coalesce(${table.startsAt}, '-infinity')`, sql`coalesce(${table.endsAt}, 'infinity')`)
      .where(sql`${table.isActive} = true`),
    index("product_price_rules_seller_idx").on(table.sellerId),
    check("product_price_rules_value_non_negative", sql`${table.discountValue} >= 0`),
    check(
      "product_price_rules_percentage_range",
      sql`${table.discountType} != 'PERCENTAGE' OR ${table.discountValue} <= 10000`,
    ),
    check("product_price_rules_max_discount_non_negative", sql`${table.maxDiscountPaise} IS NULL OR ${table.maxDiscountPaise} >= 0`),
    check("product_price_rules_window_valid", sql`${table.endsAt} IS NULL OR ${table.startsAt} IS NULL OR ${table.endsAt} > ${table.startsAt}`),
  ],
);

/* ═══════════════════════════════════════════════════════════════════════
 * RELATIONSHIPS / RECOMMENDATIONS
 * ═════════════════════════════════════════════════════════════════════ */

export const productRelations = pgTable(
  "product_relations",
  {
    ...idColumn,
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    relatedProductId: uuid("related_product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    relationType: productRelationTypeEnum("relation_type").notNull().default("RELATED"),
    /** Ranking score. Manual curation sets it high so it beats computed rows. */
    score: real("score").notNull().default(0),
    /** Hand-picked rows are never overwritten by the recommender. */
    isManual: boolean("is_manual").notNull().default(false),
    /** Order-line counts backing a FREQUENTLY_BOUGHT_TOGETHER row. */
    coOccurrenceCount: integer("co_occurrence_count").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("product_relations_unique_key").on(table.productId, table.relatedProductId, table.relationType),
    index("product_relations_lookup_idx").on(table.productId, table.relationType, sql`${table.score} desc`),
    index("product_relations_related_idx").on(table.relatedProductId),
    check("product_relations_not_self", sql`${table.productId} != ${table.relatedProductId}`),
    check("product_relations_co_occurrence_non_negative", sql`${table.coOccurrenceCount} >= 0`),
  ],
);

/* ═══════════════════════════════════════════════════════════════════════
 * EVENT OUTBOX
 *
 * Domain events are written in the SAME transaction as the state change, so
 * an event can never describe something that did not happen. Consumers (search
 * indexer, recommendations, notifications, analytics, seller dashboards) poll
 * `publishedAt IS NULL` and advance their own cursor — no external broker
 * required, and replaying is safe because every event carries an idempotency id.
 * ═════════════════════════════════════════════════════════════════════ */

export const catalogEvents = pgTable(
  "catalog_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventType: catalogEventTypeEnum("event_type").notNull(),
    aggregateType: text("aggregate_type").notNull().default("product"),
    aggregateId: uuid("aggregate_id").notNull(),
    payload: jsonb("payload").notNull(),
    /** Actor who caused it (NULL = system/scheduler). */
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
  },
  (table) => [
    index("catalog_events_unpublished_idx")
      .on(table.createdAt, table.id)
      .where(sql`${table.publishedAt} IS NULL`),
    index("catalog_events_aggregate_idx").on(table.aggregateType, table.aggregateId, sql`${table.createdAt} desc`),
    index("catalog_events_type_idx").on(table.eventType, sql`${table.createdAt} desc`),
    check("catalog_events_attempt_non_negative", sql`${table.attemptCount} >= 0`),
  ],
);

/* ═══════════════════════════════════════════════════════════════════════
 * SEARCH FOUNDATION
 * ═════════════════════════════════════════════════════════════════════ */

/** Curated synonym pairs ("iphone" → "apple", "tee" → "t-shirt"). */
export const searchSynonyms = pgTable(
  "search_synonyms",
  {
    ...idColumn,
    term: text("term").notNull(),
    synonym: text("synonym").notNull(),
    /** Bidirectional: searching either word expands to both. */
    isBidirectional: boolean("is_bidirectional").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    ...timestampsNoUpdate,
  },
  (table) => [
    uniqueIndex("search_synonyms_pair_key").on(table.term, table.synonym),
    index("search_synonyms_term_idx").on(table.term).where(sql`${table.isActive} = true`),
  ],
);

/**
 * Denormalized search document per product. One row per product keeps the
 * hot search query to a single table + one GIN index, instead of joining
 * variants, tags, brands and attributes on every keystroke.
 */
export const productSearchIndex = pgTable(
  "product_search_index",
  {
    productId: uuid("product_id")
      .primaryKey()
      .references(() => products.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    brandName: text("brand_name"),
    brandId: uuid("brand_id"),
    categoryId: uuid("category_id"),
    categoryPath: text("category_path"),
    sellerId: uuid("seller_id"),
    /** Space-joined SKUs and barcodes across all active variants. */
    skuText: text("sku_text").notNull().default(""),
    tagText: text("tag_text").notNull().default(""),
    /** Axis values across variants ("black white 128gb 256gb"). */
    attributeText: text("attribute_text").notNull().default(""),
    descriptionText: text("description_text").notNull().default(""),
    /** Weighted tsvector — the single column the search query matches. */
    searchVector: tsvector("search_vector").notNull(),
    /** Prefix/trigram fallback for typos and partial words. */
    trigramText: text("trigram_text").notNull().default(""),
    pricePaise: integer("price_paise").notNull().default(0),
    compareAtPaise: integer("compare_at_paise"),
    status: text("status").notNull(),
    /** Only ACTIVE + PUBLIC products are indexed; this mirrors that predicate. */
    isSearchable: boolean("is_searchable").notNull().default(false),
    ratingAverage: real("rating_average"),
    ratingCount: integer("rating_count").notNull().default(0),
    /** Popularity signal (views/orders). 0 until real analytics land. */
    popularity: real("popularity").notNull().default(0),
    indexedAt: timestamp("indexed_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("product_search_index_vector_idx").using("gin", table.searchVector),
    // `gin_trgm_ops` is not in this drizzle-orm version's column API, so the
    // opclass is written as an expression — `using()` accepts raw SQL chunks.
    index("product_search_index_trigram_idx").using("gin", sql`${table.trigramText} gin_trgm_ops`),
    /* ── Part 12: facet, rating and recency indexes ─────────────────────
     * Faceting groups the candidate set by brand or category and filters on
     * price, so the composite index leads with the grouping column. Without
     * these, every facet update is a full pass over the search index. */
    index("product_search_index_facet_brand_idx")
      .on(table.brandId, table.pricePaise)
      .where(sql`${table.isSearchable} = true`),
    index("product_search_index_facet_category_idx")
      .on(table.categoryId, table.pricePaise)
      .where(sql`${table.isSearchable} = true`),
    index("product_search_index_rating_idx")
      .on(sql`${table.ratingAverage} desc nulls last`)
      .where(sql`${table.isSearchable} = true`),
    index("product_search_index_updated_idx")
      .on(sql`${table.indexedAt} desc`)
      .where(sql`${table.isSearchable} = true`),
    index("product_search_index_searchable_idx")
      .on(table.isSearchable, sql`${table.popularity} desc`, table.productId)
      .where(sql`${table.isSearchable} = true`),
    index("product_search_index_category_idx").on(table.categoryId),
    index("product_search_index_brand_idx").on(table.brandId),
    check("product_search_index_price_non_negative", sql`${table.pricePaise} >= 0`),
  ],
);

/** Autocomplete entries, refreshed from the catalog by `search.service.ts`. */
export const searchSuggestions = pgTable(
  "search_suggestions",
  {
    ...idColumn,
    term: text("term").notNull(),
    /** PRODUCT links straight to a PDP; CATEGORY/BRAND to a listing. */
    kind: text("kind").notNull().default("PRODUCT"),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id").references(() => brands.id, { onDelete: "cascade" }),
    /** How strongly to rank it in the dropdown. */
    weight: real("weight").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("search_suggestions_unique_key").on(table.term, table.kind, table.productId),
    index("search_suggestions_prefix_idx").using("gin", sql`${table.term} gin_trgm_ops`),
    index("search_suggestions_weight_idx").on(table.weight),
  ],
);

/** Raw queries for suggestion mining, zero-result detection and tuning. */
export const searchQueryLogs = pgTable(
  "search_query_logs",
  {
    ...idColumn,
    query: text("query").notNull(),
    normalizedQuery: text("normalized_query").notNull(),
    resultCount: integer("result_count").notNull().default(0),
    tookMs: integer("took_ms"),
    /** Hashed, salted session identifier — never a raw IP or user id. */
    sessionHash: text("session_hash"),
    /* ── Part 12 additions ─────────────────────────────────────────────── */
    /** The query after spell correction, when a correction was applied. */
    correctedQuery: text("corrected_query"),
    /** True when the shopper was shown results for `correctedQuery` instead. */
    wasCorrected: boolean("was_corrected").notNull().default(false),
    /** Ranking configuration version that produced these results. */
    rankingVersion: text("ranking_version"),
    /** Active experiment variant, when the session was bucketed into one. */
    experimentVariant: text("experiment_variant"),
    /** Facets/sort in force, so an analytics row is reproducible. */
    filterSignature: text("filter_signature"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("search_query_logs_normalized_idx").on(table.normalizedQuery, sql`${table.createdAt} desc`),
    // Trending/rising queries are computed over a window grouped by query, so
    // the ranking lives on the same columns the grouping does.
    index("search_query_logs_version_time_idx").on(table.rankingVersion, sql`${table.createdAt} desc`),
    index("search_query_logs_zero_results_idx")
      .on(sql`${table.createdAt} desc`)
      .where(sql`${table.resultCount} = 0`),
    check("search_query_logs_result_count_non_negative", sql`${table.resultCount} >= 0`),
  ],
);

/* ═══════════════════════════════════════════════════════════════════════
 * BULK IMPORT (consumed by the C ingestion utility)
 * ═════════════════════════════════════════════════════════════════════ */

export const importBatches = pgTable(
  "import_batches",
  {
    ...idColumn,
    source: text("source").notNull().default("csv"),
    fileName: text("file_name"),
    /** Content hash so re-uploading the same file is idempotent. */
    fileHash: text("file_hash"),
    status: text("status").notNull().default("PENDING"),
    totalRows: integer("total_rows").notNull().default(0),
    importedRows: integer("imported_rows").notNull().default(0),
    rejectedRows: integer("rejected_rows").notNull().default(0),
    /** Per-row rejection detail, kept small by design. */
    errorReport: jsonb("error_report"),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (table) => [
    index("import_batches_status_idx").on(table.status, sql`${table.createdAt} desc`),
    uniqueIndex("import_batches_file_hash_key").on(table.fileHash).where(sql`${table.fileHash} IS NOT NULL`),
    check("import_batches_counts_non_negative", sql`${table.totalRows} >= 0 AND ${table.importedRows} >= 0 AND ${table.rejectedRows} >= 0`),
  ],
);

export type Brand = typeof brands.$inferSelect;
export type NewBrand = typeof brands.$inferInsert;
export type AttributeDefinition = typeof attributeDefinitions.$inferSelect;
export type NewAttributeDefinition = typeof attributeDefinitions.$inferInsert;
export type AttributeOption = typeof attributeOptions.$inferSelect;
export type NewAttributeOption = typeof attributeOptions.$inferInsert;
export type VariantAttribute = typeof variantAttributes.$inferSelect;
export type InventoryLedgerEntry = typeof inventoryLedger.$inferSelect;
export type PriceRule = typeof productPriceRules.$inferSelect;
export type ProductRelation = typeof productRelations.$inferSelect;
export type CatalogEvent = typeof catalogEvents.$inferSelect;
export type ProductSearchIndexRow = typeof productSearchIndex.$inferSelect;
export type SearchSuggestion = typeof searchSuggestions.$inferSelect;
export type ImportBatch = typeof importBatches.$inferSelect;
