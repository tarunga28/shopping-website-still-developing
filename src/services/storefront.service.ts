import "server-only";
import { cache } from "react";
import { storefrontContent } from "@/content/storefront";
import { errorContext, logger } from "@/lib/logger";
import { isSafeImageSrc } from "@/lib/safe-url";
import { getOptionalUser } from "@/server/auth/session";
import {
  getCollectionBySlug,
  listActiveCollections,
  listActiveProductSummaries,
  listApprovedReviews,
  listProductsByCollectionSlug,
  listStorefrontCategories,
  searchActiveProducts,
} from "@/services/catalog.service";
import { listWishlistProductIds } from "@/services/wishlist.service";
import type { ProductSummary } from "@/types";
import type {
  SectionResult,
  StorefrontCategory,
  StorefrontCollection,
  StorefrontReview,
} from "@/types/storefront";

/**
 * Homepage and header data loader.
 * Each query is isolated: one failure becomes a section error, not a 500.
 */

const QUERY_TIMEOUT_MS = 4000;

async function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), QUERY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function loadSection<T>(label: string, work: () => Promise<T>, fallback: T): Promise<SectionResult<T>> {
  try {
    const data = await withTimeout(work(), label);
    const empty = Array.isArray(data) ? data.length === 0 : data == null;
    return { data, status: empty ? "empty" : "ok" };
  } catch (error) {
    logger.error("Storefront section failed", { label, ...errorContext(error) });
    return { data: fallback, status: "error" };
  }
}

function applyMedia(products: ProductSummary[]): ProductSummary[] {
  return products.map((product) => {
    const overlay = storefrontContent.productMedia[product.slug];
    const hover = product.hoverImage ?? overlay?.hoverImage;
    return {
      ...product,
      image: isSafeImageSrc(product.image) ? product.image : storefrontContent.categories.fallbackImage,
      hoverImage: hover && isSafeImageSrc(hover) ? hover : undefined,
    };
  });
}

function orderCategories(categories: StorefrontCategory[]): StorefrontCategory[] {
  const pins = storefrontContent.categories.pinOrder;
  const rank = new Map<string, number>(pins.map((slug, index) => [slug, index]));
  return [...categories].sort((a, b) => {
    const ar = rank.get(a.slug) ?? 1000;
    const br = rank.get(b.slug) ?? 1000;
    if (ar !== br) return ar - br;
    return a.name.localeCompare(b.name);
  });
}

function withCategoryMedia(categories: StorefrontCategory[]): StorefrontCategory[] {
  return orderCategories(categories).map((category) => {
    const media = storefrontContent.categories.media[category.slug];
    const hasOwnImage = category.image !== storefrontContent.categories.fallbackImage && isSafeImageSrc(category.image);
    if (hasOwnImage || !media) return category;
    return { ...category, image: media.src, imageAlt: media.alt };
  });
}

export interface HomepageModel {
  products: SectionResult<ProductSummary[]>;
  categories: SectionResult<StorefrontCategory[]>;
  featuredProducts: SectionResult<ProductSummary[]>;
  newArrivals: SectionResult<ProductSummary[]>;
  featuredCollection: SectionResult<{ collection: StorefrontCollection; products: ProductSummary[] } | null>;
  reviews: SectionResult<StorefrontReview[]>;
  savedIds: string[];
}

export const loadHomepage = cache(async (): Promise<HomepageModel> => {
  const [products, categories, reviews, savedIds, collection] = await Promise.all([
    loadSection("products", listActiveProductSummaries, [] as ProductSummary[]),
    loadSection("categories", listStorefrontCategories, [] as StorefrontCategory[]),
    loadSection("reviews", () => listApprovedReviews(6), [] as StorefrontReview[]),
    loadSection("saved", getSavedProductIds, [] as string[]),
    loadSection(
      "featured-collection",
      () => getCollectionBySlug(storefrontContent.featuredCollection.slug),
      null as StorefrontCollection | null,
    ),
  ]);

  const decorated = applyMedia(products.data);
  const visibleCategories = withCategoryMedia(categories.data).filter((category) => category.productCount > 0);

  const pinned = storefrontContent.featuredProducts.productSlugs
    .map((slug) => decorated.find((product) => product.slug === slug))
    .filter((product): product is ProductSummary => Boolean(product));
  const featuredList = (pinned.length > 0 ? pinned : decorated).slice(0, storefrontContent.featuredProducts.limit);

  let featuredPayload: { collection: StorefrontCollection; products: ProductSummary[] } | null = null;
  let featuredStatus = collection.status;
  if (collection.status !== "error" && collection.data) {
    const collectionProducts = await loadSection(
      "featured-collection-products",
      () => listProductsByCollectionSlug(collection.data!.slug, 8),
      [] as ProductSummary[],
    );
    if (collectionProducts.status === "error") {
      featuredStatus = "error";
    } else {
      featuredPayload = { collection: collection.data, products: applyMedia(collectionProducts.data) };
      featuredStatus = "ok";
    }
  } else if (collection.status === "ok" && !collection.data) {
    featuredStatus = "empty";
  }

  return {
    products: { data: decorated, status: products.status === "error" ? "error" : decorated.length ? "ok" : "empty" },
    categories: {
      data: visibleCategories,
      status: categories.status === "error" ? "error" : visibleCategories.length ? "ok" : "empty",
    },
    featuredProducts: {
      data: featuredList,
      status: products.status === "error" ? "error" : featuredList.length ? "ok" : "empty",
    },
    newArrivals: {
      data: decorated.slice(0, storefrontContent.newArrivals.limit),
      status: products.status === "error" ? "error" : decorated.length ? "ok" : "empty",
    },
    featuredCollection: { data: featuredPayload, status: featuredStatus },
    reviews,
    savedIds: savedIds.data,
  };
});

export const loadHeaderCatalog = cache(async () => {
  const [products, collections, categories] = await Promise.all([
    loadSection("header-products", async () => [] as ProductSummary[], [] as ProductSummary[]),
    loadSection("header-collections", listActiveCollections, [] as StorefrontCollection[]),
    loadSection("header-categories", listStorefrontCategories, [] as StorefrontCategory[]),
  ]);
  return {
    products: applyMedia(products.data),
    collections: collections.data,
    categories: withCategoryMedia(categories.data).filter((category) => category.productCount > 0),
    catalogError: products.status === "error",
  };
});

export const getSavedProductIds = cache(async (): Promise<string[]> => {
  const user = await getOptionalUser();
  if (!user) return [];
  return listWishlistProductIds(user.id);
});

export async function loadSearch(query: string): Promise<SectionResult<ProductSummary[]>> {
  return loadSection("search", () => searchActiveProducts(query), [] as ProductSummary[]);
}
