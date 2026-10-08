import { apiOk, withErrorHandling } from "@/lib/api-response";
import { catalogApiLimiter, catalogApiResponse, enforceRateLimit } from "@/lib/catalog/api";
import { parseApiCatalogParams } from "@/lib/catalog/params";
import { ValidationError } from "@/lib/errors";
import { requireCatalogEditorApi } from "@/server/auth/catalog-access";
import { authRequestContext } from "@/server/auth/session";
import { createProduct } from "@/services/catalog-admin.service";
import { getCatalogProducts } from "@/services/catalog/public-catalog.service";
import { productWriteSchema } from "@/validations/catalog";

export const dynamic = "force-dynamic";

const limiter = catalogApiLimiter("api-products", 90);
const writeLimiter = catalogApiLimiter("api-products-write", 30);

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

/**
 * POST /api/products — create a product. Requires a catalog editor.
 *
 * Sits on the public listing path because that is where create belongs in REST
 * terms; authorisation, not the route path, separates reading from writing.
 * Returns the admin envelope because the caller is an editor.
 */
export const POST = withErrorHandling(async (request: Request) => {
  enforceRateLimit(writeLimiter, request);
  const user = await requireCatalogEditorApi();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ValidationError("Invalid request body.");
  }

  const parsed = productWriteSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the product.");
  }

  const contextInfo = await authRequestContext(request.headers);
  const created = await createProduct({ id: user.id, role: user.role, ...contextInfo }, parsed.data);
  return apiOk(created);
}, "api-product-create");
