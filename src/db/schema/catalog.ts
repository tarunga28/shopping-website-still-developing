import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
  productStatusEnum,
  productTypeEnum,
} from "./enums";
import { idColumn, money, moneyNullable, timestamps, timestampsNoUpdate } from "./helpers";
import { users } from "./users";

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
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),
    displayOrder: integer("display_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("categories_slug_key").on(table.slug),
    index("categories_parent_id_idx").on(table.parentId),
    index("categories_active_idx").on(table.isActive),
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

/* ── Products ─────────────────────────────────────────────────────────── */
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
    check("products_base_price_non_negative", sql`${table.basePrice} >= 0`),
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

/* ── Product variants (the purchasable unit) ──────────────────────────── */
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
    availability: availabilityStatusEnum("availability").notNull().default("IN_STOCK"),
    weightGrams: integer("weight_grams"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("product_variants_sku_key").on(table.sku),
    index("product_variants_product_idx").on(table.productId),
    index("product_variants_availability_idx").on(table.availability),
    index("product_variants_size_idx").on(table.size),
    index("product_variants_color_idx").on(table.color),
    index("product_variants_product_availability_idx").on(table.productId, table.availability),
    uniqueIndex("product_variants_combo_key").on(
      table.productId,
      sql`coalesce(${table.size}, '')`,
      sql`coalesce(${table.color}, '')`,
    ),
    check("product_variants_price_non_negative", sql`${table.price} >= 0`),
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

/* ── Images / media metadata (binaries live in object storage) ────────── */
export const images = pgTable(
  "images",
  {
    ...idColumn,
    type: imageTypeEnum("type").notNull(),
    url: text("url").notNull(),
    /** Object-storage key (S3/R2) when the file is CDN-hosted. */
    storageKey: text("storage_key"),
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
    index("images_design_idx").on(table.designId),
    index("images_variant_idx").on(table.variantId),
    index("images_category_idx").on(table.categoryId),
    index("images_collection_idx").on(table.collectionId),
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
