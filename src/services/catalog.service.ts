import "server-only";
import { cache } from "react";
import { and, asc, desc, eq, gt, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  categories,
  collections,
  images,
  productCategories,
  productCollections,
  productSlugHistory,
  products,
  productVariants,
  reviews,
  users,
} from "@/db/schema";
import { escapeLike, sanitizeSearchQuery } from "@/lib/slug";
import type { ProductAvailability, ProductBadge, ProductSummary } from "@/types";
import type {
  ProductDetail,
  ProductVariantSummary,
  StorefrontCategory,
  StorefrontCollection,
  StorefrontReview,
} from "@/types/storefront";

/**
 * Read-only catalog queries for storefront surfaces.
 * Products reach the browser ONLY when status = ACTIVE.
 * React `cache` dedupes identical calls within a single request.
 */

const FALLBACK_IMAGE = "/images/art/mark.png";

function toBadge(publishedAt: Date | null): ProductBadge | undefined {
  if (!publishedAt) return undefined;
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  return Date.now() - publishedAt.getTime() < thirtyDays ? "NEW" : undefined;
}

function availabilityFrom(stocked: number, low: number): ProductAvailability {
  if (!stocked) return "sold_out";
  if (low > 0) return "low_stock";
  return "in_stock";
}

function variantAvailability(value: string): ProductAvailability {
  if (value === "LOW_STOCK") return "low_stock";
  if (value === "OUT_OF_STOCK") return "sold_out";
  if (value === "PREORDER") return "coming_soon";
  return "in_stock";
}

interface SummarySeed {
  id: string;
  slug: string;
  title: string;
  short: string | null;
  price: number;
  compareAt: number | null;
  publishedAt: Date | null;
}

async function hydrateSummaries(rows: SummarySeed[]): Promise<ProductSummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);

  const [imageRows, categoryRows, collectionRows, variantRows, reviewRows] = await Promise.all([
    db
      .select({
        productId: images.productId,
        url: images.url,
        altText: images.altText,
        sortOrder: images.sortOrder,
      })
      .from(images)
      .where(and(eq(images.type, "PRODUCT"), inArray(images.productId, ids)))
      .orderBy(asc(images.sortOrder)),
    db
      .select({
        productId: productCategories.productId,
        name: categories.name,
        slug: categories.slug,
        isPrimary: productCategories.isPrimary,
      })
      .from(productCategories)
      .innerJoin(categories, eq(categories.id, productCategories.categoryId))
      .where(inArray(productCategories.productId, ids)),
    db
      .select({ productId: productCollections.productId, slug: collections.slug })
      .from(productCollections)
      .innerJoin(collections, eq(collections.id, productCollections.collectionId))
      .where(inArray(productCollections.productId, ids)),
    db
      .select({
        productId: productVariants.productId,
        stocked: sql<number>`SUM(CASE WHEN ${productVariants.availability} IN ('IN_STOCK','LOW_STOCK') THEN 1 ELSE 0 END)::int`,
        low: sql<number>`SUM(CASE WHEN ${productVariants.availability} = 'LOW_STOCK' THEN 1 ELSE 0 END)::int`,
      })
      .from(productVariants)
      .where(inArray(productVariants.productId, ids))
      .groupBy(productVariants.productId),
    db
      .select({
        productId: reviews.productId,
        average: sql<number>`ROUND(AVG(${reviews.rating})::numeric, 1)::float`,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(reviews)
      .where(and(eq(reviews.status, "APPROVED"), inArray(reviews.productId, ids)))
      .groupBy(reviews.productId),
  ]);

  const imagesBy = new Map<string, { url: string; alt: string }[]>();
  for (const image of imageRows) {
    if (!image.productId) continue;
    const list = imagesBy.get(image.productId) ?? [];
    list.push({ url: image.url, alt: image.altText });
    imagesBy.set(image.productId, list);
  }

  const categoryBy = new Map<string, { name: string; slug: string }>();
  for (const row of categoryRows) {
    const current = categoryBy.get(row.productId);
    if (!current || row.isPrimary) categoryBy.set(row.productId, { name: row.name, slug: row.slug });
  }

  const collectionsBy = new Map<string, string[]>();
  for (const row of collectionRows) {
    const list = collectionsBy.get(row.productId) ?? [];
    if (!list.includes(row.slug)) list.push(row.slug);
    collectionsBy.set(row.productId, list);
  }

  const variantBy = new Map(variantRows.map((row) => [row.productId, row]));
  const reviewBy = new Map(reviewRows.map((row) => [row.productId, row]));

  return rows.map((row): ProductSummary => {
    const pics = imagesBy.get(row.id) ?? [];
    const primary = pics[0];
    const hover = pics.find((pic) => pic.url !== primary?.url);
    const category = categoryBy.get(row.id);
    const vAgg = variantBy.get(row.id);
    const review = reviewBy.get(row.id);
    const availability = vAgg ? availabilityFrom(Number(vAgg.stocked), Number(vAgg.low)) : "sold_out";

    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      category: category?.name ?? "Inkline",
      categorySlug: category?.slug,
      collectionSlugs: collectionsBy.get(row.id) ?? [],
      pricePaise: row.price,
      compareAtPaise: row.compareAt ?? undefined,
      image: primary?.url || FALLBACK_IMAGE,
      imageAlt: primary?.alt || row.title,
      hoverImage: hover?.url,
      badge: availability === "sold_out" ? "SOLD_OUT" : toBadge(row.publishedAt),
      rating:
        review && Number(review.count) > 0
          ? { value: Number(review.average), count: Number(review.count) }
          : undefined,
      availability,
      blurb: row.short ?? undefined,
      publishedAt: row.publishedAt?.toISOString(),
    };
  });
}

const summaryColumns = {
  id: products.id,
  slug: products.slug,
  title: products.name,
  short: products.shortDescription,
  price: products.basePrice,
  compareAt: products.compareAtPrice,
  publishedAt: products.publishedAt,
};

/**
 * Bounded purchasable cards, newest published first.
 * Shop, search and the header must not call this for the whole catalog.
 */
export const listActiveProductSummaries = cache(async (limit = 24): Promise<ProductSummary[]> => {
  const bounded = Math.min(Math.max(Math.floor(limit), 1), 1000);
  const rows = await db
    .select(summaryColumns)
    .from(products)
    .where(eq(products.status, "ACTIVE"))
    .orderBy(desc(products.publishedAt), asc(products.name))
    .limit(bounded);

  return hydrateSummaries(rows);
});

export const listStorefrontCategories = cache(async (): Promise<StorefrontCategory[]> => {
  const rows = await db
    .select({
      id: categories.id,
      slug: categories.slug,
      name: categories.name,
      description: categories.description,
      seoTitle: categories.seoTitle,
      seoDescription: categories.seoDescription,
    })
    .from(categories)
    .where(eq(categories.isActive, true))
    .orderBy(asc(categories.displayOrder), asc(categories.name));

  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);

  const [stats, imageRows] = await Promise.all([
    db
      .select({
        categoryId: productCategories.categoryId,
        count: sql<number>`COUNT(DISTINCT ${products.id})::int`,
        minPrice: sql<number | null>`MIN(${products.basePrice})`,
      })
      .from(productCategories)
      .innerJoin(products, and(eq(products.id, productCategories.productId), eq(products.status, "ACTIVE")))
      .where(inArray(productCategories.categoryId, ids))
      .groupBy(productCategories.categoryId),
    db
      .select({ categoryId: images.categoryId, url: images.url, altText: images.altText })
      .from(images)
      .where(and(eq(images.type, "CATEGORY"), inArray(images.categoryId, ids)))
      .orderBy(asc(images.sortOrder)),
  ]);

  const statBy = new Map(stats.map((row) => [row.categoryId, row]));
  const imageBy = new Map<string, { url: string; alt: string }>();
  for (const image of imageRows) {
    if (image.categoryId && !imageBy.has(image.categoryId)) {
      imageBy.set(image.categoryId, { url: image.url, alt: image.altText });
    }
  }

  return rows.map((row) => {
    const stat = statBy.get(row.id);
    const image = imageBy.get(row.id);
    return {
      slug: row.slug,
      name: row.name,
      description: row.description?.trim() || "",
      image: image?.url || FALLBACK_IMAGE,
      imageAlt: image?.alt || row.name,
      fromPricePaise: stat?.minPrice == null ? null : Number(stat.minPrice),
      productCount: Number(stat?.count ?? 0),
      seoTitle: row.seoTitle,
      seoDescription: row.seoDescription,
    };
  });
});

export const getCategoryBySlug = cache(async (slug: string): Promise<StorefrontCategory | null> => {
  const all = await listStorefrontCategories();
  return all.find((category) => category.slug === slug) ?? null;
});

export const listProductsByCategorySlug = cache(async (slug: string, limit = 24): Promise<ProductSummary[]> => {
  const rows = await db
    .select(summaryColumns)
    .from(products)
    .innerJoin(productCategories, eq(productCategories.productId, products.id))
    .innerJoin(categories, eq(categories.id, productCategories.categoryId))
    .where(and(eq(products.status, "ACTIVE"), eq(categories.slug, slug), eq(categories.isActive, true)))
    .orderBy(desc(products.publishedAt), asc(products.name))
    .limit(Math.min(Math.max(limit, 1), 48));

  return hydrateSummaries(rows);
});

export const listActiveCollections = cache(async (): Promise<StorefrontCollection[]> => {
  const rows = await db
    .select({
      id: collections.id,
      slug: collections.slug,
      name: collections.name,
      description: collections.description,
      seoTitle: collections.seoTitle,
      seoDescription: collections.seoDescription,
    })
    .from(collections)
    .where(
      and(
        eq(collections.status, "ACTIVE"),
        or(isNull(collections.startsAt), lte(collections.startsAt, new Date())),
        or(isNull(collections.endsAt), gt(collections.endsAt, new Date())),
      ),
    )
    .orderBy(asc(collections.displayOrder), asc(collections.name));

  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);

  const [stats, imageRows] = await Promise.all([
    db
      .select({
        collectionId: productCollections.collectionId,
        count: sql<number>`COUNT(DISTINCT ${products.id})::int`,
      })
      .from(productCollections)
      .innerJoin(products, and(eq(products.id, productCollections.productId), eq(products.status, "ACTIVE")))
      .where(inArray(productCollections.collectionId, ids))
      .groupBy(productCollections.collectionId),
    db
      .select({ collectionId: images.collectionId, url: images.url, altText: images.altText })
      .from(images)
      .where(and(eq(images.type, "COLLECTION"), inArray(images.collectionId, ids)))
      .orderBy(asc(images.sortOrder)),
  ]);

  const statBy = new Map(stats.map((row) => [row.collectionId, Number(row.count)]));
  const imageBy = new Map<string, { url: string; alt: string }>();
  for (const image of imageRows) {
    if (image.collectionId && !imageBy.has(image.collectionId)) {
      imageBy.set(image.collectionId, { url: image.url, alt: image.altText });
    }
  }

  return rows.map((row) => {
    const image = imageBy.get(row.id);
    return {
      slug: row.slug,
      name: row.name,
      description: row.description?.trim() || "",
      image: image?.url ?? null,
      imageAlt: image?.alt || row.name,
      productCount: statBy.get(row.id) ?? 0,
      seoTitle: row.seoTitle,
      seoDescription: row.seoDescription,
    };
  });
});

export const getCollectionBySlug = cache(async (slug: string): Promise<StorefrontCollection | null> => {
  const all = await listActiveCollections();
  return all.find((collection) => collection.slug === slug) ?? null;
});

export const listProductsByCollectionSlug = cache(async (slug: string, limit = 24): Promise<ProductSummary[]> => {
  const rows = await db
    .select(summaryColumns)
    .from(products)
    .innerJoin(productCollections, eq(productCollections.productId, products.id))
    .innerJoin(collections, eq(collections.id, productCollections.collectionId))
    .where(and(eq(products.status, "ACTIVE"), eq(collections.slug, slug), eq(collections.status, "ACTIVE")))
    .orderBy(asc(productCollections.displayOrder), desc(products.publishedAt))
    .limit(Math.min(Math.max(limit, 1), 48));

  return hydrateSummaries(rows);
});

/** Simple catalogue search. Not a search engine — substring match on name, blurb and category. */
export const searchActiveProducts = cache(async (rawQuery: string): Promise<ProductSummary[]> => {
  const query = sanitizeSearchQuery(rawQuery);
  if (query.length < 2) return [];
  const pattern = `%${escapeLike(query)}%`;

  const rows = await db
    .selectDistinct(summaryColumns)
    .from(products)
    .leftJoin(productCategories, eq(productCategories.productId, products.id))
    .leftJoin(categories, eq(categories.id, productCategories.categoryId))
    .where(
      and(
        eq(products.status, "ACTIVE"),
        or(
          ilike(products.name, pattern),
          ilike(products.shortDescription, pattern),
          ilike(categories.name, pattern),
        ),
      ),
    )
    .orderBy(desc(products.publishedAt))
    .limit(48);

  return hydrateSummaries(rows);
});

export const getProductBySlug = cache(async (slug: string): Promise<ProductDetail | null> => {
  const [row] = await db
    .select({
      id: products.id,
      slug: products.slug,
      title: products.name,
      description: products.description,
      short: products.shortDescription,
      price: products.basePrice,
      compareAt: products.compareAtPrice,
      publishedAt: products.publishedAt,
      seoTitle: products.seoTitle,
      seoDescription: products.seoDescription,
      status: products.status,
    })
    .from(products)
    .where(and(eq(products.slug, slug), inArray(products.status, ["ACTIVE", "DISCONTINUED"])))
    .limit(1);

  if (!row) return null;

  const [summary] = await hydrateSummaries([
    {
      id: row.id,
      slug: row.slug,
      title: row.title,
      short: row.short,
      price: row.price,
      compareAt: row.compareAt,
      publishedAt: row.publishedAt,
    },
  ]);

  const [imageRows, variantRows] = await Promise.all([
    db
      .select({
        url: images.url,
        altText: images.altText,
        width: images.width,
        height: images.height,
        role: images.role,
        sortOrder: images.sortOrder,
      })
      .from(images)
      .where(and(eq(images.productId, row.id), eq(images.type, "PRODUCT")))
      .orderBy(asc(images.sortOrder)),
    db
      .select({
        sku: productVariants.sku,
        name: productVariants.name,
        size: productVariants.size,
        color: productVariants.color,
        availability: productVariants.availability,
        price: productVariants.price,
      })
      .from(productVariants)
      .where(eq(productVariants.productId, row.id))
      .orderBy(asc(productVariants.name)),
  ]);

  const roleRank: Record<string, number> = { PRIMARY: 0, GALLERY: 1, HOVER: 2, MOBILE: 3, THUMBNAIL: 4, SOCIAL: 5 };
  const orderedImages = [...imageRows].sort(
    (a, b) => (roleRank[a.role] ?? 9) - (roleRank[b.role] ?? 9) || a.sortOrder - b.sortOrder,
  );
  const gallery =
    orderedImages.length > 0
      ? orderedImages.map((image) => ({
          src: image.url,
          alt: image.altText || row.title,
          width: image.width,
          height: image.height,
        }))
      : [{ src: summary?.image || FALLBACK_IMAGE, alt: row.title, width: null, height: null }];
  const social = imageRows.find((image) => image.role === "SOCIAL") ?? imageRows.find((image) => image.role === "PRIMARY") ?? imageRows[0];

  const variantSummaries: ProductVariantSummary[] = variantRows.map((variant) => ({
    name: variant.name,
    sku: variant.sku,
    size: variant.size,
    color: variant.color,
    availability: variantAvailability(variant.availability),
    pricePaise: variant.price,
  }));

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    blurb: row.short,
    category: summary?.category ?? "Inkline",
    categorySlug: summary?.categorySlug ?? null,
    pricePaise: row.price,
    compareAtPaise: row.compareAt ?? undefined,
    badge: summary?.badge,
    availability: summary?.availability ?? "sold_out",
    rating: summary?.rating,
    images: gallery,
    variants: variantSummaries,
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
    catalogStatus: row.status === "DISCONTINUED" ? "DISCONTINUED" : "ACTIVE",
    socialImage: social?.url ?? gallery[0]?.src ?? null,
  };
});

/** Old public slugs redirect. A missing history table does not break current product URLs. */
export async function findProductSlugRedirect(slug: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ slug: products.slug, status: products.status })
      .from(productSlugHistory)
      .innerJoin(products, eq(products.id, productSlugHistory.productId))
      .where(eq(productSlugHistory.slug, slug))
      .limit(1);
    if (!row || (row.status !== "ACTIVE" && row.status !== "DISCONTINUED")) return null;
    return row.slug;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("product_slug_history") || message.includes("42P01")) return null;
    throw error;
  }
}

/** Approved reviews only. Returns [] when none exist — never fabricated. */
export const listApprovedReviews = cache(async (limit = 6): Promise<StorefrontReview[]> => {
  const rows = await db
    .select({
      id: reviews.id,
      rating: reviews.rating,
      title: reviews.title,
      content: reviews.content,
      verifiedPurchase: reviews.verifiedPurchase,
      authorName: users.name,
      productName: products.name,
      productSlug: products.slug,
      productStatus: products.status,
    })
    .from(reviews)
    .innerJoin(users, eq(users.id, reviews.userId))
    .innerJoin(products, eq(products.id, reviews.productId))
    .where(eq(reviews.status, "APPROVED"))
    .orderBy(desc(reviews.createdAt))
    .limit(limit);

  return rows
    .filter((row) => row.content && row.content.trim().length > 0)
    .map((row) => ({
      id: row.id,
      rating: row.rating,
      title: row.title,
      quote: row.content!.trim(),
      authorName: publicName(row.authorName),
      productLabel: row.productName,
      productHref: row.productStatus === "ACTIVE" ? `/product/${row.productSlug}` : null,
      verifiedPurchase: row.verifiedPurchase,
      image: null,
      imageAlt: null,
    }));
});

function publicName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Customer";
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]} ${parts[1]!.slice(0, 1).toUpperCase()}.`;
}
