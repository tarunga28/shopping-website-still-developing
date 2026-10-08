import { apiOk, withErrorHandling } from "@/lib/api-response";
import { catalogApiLimiter, catalogApiResponse, enforceRateLimit } from "@/lib/catalog/api";
import { ValidationError } from "@/lib/errors";
import { requireCatalogEditorApi } from "@/server/auth/catalog-access";
import { authRequestContext } from "@/server/auth/session";
import { getCachedCategories, getCachedCategoryCounts } from "@/services/catalog/cached";
import { createCategory } from "@/services/catalog-admin.service";
import { categoryWriteSchema } from "@/validations/catalog";

export const dynamic = "force-dynamic";

const limiter = catalogApiLimiter("api-categories");
const writeLimiter = catalogApiLimiter("api-category-write");

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

/**
 * POST /api/categories — create a category. Requires a catalog editor.
 *
 * Added alongside the public tree read rather than replacing it; the same path
 * serves both, and authorisation decides which one applies.
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

  const parsed = categoryWriteSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the category.");
  }

  const contextInfo = await authRequestContext(request.headers);
  const created = await createCategory({ id: user.id, role: user.role, ...contextInfo }, parsed.data);
  return apiOk(created);
}, "api-category-create");
