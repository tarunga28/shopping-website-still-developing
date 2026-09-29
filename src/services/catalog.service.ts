import "server-only";
import { cache } from "react";
import { desc, eq, and, sql, inArray } from "drizzle-orm";
import { db } from "@/db";
import { categories, images, productCategories, products, productVariants } from "@/db/schema";
import type { ProductSummary } from "@/types";

/**
 * Read-only catalog queries for storefront surfaces.
 * Products reach the browser ONLY when status = ACTIVE.
 * React `cache` dedupes identical calls within a single request.
 */

function toBadge(publishedAt: Date | null): ProductSummary["badge"] {
  if (!publishedAt) return undefined;
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  return Date.now() - publishedAt.getTime() < thirtyDays ? "NEW" : undefined;
}

/** All purchasable products as card DTOs (id, price, image, availability). */
export const listActiveProductSummaries = cache(async (): Promise<ProductSummary[]> => {
  const rows = await db
    .select({
      id: products.id,
      slug: products.slug,
      title: products.name,
      short: products.shortDescription,
      price: products.basePrice,
      compareAt: products.compareAtPrice,
      publishedAt: products.publishedAt,
    })
    .from(products)
    .where(eq(products.status, "ACTIVE"))
    .orderBy(desc(products.publishedAt));

  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);

  const [imageRows, categoryRows, variantRows] = await Promise.all([
    db
      .select({ productId: images.productId, url: images.url })
      .from(images)
      .where(and(eq(images.type, "PRODUCT"), inArray(images.productId, ids))),
    db
      .select({ productId: productCategories.productId, name: categories.name })
      .from(productCategories)
      .innerJoin(categories, eq(categories.id, productCategories.categoryId))
      .where(and(eq(productCategories.isPrimary, true), inArray(productCategories.productId, ids))),
    db
      .select({
        productId: productVariants.productId,
        stocked: sql<number>`SUM(CASE WHEN ${productVariants.availability} IN ('IN_STOCK','LOW_STOCK') THEN 1 ELSE 0 END)::int`,
        low: sql<number>`SUM(CASE WHEN ${productVariants.availability} = 'LOW_STOCK' THEN 1 ELSE 0 END)::int`,
      })
      .from(productVariants)
      .where(inArray(productVariants.productId, ids))
      .groupBy(productVariants.productId),
  ]);

  const imageBy = new Map<string, string>();
  for (const image of imageRows) if (image.productId && !imageBy.has(image.productId)) imageBy.set(image.productId, image.url);
  const categoryBy = new Map(categoryRows.map((row) => [row.productId, row.name]));
  const variantBy = new Map(variantRows.map((row) => [row.productId, row]));

  return rows.map((row): ProductSummary => {
    const vAgg = variantBy.get(row.id);
    const availability: ProductSummary["availability"] =
      !vAgg || vAgg.stocked === 0 ? "sold_out" : vAgg.low > 0 ? "low_stock" : "in_stock";
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      category: categoryBy.get(row.id) ?? "Inkline",
      pricePaise: row.price,
      compareAtPaise: row.compareAt ?? undefined,
      image: imageBy.get(row.id) ?? "/images/products/tee.jpg",
      badge: toBadge(row.publishedAt),
      availability,
      blurb: row.short ?? undefined,
    };
  });
});
