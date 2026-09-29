import "server-only";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { images, products, productVariants } from "@/db/schema";
import { quantitySchema } from "@/lib/catalog/quantity";
import { variantState } from "@/lib/catalog/pdp-dto";
import { isSafeImageSrc } from "@/lib/safe-url";
import { pdpProductCondition } from "./visibility";

/**
 * Server-side foundation for cart / checkout: the ONLY way a variant becomes
 * a purchasable line item. Everything the client sends is treated as a
 * request to look something up; nothing it sends is ever used as data.
 *
 *  - productId and variantId must resolve to the SAME product (an id of one
 *    product paired with a variant of another is rejected, never "fixed").
 *  - the product must be ACTIVE and public-eligible right now
 *  - the variant must be orderable right now
 *  - price, compare-at and totals come from the database; a client price,
 *    total, discount or supplier cost is not even part of the input schema.
 */

export const purchaseRequestSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid(),
  quantity: quantitySchema.default(1),
});

export type PurchaseRequest = z.input<typeof purchaseRequestSchema>;

export interface PurchasableItem {
  productId: string;
  variantId: string;
  sku: string;
  productSlug: string;
  productName: string;
  variantName: string;
  size: string | null;
  color: string | null;
  imageUrl: string | null;
  quantity: number;
  unitPricePaise: number;
  compareAtPaise: number | null;
  lineTotalPaise: number;
  currency: string;
}

export type PurchasableFailure = "INVALID_INPUT" | "INVALID_QUANTITY" | "NOT_FOUND" | "UNAVAILABLE";

export type PurchasableResult =
  | { ok: true; item: PurchasableItem }
  | { ok: false; reason: PurchasableFailure };

interface VariantRow {
  productId: string;
  productSlug: string;
  productName: string;
  currency: string;
  variantId: string;
  sku: string;
  variantName: string;
  size: string | null;
  color: string | null;
  price: number;
  compareAt: number | null;
  availability: "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK" | "PREORDER";
}

async function loadVariantRow(filter: SQL): Promise<VariantRow | null> {
  const [row] = await db
    .select({
      productId: products.id,
      productSlug: products.slug,
      productName: products.name,
      currency: products.currency,
      variantId: productVariants.id,
      sku: productVariants.sku,
      variantName: productVariants.name,
      size: productVariants.size,
      color: productVariants.color,
      price: productVariants.price,
      compareAt: productVariants.compareAtPrice,
      availability: productVariants.availability,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(filter, pdpProductCondition(), sql`${productVariants.price} > 0`))
    .limit(1);
  return row ?? null;
}

async function primaryImageUrl(productId: string): Promise<string | null> {
  const rows = await db
    .select({ url: images.url })
    .from(images)
    .where(and(eq(images.productId, productId), eq(images.type, "PRODUCT")))
    .orderBy(
      sql`case ${images.role} when 'PRIMARY' then 0 when 'GALLERY' then 1 else 2 end`,
      asc(images.sortOrder),
    )
    .limit(5);
  return rows.find((row) => isSafeImageSrc(row.url))?.url ?? null;
}

function isOrderable(row: VariantRow): boolean {
  return variantState(row.availability) === "AVAILABLE";
}

export async function getPurchasableVariant(input: unknown): Promise<PurchasableResult> {
  const parsedIds = z.object({ productId: z.string().uuid(), variantId: z.string().uuid() }).safeParse(input);
  if (!parsedIds.success) return { ok: false, reason: "INVALID_INPUT" };

  const raw = input as { quantity?: unknown };
  const quantity = raw.quantity === undefined ? 1 : raw.quantity;
  const parsedQuantity = quantitySchema.safeParse(quantity);
  if (!parsedQuantity.success) return { ok: false, reason: "INVALID_QUANTITY" };

  const { productId, variantId } = parsedIds.data;
  // Both ids in ONE predicate: a variant of another product simply does not match.
  const row = await loadVariantRow(and(eq(productVariants.id, variantId), eq(productVariants.productId, productId)) as SQL);
  if (!row) return { ok: false, reason: "NOT_FOUND" };
  if (!isOrderable(row)) return { ok: false, reason: "UNAVAILABLE" };

  return {
    ok: true,
    item: {
      productId: row.productId,
      variantId: row.variantId,
      sku: row.sku,
      productSlug: row.productSlug,
      productName: row.productName,
      variantName: row.variantName,
      size: row.size,
      color: row.color,
      imageUrl: await primaryImageUrl(row.productId),
      quantity: parsedQuantity.data,
      unitPricePaise: row.price,
      compareAtPaise: row.compareAt !== null && row.compareAt > row.price ? row.compareAt : null,
      lineTotalPaise: row.price * parsedQuantity.data,
      currency: row.currency,
    },
  };
}

/** SKU lookup used by the quote endpoint; same visibility and availability rules. */
export async function getPurchasableVariantBySku(
  sku: string,
): Promise<{ sku: string; slug: string; availability: VariantRow["availability"]; pricePaise: number } | null> {
  const row = await loadVariantRow(eq(productVariants.sku, sku));
  if (!row || !isOrderable(row)) return null;
  return { sku: row.sku, slug: row.productSlug, availability: row.availability, pricePaise: row.price };
}
