import { apiOk, withErrorHandling } from "@/lib/api-response";
import { catalogApiLimiter, enforceRateLimit } from "@/lib/catalog/api";
import { ValidationError } from "@/lib/errors";
import { requireCatalogEditorApi } from "@/server/auth/catalog-access";
import { getOptionalUser } from "@/server/auth/session";
import { canEditCatalog } from "@/lib/catalog-rules";
import { listBrands, type BrandSummary } from "@/services/catalog/brand.service";
import { createBrand } from "@/services/catalog/brand.service";
import { brandWriteSchema } from "@/validations/catalog";

export const dynamic = "force-dynamic";

const limiter = catalogApiLimiter("api-brands", 90);
const writeLimiter = catalogApiLimiter("api-brands-write", 30);

/**
 * Brands are public, but the row carries seller attribution and SEO drafts that
 * are not. The projection is explicit rather than a field-deletion list, so a
 * new internal column cannot leak by default.
 */
function publicBrand(brand: BrandSummary) {
  return {
    id: brand.id,
    name: brand.name,
    slug: brand.slug,
    description: brand.description,
    logoUrl: brand.logoUrl,
    bannerUrl: brand.bannerUrl,
    productCount: brand.productCount,
  };
}

/**
 * GET /api/brands?search=&includeInactive=&limit=
 *
 * Active brands only for anonymous callers. `includeInactive` and `search` are
 * honoured for catalog editors, because the admin form needs to find a disabled
 * brand before it can reactivate it.
 */
export const GET = withErrorHandling(async (request: Request) => {
  enforceRateLimit(limiter, request);
  const url = new URL(request.url);

  const user = await getOptionalUser().catch(() => null);
  const isEditor = Boolean(user && canEditCatalog(user.role));

  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 200) : 100;

  const brands = await listBrands({
    includeInactive: isEditor && url.searchParams.get("includeInactive") === "true",
    search: url.searchParams.get("search"),
    limit,
  });

  return apiOk({ brands: isEditor ? brands : brands.map(publicBrand) });
}, "api-brands");

/** POST /api/brands — create a brand. Requires a catalog editor. */
export const POST = withErrorHandling(async (request: Request) => {
  enforceRateLimit(writeLimiter, request);
  const user = await requireCatalogEditorApi();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ValidationError("Invalid request body.");
  }

  const parsed = brandWriteSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the brand.");
  }

  const created = await createBrand(parsed.data, { actorId: user.id });
  return apiOk(created);
}, "api-brand-create");
