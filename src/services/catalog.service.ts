import "server-only";
import { cache } from "react";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { images, products, productSlugHistory, productVariants, reviews, users } from "@/db/schema";
import { toProductSummary } from "@/lib/catalog/dto";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "@/lib/catalog/constants";
import type { ProductAvailability, ProductSummary } from "@/types";
import type {
  ProductDetail,
  ProductVariantSummary,
  StorefrontCategory,
  StorefrontCollection,
  StorefrontReview,
} from "@/types/storefront";
import {
  getCachedCategories,
  getCachedCategoryCounts,
  getCachedCollection,
  getCachedCollections,
  getCachedProducts,
} from "@/services/catalog/cached";
import {
  hydratePublicProducts,
  queryPublicProducts,
  querySitemapProducts,
  resolveCategoryFromTree,
} from "@/services/catalog/public-catalog.service";
import { publicProductBySlug, publicProductCondition } from "@/services/catalog/visibility";
import { isSafeImageSrc } from "@/lib/safe-url";

/**
 * Storefront read facade used by the homepage, header, search and product page.
 *
 * It contains NO product queries of its own: every list goes through the
 * shared public catalog service, so the visibility rules (status, price,
 * image, variant, artwork state) and the public DTO apply everywhere.
 * React `cache` dedupes identical calls within a single request.
 */

const FALLBACK_IMAGE = "/images/art/mark.png";

function variantAvailability(value: string): ProductAvailability {
  if (value === "LOW_STOCK") return "low_stock";
  if (value === "OUT_OF_STOCK") return "sold_out";
  if (value === "PREORDER") return "coming_soon";
  return "in_stock";
}

/** Product-page availability. Marks an admin-flagged low-stock variant; never invents a quantity. */
function detailAvailability(values: string[]): ProductAvailability {
  const stocked = values.filter((value) => value === "IN_STOCK" || value === "LOW_STOCK").length;
  if (stocked === 0) return "sold_out";
  return values.includes("LOW_STOCK") ? "low_stock" : "in_stock";
}

function boundedLimit(limit: number): number {
  return Math.min(Math.max(Math.floor(limit) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

/** Newest publicly eligible products as card view-models. Bounded; never the whole catalog. */
export const listActiveProductSummaries = cache(async (limit = DEFAULT_PAGE_SIZE): Promise<ProductSummary[]> => {
  const result = await getCachedProducts({ filters: { sort: "newest" }, pageSize: boundedLimit(limit) });
  return result.products.map(toProductSummary);
});

export const listStorefrontCategories = cache(async (): Promise<StorefrontCategory[]> => {
  const [tree, counts] = await Promise.all([getCachedCategories(), getCachedCategoryCounts()]);
  return tree.map((category) => {
    const stat = counts[category.id];
    return {
      slug: category.slug,
      name: category.name,
      description: category.description?.trim() || "",
      image: category.image?.url || FALLBACK_IMAGE,
      imageAlt: category.image?.alt || category.name,
      fromPricePaise: stat?.minPaise ?? null,
      productCount: stat?.count ?? 0,
      seoTitle: category.seoTitle,
      seoDescription: category.seoDescription,
    };
  });
});

export const getCategoryBySlug = cache(async (slug: string): Promise<StorefrontCategory | null> => {
  const all = await listStorefrontCategories();
  return all.find((category) => category.slug === slug) ?? null;
});

export const listProductsByCategorySlug = cache(async (slug: string, limit = DEFAULT_PAGE_SIZE): Promise<ProductSummary[]> => {
  const resolved = resolveCategoryFromTree(await getCachedCategories(), slug);
  if (resolved.kind !== "found") return [];
  const result = await getCachedProducts({
    categoryIds: resolved.scopeIds,
    filters: { sort: "newest" },
    pageSize: boundedLimit(limit),
  });
  return result.products.map(toProductSummary);
});

export const listActiveCollections = cache(async (): Promise<StorefrontCollection[]> => {
  const rows = await getCachedCollections();
  return rows.map((row) => ({
    slug: row.slug,
    name: row.name,
    description: row.description,
    image: row.image?.url ?? null,
    imageAlt: row.image?.alt || row.name,
    productCount: row.productCount,
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
  }));
});

export const getCollectionBySlug = cache(async (slug: string): Promise<StorefrontCollection | null> => {
  const row = await getCachedCollection(slug);
  if (!row) return null;
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    image: row.image?.url ?? null,
    imageAlt: row.image?.alt || row.name,
    productCount: row.productCount,
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
  };
});

export const listProductsByCollectionSlug = cache(async (slug: string, limit = DEFAULT_PAGE_SIZE): Promise<ProductSummary[]> => {
  const collection = await getCachedCollection(slug);
  if (!collection) return [];
  const result = await getCachedProducts({
    collectionId: collection.id,
    filters: { sort: "featured" },
    pageSize: boundedLimit(limit),
  });
  return result.products.map(toProductSummary);
});

/** Slug + timestamp only, for the sitemap. Same visibility rules as the storefront. */
export async function listSitemapProducts(limit = 5000): Promise<{ slug: string; updatedAt: Date }[]> {
  return querySitemapProducts(limit);
}

/** Simple catalogue search. Not a search engine — substring match on name, blurb and category. */
export const searchActiveProducts = cache(async (rawQuery: string): Promise<ProductSummary[]> => {
  const result = await queryPublicProducts({ search: rawQuery, filters: { sort: "newest" }, pageSize: MAX_PAGE_SIZE });
  return result.products.map(toProductSummary);
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
      productType: products.productType,
      currency: products.currency,
    })
    .from(products)
    .where(publicProductBySlug(slug))
    .limit(1);

  if (!row) return null;

  const [dto] = await hydratePublicProducts([
    {
      id: row.id,
      slug: row.slug,
      name: row.title,
      shortDescription: row.short,
      productType: row.productType,
      basePrice: row.price,
      compareAtPrice: row.compareAt,
      currency: row.currency,
      publishedAt: row.publishedAt,
    },
  ]);
  const summary = dto ? toProductSummary(dto) : undefined;

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
  const orderedImages = imageRows
    .filter((image) => isSafeImageSrc(image.url))
    .sort(
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
    availability: detailAvailability(variantRows.map((variant) => variant.availability)),
    rating: summary?.rating,
    images: gallery,
    variants: variantSummaries,
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
    catalogStatus: "ACTIVE",
    socialImage: social?.url ?? gallery[0]?.src ?? null,
  };
});

/** Old public slugs redirect. A missing history table does not break current product URLs. */
export async function findProductSlugRedirect(slug: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ slug: products.slug })
      .from(productSlugHistory)
      .innerJoin(products, eq(products.id, productSlugHistory.productId))
      .where(and(eq(productSlugHistory.slug, slug), publicProductCondition()))
      .limit(1);
    return row?.slug ?? null;
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
    .where(and(eq(reviews.status, "APPROVED"), publicProductCondition()))
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
