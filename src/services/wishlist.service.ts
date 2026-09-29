import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { images, products, productVariants, wishlistItems, wishlists } from "@/db/schema";
import { withTransaction, type DbClient } from "@/db/utils";
import { NotFoundError } from "@/lib/errors";
import { writeAudit } from "@/services/audit.service";

/**
 * Wishlist service — default wishlist per user, duplicate-proof items.
 * Every entry point is scoped by the authenticated user id.
 */

export interface WishlistEntry {
  itemId: string;
  addedAt: Date;
  productId: string;
  productName: string;
  productSlug: string;
  productStatus: string;
  imageUrl: string | null;
  minPricePaise: number | null;
  compareAtPaise: number | null;
  availability: "AVAILABLE" | "LOW_STOCK" | "UNAVAILABLE" | "ARCHIVED";
}

/** Ensure the user's default wishlist container exists; returns its id. */
export async function ensureWishlist(userId: string, client: DbClient = db): Promise<string> {
  const [existing] = await client.select().from(wishlists).where(eq(wishlists.userId, userId)).limit(1);
  if (existing) return existing.id;
  const [created] = await client
    .insert(wishlists)
    .values({ userId, name: "Saved items" })
    .onConflictDoNothing({ target: [wishlists.userId, wishlists.name] })
    .returning();
  if (created) return created.id;
  const [fallback] = await client.select().from(wishlists).where(eq(wishlists.userId, userId)).limit(1);
  if (!fallback) throw new NotFoundError("Wishlist unavailable.");
  return fallback.id;
}

/** Add (idempotent). Returns true when newly added, false if present. */
export async function addToWishlist(userId: string, productId: string): Promise<boolean> {
  const [product] = await db
    .select({ id: products.id, status: products.status })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  if (!product || product.status !== "ACTIVE") {
    throw new NotFoundError("That product isn't available anymore.");
  }

  return withTransaction(async (tx) => {
    const wishlistId = await ensureWishlist(userId, tx);
    const inserted = await tx
      .insert(wishlistItems)
      .values({ wishlistId, productId })
      .onConflictDoNothing({ target: [wishlistItems.wishlistId, wishlistItems.productId] })
      .returning({ id: wishlistItems.id });
    return inserted.length > 0;
  });
}

/** Toggle convenience for storefront hearts. */
export async function toggleWishlist(userId: string, productId: string): Promise<{ saved: boolean }> {
  const wishlistId = await ensureWishlist(userId);
  const [existing] = await db
    .select({ id: wishlistItems.id })
    .from(wishlistItems)
    .where(and(eq(wishlistItems.wishlistId, wishlistId), eq(wishlistItems.productId, productId)))
    .limit(1);

  if (existing) {
    await db.delete(wishlistItems).where(eq(wishlistItems.id, existing.id));
    return { saved: false };
  }
  await addToWishlist(userId, productId);
  return { saved: true };
}

export async function removeFromWishlist(userId: string, itemId: string): Promise<void> {
  const wishlistId = await ensureWishlist(userId);
  await db
    .delete(wishlistItems)
    .where(and(eq(wishlistItems.id, itemId), eq(wishlistItems.wishlistId, wishlistId)));
}

export async function listWishlist(userId: string): Promise<WishlistEntry[]> {
  const wishlistId = await ensureWishlist(userId);

  const rows = await db
    .select({
      itemId: wishlistItems.id,
      addedAt: wishlistItems.createdAt,
      productId: products.id,
      productName: products.name,
      productSlug: products.slug,
      productStatus: products.status,
      minPrice: sql<number | null>`MIN(${productVariants.price})`,
      compareAt: sql<number | null>`MAX(${productVariants.compareAtPrice})`,
    })
    .from(wishlistItems)
    .innerJoin(products, eq(products.id, wishlistItems.productId))
    .leftJoin(productVariants, eq(productVariants.productId, products.id))
    .where(eq(wishlistItems.wishlistId, wishlistId))
    .groupBy(wishlistItems.id, products.id)
    .orderBy(desc(wishlistItems.createdAt));

  const imageRows = await db
    .select({ productId: images.productId, url: images.url })
    .from(images)
    .where(eq(images.type, "PRODUCT"));

  const imageByProduct = new Map<string, string>();
  for (const image of imageRows) {
    if (image.productId && !imageByProduct.has(image.productId)) {
      imageByProduct.set(image.productId, image.url);
    }
  }

  return rows.map((row) => ({
    itemId: row.itemId,
    addedAt: row.addedAt,
    productId: row.productId,
    productName: row.productName,
    productSlug: row.productSlug,
    productStatus: row.productStatus,
    imageUrl: imageByProduct.get(row.productId) ?? null,
    minPricePaise: row.minPrice === null ? null : Number(row.minPrice),
    compareAtPaise: row.compareAt === null ? null : Number(row.compareAt),
    availability:
      row.productStatus !== "ACTIVE" ? "ARCHIVED" : "AVAILABLE",
  }));
}

export async function wishlistCount(userId: string): Promise<number> {
  const wishlistId = await ensureWishlist(userId);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(wishlistItems)
    .where(eq(wishlistItems.wishlistId, wishlistId));
  return Number(row?.n ?? 0);
}
