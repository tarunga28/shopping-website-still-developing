import { withErrorHandling } from "@/lib/api-response";
import { catalogApiLimiter, catalogApiResponse, enforceRateLimit } from "@/lib/catalog/api";
import { parseApiCatalogParams } from "@/lib/catalog/params";
import { getCatalogProducts } from "@/services/catalog/public-catalog.service";

export const dynamic = "force-dynamic";

const limiter = catalogApiLimiter("api-products", 90);

/**
 * GET /api/products?category=&collection=&type=&size=&color=&minPrice=&maxPrice=
 *   &availability=available&sort=&page=&pageSize=
 * Every parameter is validated; invalid values are ignored. Returns PublicProductDTO only.
 */
export const GET = withErrorHandling(async (request: Request) => {
  enforceRateLimit(limiter, request);
  const params = parseApiCatalogParams(new URL(request.url).searchParams);
  const result = await getCatalogProducts({
    category: params.category,
    collection: params.collection,
    filters: params.filters,
    page: params.filters.page,
    pageSize: params.pageSize,
  });
  const { page, pageSize, total, totalPages } = result.pagination;
  return catalogApiResponse(result.products, { page, pageSize, total, totalPages });
}, "api-products");
