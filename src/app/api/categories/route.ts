import { withErrorHandling } from "@/lib/api-response";
import { catalogApiLimiter, catalogApiResponse, enforceRateLimit } from "@/lib/catalog/api";
import { getCachedCategories, getCachedCategoryCounts } from "@/services/catalog/cached";

export const dynamic = "force-dynamic";

const limiter = catalogApiLimiter("api-categories");

/** GET /api/categories — public categories (active with active ancestors) and exact product counts. */
export const GET = withErrorHandling(async (request: Request) => {
  enforceRateLimit(limiter, request);
  const [tree, counts] = await Promise.all([getCachedCategories(), getCachedCategoryCounts()]);
  const data = tree.map((category) => ({
    slug: category.slug,
    name: category.name,
    description: category.description,
    parentSlug: category.parentId ? (tree.find((entry) => entry.id === category.parentId)?.slug ?? null) : null,
    image: category.image,
    productCount: counts[category.id]?.count ?? 0,
  }));
  return catalogApiResponse(data, { page: 1, pageSize: data.length, total: data.length, totalPages: 1 });
}, "api-categories");
