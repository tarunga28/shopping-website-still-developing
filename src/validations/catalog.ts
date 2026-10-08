import { z } from "zod";
import { productDetailsSchema } from "@/lib/catalog/product-details";
import { DESIGN_PLACEMENTS, PRODUCT_STATUSES, PRODUCT_TYPES } from "@/lib/catalog-rules";

const moneyInput = z.string().trim().max(16);
const optionalMoney = z.string().trim().max(16).optional().or(z.literal(""));
const id = z.string().uuid();
const slugInput = z
  .string()
  .trim()
  .toLowerCase()
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use a lowercase URL-safe slug.");

export const productWriteSchema = z.object({
  name: z.string().trim().min(2, "Name needs at least 2 characters.").max(160),
  slug: z.string().trim().max(80).optional().or(z.literal("")),
  shortDescription: z.string().trim().max(280).optional().or(z.literal("")),
  description: z.string().trim().max(8000).optional().or(z.literal("")),
  productType: z.enum(PRODUCT_TYPES),
  categoryIds: z.array(id).max(12).default([]),
  primaryCategoryId: id.optional().or(z.literal("")),
  collectionIds: z.array(id).max(20).default([]),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  basePrice: moneyInput,
  compareAt: optionalMoney,
  currency: z.literal("INR").default("INR"),
  seoTitle: z.string().trim().max(70).optional().or(z.literal("")),
  seoDescription: z.string().trim().max(160).optional().or(z.literal("")),
  adminNotes: z.string().trim().max(2000).optional().or(z.literal("")),
  estimatedShipping: optionalMoney,
  estimatedPaymentFee: optionalMoney,
  supplierMappingRequired: z.boolean().default(false),
  designId: id.optional().or(z.literal("")),
  placement: z.enum(DESIGN_PLACEMENTS).default("FRONT"),
  /** Storefront copy (features, materials, fit, care, specs). Omitted = leave unchanged. */
  details: productDetailsSchema.optional(),
});

export const variantWriteSchema = z.object({
  sku: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[A-Z0-9][A-Z0-9-]*$/, "SKU must be uppercase letters, numbers, and hyphens."),
  name: z.string().trim().min(1).max(80),
  size: z.string().trim().max(16).optional().or(z.literal("")),
  color: z.string().trim().max(40).optional().or(z.literal("")),
  price: moneyInput,
  compareAt: optionalMoney,
  availability: z.enum(["IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK", "PREORDER"]),
  weightGrams: z.number().int().positive().max(20000).nullable().optional(),
});

export const categoryWriteSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().max(80).optional().or(z.literal("")),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  parentId: id.optional().or(z.literal("")),
  seoTitle: z.string().trim().max(70).optional().or(z.literal("")),
  seoDescription: z.string().trim().max(160).optional().or(z.literal("")),
  displayOrder: z.number().int().min(0).max(9999).default(0),
});

export const collectionWriteSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().max(80).optional().or(z.literal("")),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).default("DRAFT"),
  seoTitle: z.string().trim().max(70).optional().or(z.literal("")),
  seoDescription: z.string().trim().max(160).optional().or(z.literal("")),
  displayOrder: z.number().int().min(0).max(9999).default(0),
  startsAt: z.string().trim().max(40).optional().or(z.literal("")),
  endsAt: z.string().trim().max(40).optional().or(z.literal("")),
  productIds: z.array(id).max(200).default([]),
});

export const bulkSchema = z.object({
  action: z.enum(["ARCHIVE", "PUBLISH", "ADD_COLLECTION", "REMOVE_COLLECTION", "CHANGE_CATEGORY"]),
  productIds: z.array(id).min(1).max(100),
  confirmation: z.string().trim().max(40),
  categoryId: id.optional(),
  collectionId: id.optional(),
});

export const catalogQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  category: slugInput.optional(),
  collection: slugInput.optional(),
  type: z.enum(PRODUCT_TYPES).optional(),
  minPricePaise: z.number().int().nonnegative().optional(),
  maxPricePaise: z.number().int().nonnegative().optional(),
  color: z.string().trim().max(40).optional(),
  size: z.string().trim().max(16).optional(),
  availability: z.enum(["IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK", "PREORDER"]).optional(),
  status: z.enum(PRODUCT_STATUSES).optional(),
  tag: slugInput.optional(),
  sort: z.enum(["newest", "oldest", "price-asc", "price-desc", "name", "popularity"]).optional(),
  page: z.number().int().positive().optional(),
  pageSize: z.union([z.literal(20), z.literal(50), z.literal(100)]).optional(),
});

/* ── Part 11: catalog intelligence ─────────────────────────────────────── */

/**
 * Money for Part 11 endpoints is a non-negative integer of paise, not a decimal
 * string. The older write schemas predate that and accept strings so admin forms
 * can post "499.00"; new endpoints take paise directly because a stringly-typed
 * price that a client has to format is where rounding bugs get born.
 */
const paise = z.number().int().nonnegative().max(100_000_000);
const basisPoints = z.number().int().min(0).max(10_000);
/** A remote media reference: absolute http(s) URL or a bare storage key. */
const mediaRef = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(
    (value) =>
      /^https?:\/\/[^\s/?#]+\.[^\s/?#]+/i.test(value) ||
      // A storage key has no scheme, no leading slash, and no traversal.
      (/^[a-z0-9][a-z0-9._\-/]{0,511}$/i.test(value) && !value.includes("..")),
    "Must be an absolute http(s) URL or a storage key.",
  );

export const INVENTORY_OPERATIONS = [
  "STOCK_IN",
  "SALE",
  "RETURN",
  "CANCELLATION",
  "MANUAL_ADJUSTMENT",
  "DAMAGE",
  "RESERVED",
  "RELEASED",
] as const;

/**
 * Must stay in lockstep with the `inventory_reference` pgEnum in
 * src/db/schema/enums.ts. The previous list carried ORDER_LINE / TRANSFER /
 * COUNT, which are not in the database enum — a request naming any of them
 * would pass validation and then fail at the driver.
 */
export const INVENTORY_REFERENCE_TYPES = [
  "ORDER",
  "ORDER_ITEM",
  "RETURN",
  "CANCELLATION",
  "PURCHASE_ORDER",
  "IMPORT_BATCH",
  "MANUAL",
] as const;

export const inventoryAdjustSchema = z.object({
  variantId: id,
  operation: z.enum(INVENTORY_OPERATIONS),
  /** Signed movement. Sign is checked against the operation in the service. */
  quantity: z.number().int().min(-1_000_000).max(1_000_000).refine((v) => v !== 0, "Quantity cannot be zero."),
  reason: z.string().trim().max(500).optional().or(z.literal("")),
  referenceType: z.enum(INVENTORY_REFERENCE_TYPES).optional(),
  referenceId: z.string().trim().max(64).optional().or(z.literal("")),
});

export const inventorySetSchema = z.object({
  variantId: id,
  /** Absolute target; the service derives the movement from the current stock. */
  quantity: paise,
  reason: z.string().trim().min(1).max(500),
  referenceType: z.enum(INVENTORY_REFERENCE_TYPES).optional(),
  referenceId: z.string().trim().max(64).optional().or(z.literal("")),
});

export const brandWriteSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: slugInput.optional().or(z.literal("")),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  logoUrl: mediaRef.optional().or(z.literal("")),
  bannerUrl: mediaRef.optional().or(z.literal("")),
  website: z
    .string()
    .trim()
    .url()
    .refine((value) => /^https?:\/\//i.test(value), "Website must be an absolute http(s) URL.")
    .optional()
    .or(z.literal("")),
  seoTitle: z.string().trim().max(70).optional().or(z.literal("")),
  seoDescription: z.string().trim().max(170).optional().or(z.literal("")),
  displayOrder: z.number().int().min(0).max(9999).default(0),
  isActive: z.boolean().default(true),
});

export const priceRuleWriteSchema = z.object({
  ruleType: z.enum(["AUTOMATIC", "CAMPAIGN", "SELLER", "SCHEDULED"]).default("AUTOMATIC"),
  discountType: z.enum(["PERCENTAGE", "FIXED_AMOUNT"]),
  /** PERCENTAGE -> basis points (2500 = 25%). FIXED_AMOUNT -> paise. */
  discountValue: z.number().int().positive().max(10_000_000),
  maxDiscountPaise: paise.optional().or(z.literal("")),
  priority: z.number().int().min(0).max(9999).default(100),
  stackable: z.boolean().default(true),
  name: z.string().trim().min(1).max(80).default("Discount"),
  variantId: id.optional().or(z.literal("")),
  sellerId: id.optional().or(z.literal("")),
  startsAt: z.string().datetime({ offset: true }).optional().or(z.literal("")),
  endsAt: z.string().datetime({ offset: true }).optional().or(z.literal("")),
  isActive: z.boolean().default(true),
});

export const mediaWriteSchema = z.object({
  url: mediaRef,
  storageKey: z.string().trim().max(512).optional().or(z.literal("")),
  thumbnailUrl: mediaRef.optional().or(z.literal("")),
  externalUrl: mediaRef.optional().or(z.literal("")),
  altText: z.string().trim().max(250).default(""),
  mediaKind: z.enum(["IMAGE", "VIDEO", "SPIN_360"]).default("IMAGE"),
  format: z.string().trim().max(16).optional().or(z.literal("")),
  width: z.number().int().positive().max(20000).optional().or(z.literal("")),
  height: z.number().int().positive().max(20000).optional().or(z.literal("")),
  fileSizeBytes: z.number().int().nonnegative().optional().or(z.literal("")),
  durationMs: z.number().int().nonnegative().optional().or(z.literal("")),
  frameCount: z.number().int().min(2).max(72).optional().or(z.literal("")),
  role: z.enum(["PRIMARY", "GALLERY", "HOVER", "THUMBNAIL", "MOBILE", "SOCIAL"]).default("GALLERY"),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  variantId: id.optional().or(z.literal("")),
});

export const mediaReorderSchema = z.object({
  orderedIds: z.array(id).min(1).max(100),
});

/**
 * Variant write for the attribute engine.
 *
 * `attributes` is the flexible path (axis code -> value); `size`/`color` remain
 * for Parts 1-10 rows and are mirrored into the legacy columns by the service.
 * Requiring neither is deliberate — a single-variant product has no axes.
 */
export const flexibleVariantWriteSchema = z.object({
  sku: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[A-Z0-9][A-Z0-9-_]*$/, "SKU must be uppercase letters, numbers, hyphens, or underscores."),
  name: z.string().trim().min(1).max(120),
  price: paise,
  compareAtPrice: paise.optional().or(z.literal("")),
  costPrice: paise.optional().or(z.literal("")),
  barcode: z.string().trim().max(64).optional().or(z.literal("")),
  /** Opening stock. Written as a STOCK_IN ledger row, not as a bare column set. */
  stockQuantity: paise.default(0),
  imageId: id.optional().or(z.literal("")),
  size: z.string().trim().max(16).optional().or(z.literal("")),
  color: z.string().trim().max(40).optional().or(z.literal("")),
  weightGrams: z.number().int().positive().max(20000).optional().or(z.literal("")),
  position: z.number().int().min(0).max(9999).default(0),
  attributes: z.record(z.string().trim().min(1).max(40), z.string().trim().min(1).max(80)).default({}),
});

/** Bulk variant generation: axes with values, plus a price/stock template. */
export const variantGenerateSchema = z.object({
  axes: z
    .array(
      z.object({
        code: z.string().trim().min(1).max(40),
        label: z.string().trim().min(1).max(60).optional().or(z.literal("")),
        values: z.array(z.string().trim().min(1).max(80)).min(1).max(50),
      }),
    )
    .min(1)
    .max(6),
  skuPrefix: z.string().trim().max(32).optional().or(z.literal("")),
  price: paise,
  stockQuantity: paise.default(0),
});

export const attributeDefinitionSchema = z.object({
  code: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(60),
  type: z.enum(["TEXT", "NUMBER", "BOOLEAN", "SELECT", "COLOR", "DATE"]).default("TEXT"),
  unit: z.string().trim().max(16).optional().or(z.literal("")),
  isVariantAxis: z.boolean().default(false),
  isRequired: z.boolean().default(false),
  isFilterable: z.boolean().default(true),
  displayOrder: z.number().int().min(0).max(9999).default(0),
  options: z.array(z.string().trim().min(1).max(80)).max(200).default([]),
});

export const categoryMoveSchema = z.object({
  parentId: id.optional().or(z.literal("")),
  /** Optional new slug; the service rewrites the whole subtree's paths. */
  slug: slugInput.optional().or(z.literal("")),
});

export const categoryReorderSchema = z.object({
  parentId: id.optional().or(z.literal("")),
  orderedIds: z.array(id).min(1).max(200),
});

export type ProductWriteInput = z.infer<typeof productWriteSchema>;
export type VariantWriteInput = z.infer<typeof variantWriteSchema>;
export type CategoryWriteInput = z.infer<typeof categoryWriteSchema>;
export type CollectionWriteInput = z.infer<typeof collectionWriteSchema>;
export type BulkInput = z.infer<typeof bulkSchema>;
export type InventoryAdjustInput = z.infer<typeof inventoryAdjustSchema>;
export type InventorySetInput = z.infer<typeof inventorySetSchema>;
export type BrandWriteInput = z.infer<typeof brandWriteSchema>;
export type PriceRuleWriteInput = z.infer<typeof priceRuleWriteSchema>;
export type MediaWriteInput = z.infer<typeof mediaWriteSchema>;
export type FlexibleVariantWriteInput = z.infer<typeof flexibleVariantWriteSchema>;
export type VariantGenerateInput = z.infer<typeof variantGenerateSchema>;
export type AttributeDefinitionInput = z.infer<typeof attributeDefinitionSchema>;
export type CategoryMoveInput = z.infer<typeof categoryMoveSchema>;
