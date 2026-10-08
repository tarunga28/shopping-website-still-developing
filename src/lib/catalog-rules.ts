/**
 * Catalog rules shared by admin creation, future imports, and the public API.
 * Money is integer paise. Nothing here trusts a browser-supplied price.
 */

export const PRODUCT_TYPES = [
  "T_SHIRT",
  "HOODIE",
  "SWEATSHIRT",
  "MUG",
  "POSTER",
  "PHONE_CASE",
  "TOTE_BAG",
  "CUSTOM",
  "OTHER",
] as const;

export type CatalogProductType = (typeof PRODUCT_TYPES)[number];

export const PRODUCT_STATUSES = ["DRAFT", "ACTIVE", "ARCHIVED", "DISCONTINUED"] as const;
export type CatalogProductStatus = (typeof PRODUCT_STATUSES)[number];

export const DESIGN_PLACEMENTS = ["FRONT", "BACK", "LEFT_SLEEVE", "RIGHT_SLEEVE", "CENTER", "OTHER"] as const;
export type CatalogPlacement = (typeof DESIGN_PLACEMENTS)[number];

export const CLOTHING_TYPES: readonly CatalogProductType[] = ["T_SHIRT", "HOODIE", "SWEATSHIRT"];

export const CATALOG_EDITOR_ROLES = ["PRODUCT_MANAGER", "ADMIN", "SUPER_ADMIN"] as const;

export const PAGE_SIZES = [20, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export const CATALOG_SORTS = [
  "newest",
  "oldest",
  "price-asc",
  "price-desc",
  "name",
  "popularity",
] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];

export type PublicAvailability = "AVAILABLE" | "UNAVAILABLE" | "SOLD_OUT" | "COMING_SOON" | "DISCONTINUED";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX = /^#[0-9a-f]{6}$/i;
const MAX_PAGE = 500;
const MAX_BULK = 100;

export function canEditCatalog(role: string | null | undefined): boolean {
  return CATALOG_EDITOR_ROLES.includes(role as (typeof CATALOG_EDITOR_ROLES)[number]);
}

export function isProductType(value: string): value is CatalogProductType {
  return (PRODUCT_TYPES as readonly string[]).includes(value);
}

export function isProductStatus(value: string): value is CatalogProductStatus {
  return (PRODUCT_STATUSES as readonly string[]).includes(value);
}

/** Listed in shop, search, and category pages. */
export function isPubliclyListed(status: CatalogProductStatus): boolean {
  return status === "ACTIVE";
}

/** Direct URL still resolves. Draft and archived stay hidden. */
export function isPubliclyViewable(status: CatalogProductStatus): boolean {
  return status === "ACTIVE" || status === "DISCONTINUED";
}

export function canAcceptPurchase(status: CatalogProductStatus, variantAvailability: string): boolean {
  return status === "ACTIVE" && (variantAvailability === "IN_STOCK" || variantAvailability === "LOW_STOCK");
}

export function publicAvailability(
  status: CatalogProductStatus,
  variantAvailability: string | null,
): PublicAvailability {
  if (status === "DISCONTINUED") return "DISCONTINUED";
  if (status !== "ACTIVE") return "UNAVAILABLE";
  if (variantAvailability === "OUT_OF_STOCK") return "SOLD_OUT";
  if (variantAvailability === "PREORDER") return "COMING_SOON";
  if (variantAvailability === "IN_STOCK" || variantAvailability === "LOW_STOCK") return "AVAILABLE";
  return "UNAVAILABLE";
}

export function slugFromName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return SLUG.test(slug) ? slug : "product";
}

export function assertSlug(slug: string): string {
  const clean = slug.trim().toLowerCase();
  if (!SLUG.test(clean) || clean.length > 80) {
    throw new Error("Slug must be lowercase, URL-safe, and unique-ready.");
  }
  return clean;
}

export function parseInrToPaise(raw: string | number): number {
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 0) {
      throw new Error("Prices must be a non-negative integer number of paise.");
    }
    return raw;
  }
  const cleaned = raw.trim().replace(/[₹,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new Error("Enter a price like 999 or 999.50.");
  }
  const [whole, frac = ""] = cleaned.split(".");
  const paise = BigInt(whole) * BigInt(100) + BigInt((frac + "00").slice(0, 2));
  if (paise > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("That price is too large.");
  return Number(paise);
}

export function assertCompareAt(pricePaise: number, compareAtPaise: number | null | undefined): void {
  if (pricePaise < 0 || (compareAtPaise != null && compareAtPaise < 0)) {
    throw new Error("Prices cannot be negative.");
  }
  if (compareAtPaise != null && compareAtPaise < pricePaise) {
    throw new Error("Compare-at price cannot be lower than the selling price.");
  }
}

export interface MarginInput {
  sellingPaise: number;
  supplierCostPaise: number | null;
  shippingPaise: number | null;
  paymentFeePaise: number | null;
  discountPaise: number | null;
}

export interface MarginEstimate {
  label: "estimated_gross_margin";
  complete: boolean;
  sellingPaise: number;
  knownCostPaise: number;
  estimatedGrossMarginPaise: number | null;
}

/** Not profit. Missing costs leave the estimate incomplete instead of inventing a number. */
export function estimateGrossMargin(input: MarginInput): MarginEstimate {
  assertCompareAt(input.sellingPaise, null);
  const parts = [input.supplierCostPaise, input.shippingPaise, input.paymentFeePaise, input.discountPaise ?? 0];
  for (const part of parts) {
    if (part != null && (!Number.isInteger(part) || part < 0)) {
      throw new Error("Cost figures must be non-negative integer paise.");
    }
  }
  const complete = input.supplierCostPaise != null && input.shippingPaise != null && input.paymentFeePaise != null;
  const known = (input.supplierCostPaise ?? 0) + (input.shippingPaise ?? 0) + (input.paymentFeePaise ?? 0) + (input.discountPaise ?? 0);
  return {
    label: "estimated_gross_margin",
    complete,
    sellingPaise: input.sellingPaise,
    knownCostPaise: known,
    estimatedGrossMarginPaise: complete ? input.sellingPaise - known : null,
  };
}

/** Checkout and cart must call this. The client price is recorded only to detect tampering. */
export function quoteAuthoritativePrice(input: { serverPricePaise: number; clientPricePaise?: number | null }) {
  if (!Number.isInteger(input.serverPricePaise) || input.serverPricePaise < 0) {
    throw new Error("Server price is invalid.");
  }
  const client = input.clientPricePaise;
  return {
    pricePaise: input.serverPricePaise,
    clientPriceIgnored: true,
    mismatch: client != null && client !== input.serverPricePaise,
  };
}

export function variantComboKey(size: string | null | undefined, color: string | null | undefined): string {
  return `${(size ?? "").trim().toLowerCase()}|${(color ?? "").trim().toLowerCase()}`;
}

export function duplicateVariantCombos(
  variants: { size?: string | null; color?: string | null }[],
): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const variant of variants) {
    const key = variantComboKey(variant.size, variant.color);
    if (seen.has(key)) dupes.add(key);
    seen.add(key);
  }
  return [...dupes];
}

export interface SizeRule {
  code: string;
  label: string;
  productTypes: readonly CatalogProductType[];
}

export const DEFAULT_COLORS = [
  { name: "Black", hex: "#16130e" },
  { name: "Ecru", hex: "#efe9db" },
  { name: "White", hex: "#f7f4ee" },
  { name: "Ink", hex: "#111111" },
] as const;

export const SIZE_CATALOG: readonly SizeRule[] = [
  { code: "XS", label: "XS", productTypes: CLOTHING_TYPES },
  { code: "S", label: "S", productTypes: CLOTHING_TYPES },
  { code: "M", label: "M", productTypes: CLOTHING_TYPES },
  { code: "L", label: "L", productTypes: CLOTHING_TYPES },
  { code: "XL", label: "XL", productTypes: CLOTHING_TYPES },
  { code: "XXL", label: "XXL", productTypes: CLOTHING_TYPES },
  { code: "XXXL", label: "XXXL", productTypes: CLOTHING_TYPES },
  { code: "ONE", label: "One size", productTypes: ["MUG", "POSTER", "PHONE_CASE", "TOTE_BAG", "CUSTOM", "OTHER"] },
];

export function sizesForType(type: CatalogProductType, catalog: readonly SizeRule[] = SIZE_CATALOG): SizeRule[] {
  return catalog.filter((size) => size.productTypes.includes(type));
}

export function assertVariantForType(
  type: CatalogProductType,
  size: string | null | undefined,
  catalog: readonly SizeRule[] = SIZE_CATALOG,
): void {
  const allowed = new Set(sizesForType(type, catalog).map((size) => size.code));
  const code = size?.trim().toUpperCase() || null;
  if (CLOTHING_TYPES.includes(type)) {
    if (!code || !allowed.has(code)) {
      throw new Error("Clothing needs a valid size from the size list. A mug size is not valid here.");
    }
    return;
  }
  if (code && !allowed.has(code)) {
    throw new Error("That size does not apply to this product type.");
  }
}

export function assertHex(hex: string): string {
  const clean = hex.trim().toLowerCase();
  if (!HEX.test(clean)) throw new Error("Color needs a hex code like #111111.");
  return clean;
}

export function tagSlug(name: string): string {
  return slugFromName(name);
}

export function clampPageSize(value: number | null | undefined): PageSize {
  if (value === 50 || value === 100) return value;
  return 20;
}

export function clampPage(value: number | null | undefined): number {
  if (!value || !Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, MAX_PAGE);
}

export function bulkPhrase(action: "ARCHIVE" | "PUBLISH" | "ADD_COLLECTION" | "REMOVE_COLLECTION" | "CHANGE_CATEGORY", count: number): string {
  return `${action} ${count}`;
}

export function assertBulkConfirmation(action: Parameters<typeof bulkPhrase>[0], count: number, phrase: string): void {
  if (!Number.isInteger(count) || count < 1 || count > MAX_BULK) {
    throw new Error("Bulk actions are limited to 100 products and need an explicit confirmation.");
  }
  if (phrase !== bulkPhrase(action, count)) {
    throw new Error("Confirmation did not match. Nothing was changed.");
  }
}

/** Operations offered by the bulk inventory screen. */
export const BULK_INVENTORY_OPERATIONS = ["STOCK_IN", "MANUAL_ADJUSTMENT", "DAMAGE"] as const;
export type BulkInventoryOperation = (typeof BULK_INVENTORY_OPERATIONS)[number];

export const MAX_BULK_INVENTORY = MAX_BULK;

/**
 * The phrase an editor must type to apply one stock movement to many variants.
 *
 * Stock is the one bulk operation that can silently make the catalog wrong —
 * a misplaced digit here is 100 variants out by a factor of ten, and the error
 * surfaces later as oversold orders. So it gets the same typed-confirmation gate
 * as the destructive catalog bulk actions, and the phrase names the operation
 * so the editor cannot confirm one movement while intending another.
 */
export function bulkInventoryPhrase(operation: BulkInventoryOperation, count: number): string {
  return `${operation} ${count}`;
}

export function assertBulkInventoryConfirmation(
  operation: BulkInventoryOperation,
  count: number,
  phrase: string,
): void {
  if (!Number.isInteger(count) || count < 1 || count > MAX_BULK_INVENTORY) {
    throw new Error(`Bulk stock changes are limited to ${MAX_BULK_INVENTORY} variants and need an explicit confirmation.`);
  }
  if (phrase !== bulkInventoryPhrase(operation, count)) {
    throw new Error("Confirmation did not match. No stock was changed.");
  }
}

export interface PublishInput {
  name: string;
  description: string | null;
  shortDescription: string | null;
  slug: string;
  pricePaise: number;
  compareAtPaise: number | null;
  imageCount: number;
  categoryCount: number;
  variantCount: number;
  productType: CatalogProductType;
  supplierMappingRequired: boolean;
  supplierMapped: boolean;
}

export function publishBlockers(input: PublishInput): string[] {
  const blockers: string[] = [];
  if (!input.name.trim()) blockers.push("Product name is required.");
  if (!input.shortDescription?.trim() && !input.description?.trim()) {
    blockers.push("A short or full description is required.");
  }
  if (!input.slug || !SLUG.test(input.slug)) blockers.push("A valid SEO slug is required.");
  if (!Number.isInteger(input.pricePaise) || input.pricePaise < 0) blockers.push("A valid price is required.");
  try {
    assertCompareAt(input.pricePaise, input.compareAtPaise);
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : "Price is invalid.");
  }
  if (input.imageCount < 1) blockers.push("At least one product image is required.");
  if (input.categoryCount < 1) blockers.push("A category is required.");
  if (input.variantCount < 1) blockers.push("At least one variant is required.");
  if (input.supplierMappingRequired && !input.supplierMapped) {
    blockers.push("Supplier mapping is required for this product before it can be published.");
  }
  return blockers;
}

export interface PublicProductView {
  slug: string;
  name: string;
  description: string | null;
  pricePaise: number;
  compareAtPaise: number | null;
  currency: string;
  status: "ACTIVE" | "DISCONTINUED";
  availability: PublicAvailability;
  sku: string | null;
}

/** Drops admin notes, supplier cost, and mapping secrets. */
export function toPublicProduct(input: {
  slug: string;
  name: string;
  description: string | null;
  pricePaise: number;
  compareAtPaise: number | null;
  currency: string;
  status: CatalogProductStatus;
  availability: PublicAvailability;
  sku: string | null;
  adminNotes?: string | null;
  supplierCostPaise?: number | null;
  supplierVariantId?: string | null;
}): PublicProductView | null {
  if (input.status !== "ACTIVE" && input.status !== "DISCONTINUED") return null;
  return {
    slug: input.slug,
    name: input.name,
    description: input.description,
    pricePaise: input.pricePaise,
    compareAtPaise: input.compareAtPaise,
    currency: input.currency,
    status: input.status,
    availability: input.availability,
    sku: input.sku,
  };
}

export function popularityIsMeasured(): false {
  return false;
}

export function paiseToInrInput(paise: number): string {
  if (!Number.isInteger(paise) || paise < 0) throw new Error("Invalid paise amount.");
  const whole = Math.trunc(paise / 100);
  const frac = String(paise % 100).padStart(2, "0");
  return `${whole}.${frac}`;
}

export function assertSchedule(startsAt: Date | null, endsAt: Date | null): void {
  if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
    throw new Error("The end date must be after the start date.");
  }
}

export function isScheduleLive(startsAt: Date | null, endsAt: Date | null, now = new Date()): boolean {
  if (startsAt && startsAt.getTime() > now.getTime()) return false;
  if (endsAt && endsAt.getTime() <= now.getTime()) return false;
  return true;
}

/** A published (or previously public) slug change must keep the old slug. */
export function planSlugChange(current: string, next: string): { changed: boolean; recordPrevious: boolean } {
  if (current === next) return { changed: false, recordPrevious: false };
  return { changed: true, recordPrevious: true };
}

export function duplicateSku(sku: string, token: string): string {
  const suffix = token.replace(/[^A-Z0-9]/gi, "").slice(0, 6).toUpperCase() || "COPY";
  return `${sku}-COPY-${suffix}`.slice(0, 64);
}

export function canArchiveCategory(activeProductCount: number, reassignToId: string | null, categoryId: string): {
  ok: boolean;
  reason?: string;
} {
  if (reassignToId === categoryId) return { ok: false, reason: "Choose a different category to move products into." };
  if (activeProductCount > 0 && !reassignToId) {
    return { ok: false, reason: "Move active products to another category before archiving this one." };
  }
  return { ok: true };
}

export function wouldCreateCategoryCycle(
  categoryId: string,
  parentId: string | null,
  parentOf: ReadonlyMap<string, string | null>,
): boolean {
  if (!parentId) return false;
  if (parentId === categoryId) return true;
  const seen = new Set<string>([categoryId]);
  let cursor: string | null = parentId;
  while (cursor) {
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = parentOf.get(cursor) ?? null;
  }
  return false;
}
