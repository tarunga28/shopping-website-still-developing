import { apiOk, apiFail, withErrorHandling } from "@/lib/api-response";
import { catalogApiLimiter, enforceRateLimit } from "@/lib/catalog/api";
import { getProductBySlugPublic } from "@/services/catalog/public-catalog.service";

export const dynamic = "force-dynamic";

const limiter = catalogApiLimiter("api-product-slug", 120);

/**
 * GET /api/products/slug/:slug
 *
 * Slug-addressed lookup, which is what SEO URLs and canonical links need.
 * Returns the public projection only.
 *
 * A missing or hidden product returns a 404 with the same body either way, so
 * the endpoint cannot be used to enumerate unpublished slugs.
 */
export const GET = withErrorHandling(async (_request: Request, context: { params: Promise<{ slug: string }> }) => {
  enforceRateLimit(limiter, _request);

  const { slug } = await context.params;
  const product = await getProductBySlugPublic(slug);

  if (!product) {
    return apiFail(404, "product_not_found", "Product not found.");
  }

  return apiOk(product);
}, "api-product-slug");
