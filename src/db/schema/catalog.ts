import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import {
  availabilityStatusEnum,
  collectionStatusEnum,
  copyrightStatusEnum,
  designPlacementEnum,
  designStatusEnum,
  imageRoleEnum,
  imageTypeEnum,
  mediaKindEnum,
  productStatusEnum,
  productTypeEnum,
  productVisibilityEnum,
} from "./enums";
import { idColumn, money, moneyNullable, timestamps, timestampsNoUpdate, tsvector } from "./helpers";
import { users } from "./users";

/* ── Brands ─────────────────────────────────────────────────────────────
 * Normalized brand catalog. `products.brandId` points here; the legacy
 * `products.brand` text column is retained as a display fallback so existing
 * rows and the POD supplier mapping keep working during migration.
 */
export const brands = pgTable(
  "brands",
  {
    ...idColumn,
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    /** Object-storage key or absolute URL — never a local filesystem path. */
    logoUrl: text("logo_url"),
    bannerUrl: text("banner_url"),
    website: text("website"),
    /** Seller who owns the brand (NULL = house brand owned by the platform). */
    sellerId: uuid("seller_id").references(() => users.id, { onDelete: "set null" }),
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),
    displayOrder: integer("display_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("brands_slug_key").on(table.slug),
    uniqueIndex("brands_name_key").on(sql`lower(${table.name})`),
    index("brands_active_idx").on(table.isActive),
    index("brands_seller_idx").on(table.sellerId),
    index("brands_order_idx").on(table.displayOrder, table.name),
  ],
);

/* ── Categories (self-nesting) ────────────────────────────────────────── */
export const categories = pgTable(
  "categories",
  {
    ...idColumn,
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    parentId: uuid("parent_id").references((): AnyPgColumn => categories.id, {
      onDelete: "set null",
    }),
    /**
     * Materialized path of ancestor slugs, e.g. "electronics/mobiles/smartphones".
     * Denormalized for two reasons: (1) `LIKE 'electronics/%'` resolves a whole
     * subtree with one index scan instead of a recursive CTE, (2) the storefront
     * URL for a nested category is exactly this path, so no join is needed to
     * render breadcrumbs. Kept correct by `category.service.ts` on every move.
     */
    path: text("path").notNull(),
    /** 0 = root. Redundant with `path` but avoids a string split per row. */
    depth: integer("depth").notNull().default(0),
    /** Denormalized slug chain (ids, '/'-separated) for ancestor filtering. */
    ancestorIds: text("ancestor_ids").notNull().default(""),
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),
    displayOrder: integer("display_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("categories_slug_key").on(table.slug),
    uniqueIndex("categories_path_key").on(table.path),
    index("categories_parent_id_idx").on(table.parentId),
    index("categories_active_idx").on(table.isActive),
    index("categories_path_prefix_idx").on(table.path).where(sql`${table.isActive} = true`),
    index("categories_depth_order_idx").on(table.depth, table.displayOrder, table.name),
  ],
);

/* ── Collections ──────────────────────────────────────────────────────── */
export const collections = pgTable(
  "collections",
  {
    ...idColumn,
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    status: collectionStatusEnum("status").notNull().default("DRAFT"),
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),
    displayOrder: integer("display_order").notNull().default(0),
    startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }),
    endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (table) => [uniqueIndex("collections_slug_key").on(table.slug)],
);

/* ── Products ───────────────────────────────────────────────────────────
 * Category image / banner are NOT columns here: they live in the `images`
 * table as rows with `categoryId` set and `type` = CATEGORY (role PRIMARY)
 * or BANNER. One source of truth for media.
 */
export const products = pgTable(
  "products",
  {
    ...idColumn,
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    shortDescription: text("short_description"),
    productType: productTypeEnum("product_type").notNull(),
    status: productStatusEnum("status").notNull().default("DRAFT"),
    /** Storefront exposure. Listed only when status = ACTIVE and this is PUBLIC. */
    visibility: productVisibilityEnum("visibility").notNull().default("PUBLIC"),
    /** Integer minor units (paise). CHECK below guards against negatives. */
    basePrice: money("base_price"),
    compareAtPrice: moneyNullable("compare_at_price"),
    currency: text("currency").notNull().default("INR"),
    brand: text("brand").notNull().default("Inkline"),
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
    adminNotes: text("admin_notes"),
    estimatedShippingPaise: integer("estimated_shipping_paise"),
    estimatedPaymentFeePaise: integer("estimated_payment_fee_paise"),
    supplierMappingRequired: boolean("supplier_mapping_required").notNull().default(false),
    /**
     * Structured storefront copy (features, materials, fit, care, print details,
     * specs). Validated by `productDetailsSchema` on write AND on read — the
     * column is untrusted JSON as far as the storefront is concerned.
     */
    details: jsonb("details"),

    /* ── Ownership & taxonomy (Part 11) ──────────────────────────────── */
    /** Seller/merchant who owns the listing. NULL = platform-owned. */
    sellerId: uuid("seller_id").references(() => users.id, { onDelete: "set null" }),
    brandId: uuid("brand_id").references(() => brands.id, { onDelete: "set null" }),
    /** Primary category. Additional categories live in `product_categories`. */
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
    /** Optional leaf refinement (must be a descendant of `categoryId`). */
    subcategoryId: uuid("subcategory_id").references(() => categories.id, { onDelete: "set null" }),

    /* ── Cost, tax & identification ──────────────────────────────────── */
    /** Never exposed publicly — `toPublicProduct` strips it. */
    costPrice: moneyNullable("cost_price"),
    /** Tax rate in basis points: 1800 = 18.00%. Integer, so no float drift. */
    taxRateBp: integer("tax_rate_bp").notNull().default(0),
    barcode: text("barcode"),

    /* ── Inventory rollup (variants are authoritative; see inventory_ledger) */
    stockQuantity: integer("stock_quantity").notNull().default(0),
    lowStockThreshold: integer("low_stock_threshold").notNull().default(5),

    /* ── Logistics ───────────────────────────────────────────────────── */
    weightGrams: integer("weight_grams"),
    lengthMm: integer("length_mm"),
    widthMm: integer("width_mm"),
    heightMm: integer("height_mm"),

    /* ── Merchandising flags ─────────────────────────────────────────── */
    featured: boolean("featured").notNull().default(false),
    isNew: boolean("is_new").notNull().default(false),
    isBestSeller: boolean("is_best_seller").notNull().default(false),

    /* ── Denormalized review cache (rebuilt from `reviews`) ───────────── */
    ratingAverage: real("rating_average"),
    ratingCount: integer("rating_count").notNull().default(0),

    /**
     * Full-text search vector. Written by `search.service.ts` from
     * name/brand/category/tags/attributes/skus with field weights, and indexed
     * by GIN. Reads use `websearch_to_tsquery` — never string-concatenated SQL.
     */
    searchVector: tsvector("search_vector"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("products_slug_key").on(table.slug),
    index("products_status_idx").on(table.status),
    index("products_type_idx").on(table.productType),
    index("products_name_idx").on(table.name),
    index("products_published_at_idx").on(table.publishedAt),
    index("products_status_published_idx").on(table.status, table.publishedAt),
    // Storefront browsing: partial indexes over ACTIVE rows only, one per sort order.
    index("products_active_published_idx")
      .on(sql`${table.publishedAt} desc nulls last`, table.id)
      .where(sql`${table.status} = 'ACTIVE'`),
    index("products_active_price_idx").on(table.basePrice, table.id).where(sql`${table.status} = 'ACTIVE'`),
    index("products_active_name_idx").on(sql`lower(${table.name})`, table.id).where(sql`${table.status} = 'ACTIVE'`),
    index("products_active_type_idx").on(table.productType, table.id).where(sql`${table.status} = 'ACTIVE'`),

    /* ── Part 11 indexes. One per real query pattern, not per column ───── */
    index("products_category_idx").on(table.categoryId),
    index("products_subcategory_idx").on(table.subcategoryId),
    index("products_brand_idx").on(table.brandId),
    index("products_seller_idx").on(table.sellerId),
    index("products_created_at_idx").on(table.createdAt),
    // Partial: only the rows the storefront can ever list.
    index("products_listable_idx")
      .on(table.categoryId, sql`${table.publishedAt} desc nulls last`)
      .where(sql`${table.status} = 'ACTIVE' AND ${table.visibility} = 'PUBLIC'`),
    index("products_featured_idx").on(table.featured, sql`${table.publishedAt} desc nulls last`).where(
      sql`${table.status} = 'ACTIVE' AND ${table.visibility} = 'PUBLIC'`,
    ),
    index("products_low_stock_idx").on(table.stockQuantity).where(sql`${table.stockQuantity} <= ${table.lowStockThreshold}`),
    // Unique, but only when present — many products legitimately have no barcode.
    uniqueIndex("products_barcode_key")
      .on(table.barcode)
      .where(sql`${table.barcode} IS NOT NULL`),
    index("products_search_vector_idx").using("gin", table.searchVector),

    check("products_base_price_non_negative", sql`${table.basePrice} >= 0`),
    check("products_cost_price_non_negative", sql`${table.costPrice} IS NULL OR ${table.costPrice} >= 0`),
    check("products_stock_non_negative", sql`${table.stockQuantity} >= 0`),
    check("products_low_stock_threshold_non_negative", sql`${table.lowStockThreshold} >= 0`),
    check("products_tax_rate_range", sql`${table.taxRateBp} >= 0 AND ${table.taxRateBp} <= 10000`),
    check("products_rating_range", sql`${table.ratingAverage} IS NULL OR (${table.ratingAverage} >= 0 AND ${table.ratingAverage} <= 5)`),
    check("products_rating_count_non_negative", sql`${table.ratingCount} >= 0`),
    check("products_weight_positive", sql`${table.weightGrams} IS NULL OR ${table.weightGrams} > 0`),
    check(
      "products_dimensions_positive",
      sql`(${table.lengthMm} IS NULL OR ${table.lengthMm} > 0)
         AND (${table.widthMm} IS NULL OR ${table.widthMm} > 0)
         AND (${table.heightMm} IS NULL OR ${table.heightMm} > 0)`,
    ),
    check(
      "products_compare_at_not_below",
      sql`${table.compareAtPrice} IS NULL OR ${table.compareAtPrice} >= ${table.basePrice}`,
    ),
    check(
      "products_shipping_non_negative",
      sql`${table.estimatedShippingPaise} IS NULL OR ${table.estimatedShippingPaise} >= 0`,
    ),
    check(
      "products_fee_non_negative",
      sql`${table.estimatedPaymentFeePaise} IS NULL OR ${table.estimatedPaymentFeePaise} >= 0`,
    ),
  ],
);

/* ── Product ↔ Category / Collection (many-to-many) ───────────────────── */
export const productCategories = pgTable(
  "product_categories",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    isPrimary: boolean("is_primary").notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.productId, table.categoryId] }),
    index("product_categories_category_idx").on(table.categoryId),
  ],
);

export const productCollections = pgTable(
  "product_collections",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    displayOrder: integer("display_order").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.productId, table.collectionId] }),
    index("product_collections_collection_idx").on(table.collectionId),
  ],
);

/* ── Product variants (the purchasable unit) ────────────────────────────
 * `size`/`color` are RETAINED for backward compatibility with Parts 1–10
 * (PDP selectors, filters, POD supplier mapping all read them) and are kept in
 * sync with the generic attribute rows by `variant.service.ts`. The flexible
 * axis values live in `variant_attributes` (catalog-intelligence.ts) — that is
 * where new axes such as Storage or Fit are added, with no schema change.
 */
export const productVariants = pgTable(
  "product_variants",
  {
    ...idColumn,
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** Unique internal SKU — never reused, never the supplier's SKU. */
    sku: text("sku").notNull(),
    /** Human label, e.g. "Black / M". */
    name: text("name").notNull(),
    size: text("size"),
    color: text("color"),
    colorCode: text("color_code"),
    price: money("price"),
    compareAtPrice: moneyNullable("compare_at_price"),
    /** Variant cost — never exposed publicly. */
    costPrice: moneyNullable("cost_price"),
    /** GTIN/EAN/UPC. Unique when present; many variants legitimately have none. */
    barcode: text("barcode"),
    availability: availabilityStatusEnum("availability").notNull().default("IN_STOCK"),
    weightGrams: integer("weight_grams"),
    lengthMm: integer("length_mm"),
    widthMm: integer("width_mm"),
    heightMm: integer("height_mm"),
    /* ── Inventory. `stockQuantity` is derived from `inventory_ledger`; the
     *    ledger is the audit trail, this column is the fast read path.
     *    `reservedQuantity` is held-but-not-sold (carts, pending orders). */
    stockQuantity: integer("stock_quantity").notNull().default(0),
    reservedQuantity: integer("reserved_quantity").notNull().default(0),
    /** Variant-specific hero image (FK-less to avoid an import cycle; validated in the service). */
    imageId: uuid("image_id"),
    /** Retired variants keep their rows (order history) but leave the storefront. */
    isActive: boolean("is_active").notNull().default(true),
    position: integer("position").notNull().default(0),
    /**
     * Hash of the variant's full attribute set ("size:m|color:black"), written by
     * `variant.service.ts`. The unique index below is what actually stops two
     * variants from claiming the same combination — `product_variants_combo_key`
     * only covers the legacy size/colour pair.
     */
    comboHash: text("combo_hash"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("product_variants_sku_key").on(table.sku),
    uniqueIndex("product_variants_barcode_key")
      .on(table.barcode)
      .where(sql`${table.barcode} IS NOT NULL`),
    index("product_variants_product_idx").on(table.productId),
    index("product_variants_availability_idx").on(table.availability),
    index("product_variants_size_idx").on(table.size),
    index("product_variants_color_idx").on(table.color),
    index("product_variants_product_availability_idx").on(table.productId, table.availability),
    index("product_variants_product_position_idx").on(table.productId, table.position),
    index("product_variants_active_product_idx").on(table.productId, table.stockQuantity).where(
      sql`${table.isActive} = true`,
    ),
    /**
     * Legacy size/colour uniqueness. Scoped to rows with no `comboHash` —
     * Part 11 variants are identified by their attribute set instead, and a
     * product whose axes are Storage × Colour would otherwise be limited to a
     * single variant because every row has NULL size and NULL colour.
     */
    uniqueIndex("product_variants_combo_key")
      .on(table.productId, sql`coalesce(${table.size}, '')`, sql`coalesce(${table.color}, '')`)
      .where(sql`${table.comboHash} IS NULL`),
    /** Flexible-axis uniqueness: no two variants of a product share an attribute set. */
    uniqueIndex("product_variants_attribute_combo_key")
      .on(table.productId, table.comboHash)
      .where(sql`${table.comboHash} IS NOT NULL`),
    check("product_variants_price_non_negative", sql`${table.price} >= 0`),
    check("product_variants_cost_non_negative", sql`${table.costPrice} IS NULL OR ${table.costPrice} >= 0`),
    check("product_variants_stock_non_negative", sql`${table.stockQuantity} >= 0`),
    check("product_variants_reserved_non_negative", sql`${table.reservedQuantity} >= 0`),
    check("product_variants_reserved_within_stock", sql`${table.reservedQuantity} <= ${table.stockQuantity}`),
    check("product_variants_position_non_negative", sql`${table.position} >= 0`),
    check("product_variants_weight_positive", sql`${table.weightGrams} IS NULL OR ${table.weightGrams} > 0`),
    check(
      "product_variants_compare_at_not_below",
      sql`${table.compareAtPrice} IS NULL OR ${table.compareAtPrice} >= ${table.price}`,
    ),
  ],
);

/* ── Designs (reusable artwork, independent of products) ──────────────── */
export const designs = pgTable(
  "designs",
  {
    ...idColumn,
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    status: designStatusEnum("status").notNull().default("DRAFT"),
    /** Designer (staff user). Kept nullable so removing a user never orphans art. */
    designerId: uuid("designer_id").references(() => users.id, { onDelete: "set null" }),
    copyrightStatus: copyrightStatusEnum("copyright_status").notNull().default("PENDING_REVIEW"),
    licenseInfo: text("license_info"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("designs_slug_key").on(table.slug),
    index("designs_status_idx").on(table.status),
  ],
);

/** Design ↔ Product placements (front/back/sleeve…). */
export const productDesigns = pgTable(
  "product_designs",
  {
    ...idColumn,
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    designId: uuid("design_id")
      .notNull()
      .references(() => designs.id, { onDelete: "cascade" }),
    placement: designPlacementEnum("placement").notNull().default("FRONT"),
    /** Placement-specific print file reference (storage key) — POD milestone. */
    printFileKey: text("print_file_key"),
    displayOrder: integer("display_order").notNull().default(0),
    ...timestampsNoUpdate,
  },
  (table) => [
    uniqueIndex("product_designs_unique_placement").on(table.productId, table.designId, table.placement),
    index("product_designs_design_idx").on(table.designId),
  ],
);

/* ── Tags (controlled vocabulary via relations) ───────────────────────── */
export const tags = pgTable(
  "tags",
  {
    ...idColumn,
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    ...timestampsNoUpdate,
  },
  (table) => [uniqueIndex("tags_slug_key").on(table.slug), uniqueIndex("tags_name_key").on(table.name)],
);

export const productTags = pgTable(
  "product_tags",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.productId, table.tagId] }),
    index("product_tags_tag_idx").on(table.tagId),
  ],
);

export const designTags = pgTable(
  "design_tags",
  {
    designId: uuid("design_id")
      .notNull()
      .references(() => designs.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.designId, table.tagId] })],
);

/* ── Media metadata (binaries live in object storage) ─────────────────────
 * This is the platform media table: product images, variant images, gallery,
 * hover/thumbnail/mobile crops, category images, product videos and 360 spin
 * sets. Nothing here stores a local filesystem path — `url` is either an
 * absolute CDN URL or a storage-relative path resolved by `resolveMediaUrl`,
 * and `storageKey` is the object-storage key (S3/R2) the CDN fronts.
 */
export const images = pgTable(
  "images",
  {
    ...idColumn,
    type: imageTypeEnum("type").notNull(),
    /** IMAGE (default) | VIDEO | SPIN_360. Added in Part 11 — see `mediaKindEnum`. */
    mediaKind: mediaKindEnum("media_kind").notNull().default("IMAGE"),
    url: text("url").notNull(),
    /** Object-storage key (S3/R2) when the file is CDN-hosted. */
    storageKey: text("storage_key"),
    /** Poster/preview for VIDEO and first frame for SPIN_360. */
    thumbnailUrl: text("thumbnail_url"),
    /** Absolute URL when the media is hosted elsewhere (YouTube/Vimeo/Mux). */
    externalUrl: text("external_url"),
    /** Container/codec-ish hint: "webp", "mp4", "hls"… */
    format: text("format"),
    durationMs: integer("duration_ms"),
    /** Frame count for a 360 spin set; NULL for stills and video. */
    frameCount: integer("frame_count"),
    altText: text("alt_text").notNull().default(""),
    width: integer("width"),
    height: integer("height"),
    mimeType: text("mime_type"),
    fileSizeBytes: integer("file_size_bytes"),
    sortOrder: integer("sort_order").notNull().default(0),
    role: imageRoleEnum("role").notNull().default("GALLERY"),
    /** Exactly one entity FK is set per row (polymorphic, but fully
     *  referential — rows cascade with their owner). */
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
    designId: uuid("design_id").references(() => designs.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "cascade" }),
    collectionId: uuid("collection_id").references(() => collections.id, { onDelete: "cascade" }),
    ...timestampsNoUpdate,
  },
  (table) => [
    index("images_product_idx").on(table.productId),
    index("images_product_type_sort_idx").on(table.productId, table.type, table.sortOrder),
    index("images_product_kind_sort_idx").on(table.productId, table.mediaKind, table.sortOrder),
    index("images_design_idx").on(table.designId),
    index("images_variant_idx").on(table.variantId),
    index("images_category_idx").on(table.categoryId),
    index("images_collection_idx").on(table.collectionId),
    check("images_dimensions_positive", sql`(${table.width} IS NULL OR ${table.width} > 0) AND (${table.height} IS NULL OR ${table.height} > 0)`),
    check("images_file_size_non_negative", sql`${table.fileSizeBytes} IS NULL OR ${table.fileSizeBytes} >= 0`),
    check("images_duration_positive", sql`${table.durationMs} IS NULL OR ${table.durationMs} > 0`),
    check("images_frame_count_positive", sql`${table.frameCount} IS NULL OR ${table.frameCount} > 0`),
    check("images_sort_order_non_negative", sql`${table.sortOrder} >= 0`),
  ],
);

/** Previous public slugs for categories/collections, so renamed URLs keep redirecting. */
export const categorySlugHistory = pgTable(
  "category_slug_history",
  {
    ...idColumn,
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("category_slug_history_slug_key").on(table.slug),
    index("category_slug_history_category_idx").on(table.categoryId),
  ],
);

export const collectionSlugHistory = pgTable(
  "collection_slug_history",
  {
    ...idColumn,
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("collection_slug_history_slug_key").on(table.slug),
    index("collection_slug_history_collection_idx").on(table.collectionId),
  ],
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
/** Previous public slugs. A rename inserts here so old links can redirect. */
export const productSlugHistory = pgTable(
  "product_slug_history",
  {
    ...idColumn,
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("product_slug_history_slug_key").on(table.slug),
    index("product_slug_history_product_idx").on(table.productId),
  ],
);

/** Reusable color catalog. Product components read these rows — they do not hard-code a palette. */
export const colors = pgTable(
  "colors",
  {
    ...idColumn,
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    hex: text("hex").notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("colors_slug_key").on(table.slug),
    uniqueIndex("colors_name_key").on(sql`lower(${table.name})`),
  ],
);

/** Reusable sizes. Applicability is per product type, so a mug is not forced into XS–XXXL. */
export const sizes = pgTable(
  "sizes",
  {
    ...idColumn,
    code: text("code").notNull(),
    label: text("label").notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [uniqueIndex("sizes_code_key").on(table.code)],
);

export const sizeProductTypes = pgTable(
  "size_product_types",
  {
    sizeId: uuid("size_id")
      .notNull()
      .references(() => sizes.id, { onDelete: "cascade" }),
    productType: productTypeEnum("product_type").notNull(),
  },
  (table) => [primaryKey({ columns: [table.sizeId, table.productType] })],
);

export type ProductVariant = typeof productVariants.$inferSelect;
export type NewProductVariant = typeof productVariants.$inferInsert;
export type Category = typeof categories.$inferSelect;
export type Collection = typeof collections.$inferSelect;
export type Design = typeof designs.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type ProductImage = typeof images.$inferSelect;


/**
 * Real, product-type-specific size measurements shown in the PDP size guide.
 * One active chart per product type. No chart row → no size-guide button:
 * measurements are never invented.
 */
export const sizeCharts = pgTable(
  "size_charts",
  {
    ...idColumn,
    productType: productTypeEnum("product_type").notNull(),
    title: text("title").notNull(),
    /** Unit of the measurements (validated by `sizeChartSchema`). */
    unit: text("unit").notNull().default("cm"),
    /** string[] — first column is the size code, e.g. ["Size","Chest","Length"]. */
    columns: jsonb("columns").notNull(),
    /** string[][] — one row per size, same width as `columns`. */
    rows: jsonb("rows").notNull(),
    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("size_charts_active_type_key")
      .on(table.productType)
      .where(sql`${table.isActive} = true`),
  ],
);
