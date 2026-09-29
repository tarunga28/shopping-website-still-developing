import "server-only";
import { cache } from "react";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  categories,
  colors,
  collections,
  designs,
  images,
  productCategories,
  productCollections,
  productDesigns,
  products,
  productVariants,
  reviews,
  sizeCharts,
} from "@/db/schema";
import { ancestorsOf } from "@/lib/catalog/category-tree";
import { PLACEMENT_LABELS, toPdpProductDTO, type PdpProductDTO } from "@/lib/catalog/pdp-dto";
import { publicCollectionCondition, pdpProductCondition } from "./visibility";
import { queryPublicCategories } from "./public-catalog.service";

/**
 * Loads one product for its detail page, straight from the database.
 *
 * Deliberately NOT cached across requests: price, availability and status
 * are purchase-critical, and a stale "₹1,499" after a change to ₹1,599 is a
 * customer-facing bug. React `cache` only de-duplicates the metadata call and
 * the page render inside a single request. All queries run in one parallel
 * batch (no N+1) and never touch the supplier API.
 */
export const getProductPage = cache(async (slug: string): Promise<PdpProductDTO | null> => {
  const [row] = await db
    .select({
      id: products.id,
      slug: products.slug,
      name: products.name,
      shortDescription: products.shortDescription,
      description: products.description,
      productType: products.productType,
      basePrice: products.basePrice,
      compareAtPrice: products.compareAtPrice,
      currency: products.currency,
      publishedAt: products.publishedAt,
      seoTitle: products.seoTitle,
      seoDescription: products.seoDescription,
      details: products.details,
    })
    .from(products)
    .where(and(eq(products.slug, slug), pdpProductCondition()))
    .limit(1);
  if (!row) return null;

  const [variantRows, imageRows, colorRows, categoryRows, publicTree, collectionRows, designRows, chartRows, reviewRows] =
    await Promise.all([
      db
        .select({
          id: productVariants.id,
          sku: productVariants.sku,
          name: productVariants.name,
          size: productVariants.size,
          color: productVariants.color,
          colorCode: productVariants.colorCode,
          pricePaise: productVariants.price,
          compareAtPaise: productVariants.compareAtPrice,
          availability: productVariants.availability,
        })
        .from(productVariants)
        .where(eq(productVariants.productId, row.id)),
      db
        .select({
          url: images.url,
          altText: images.altText,
          width: images.width,
          height: images.height,
          role: images.role,
          sortOrder: images.sortOrder,
          variantId: images.variantId,
          type: images.type,
        })
        .from(images)
        .where(and(eq(images.productId, row.id), eq(images.type, "PRODUCT")))
        .orderBy(asc(images.sortOrder), asc(images.id)),
      db
        .select({ name: colors.name, hex: colors.hex, displayOrder: colors.displayOrder })
        .from(colors)
        .where(eq(colors.isActive, true)),
      db
        .select({
          id: categories.id,
          name: categories.name,
          slug: categories.slug,
        })
        .from(productCategories)
        .innerJoin(categories, and(eq(categories.id, productCategories.categoryId), eq(categories.isActive, true)))
        .where(eq(productCategories.productId, row.id))
        .orderBy(desc(productCategories.isPrimary), asc(categories.displayOrder), asc(categories.name)),
      queryPublicCategories(),
      db
        .select({ name: collections.name, slug: collections.slug })
        .from(productCollections)
        .innerJoin(collections, and(eq(collections.id, productCollections.collectionId), publicCollectionCondition()))
        .where(eq(productCollections.productId, row.id))
        .orderBy(asc(collections.displayOrder), asc(collections.name))
        .limit(1),
      // Only PUBLISHED, non-restricted designs, and only their name + placement.
      db
        .select({
          designId: designs.id,
          name: designs.name,
          placement: productDesigns.placement,
        })
        .from(productDesigns)
        .innerJoin(designs, eq(designs.id, productDesigns.designId))
        .where(
          and(
            eq(productDesigns.productId, row.id),
            eq(designs.status, "PUBLISHED"),
            sql`${designs.copyrightStatus} <> 'RESTRICTED'`,
          ),
        )
        .orderBy(asc(productDesigns.displayOrder), asc(designs.name)),
      db
        .select({ title: sizeCharts.title, unit: sizeCharts.unit, columns: sizeCharts.columns, rows: sizeCharts.rows, notes: sizeCharts.notes })
        .from(sizeCharts)
        .where(and(eq(sizeCharts.productType, row.productType), eq(sizeCharts.isActive, true)))
        .limit(1),
      db
        .select({
          average: sql<number>`round(avg(${reviews.rating})::numeric, 1)::float`,
          count: sql<number>`count(*)::int`,
        })
        .from(reviews)
        .where(and(eq(reviews.productId, row.id), eq(reviews.status, "APPROVED"))),
    ]);

  // The first category whose whole ancestor chain is public is the primary one.
  const publicById = new Map(publicTree.map((category) => [category.id, category]));
  const primary = categoryRows.find((category) => publicById.has(category.id));
  const categoryTrail = primary
    ? [...ancestorsOf(publicTree, primary.id), publicById.get(primary.id)!].map((category) => ({
        name: category.name,
        slug: category.slug,
      }))
    : [];

  const designMap = new Map<string, { name: string; placements: string[] }>();
  for (const design of designRows) {
    const entry = designMap.get(design.designId) ?? { name: design.name, placements: [] };
    const label = PLACEMENT_LABELS[design.placement] ?? "Other placement";
    if (!entry.placements.includes(label)) entry.placements.push(label);
    designMap.set(design.designId, entry);
  }

  const review = reviewRows[0];
  return toPdpProductDTO({
    id: row.id,
    slug: row.slug,
    name: row.name,
    shortDescription: row.shortDescription,
    description: row.description,
    productType: row.productType,
    basePricePaise: row.basePrice,
    compareAtPricePaise: row.compareAtPrice,
    currency: row.currency,
    publishedAt: row.publishedAt,
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
    details: row.details,
    variants: variantRows,
    images: imageRows,
    colorCatalog: colorRows,
    categoryTrail,
    collection: collectionRows[0] ?? null,
    designs: [...designMap.values()],
    sizeChart: chartRows[0] ?? null,
    rating: review && Number(review.count) > 0 ? { average: Number(review.average), count: Number(review.count) } : null,
  });
});
