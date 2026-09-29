import { withErrorHandling } from "@/lib/api-response";
import { catalogApiLimiter, catalogApiResponse, enforceRateLimit } from "@/lib/catalog/api";
import { getCachedCollections } from "@/services/catalog/cached";

export const dynamic = "force-dynamic";

const limiter = catalogApiLimiter("api-collections");

/** GET /api/collections — ACTIVE, in-schedule collections only. */
export const GET = withErrorHandling(async (request: Request) => {
  enforceRateLimit(limiter, request);
  const rows = await getCachedCollections();
  const data = rows.map((row) => ({
    slug: row.slug,
    name: row.name,
    description: row.description,
    image: row.image,
    productCount: row.productCount,
  }));
  return catalogApiResponse(data, { page: 1, pageSize: data.length, total: data.length, totalPages: 1 });
}, "api-collections");
