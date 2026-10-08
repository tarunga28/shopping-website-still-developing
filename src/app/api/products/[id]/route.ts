import { z } from "zod";

import { apiOk, withErrorHandling } from "@/lib/api-response";
import { catalogApiLimiter, enforceRateLimit } from "@/lib/catalog/api";
import { ValidationError } from "@/lib/errors";
import { requireCatalogEditorApi } from "@/server/auth/catalog-access";
import { authRequestContext } from "@/server/auth/session";
import {
  archiveProduct,
  getAdminProduct,
  updateProduct,
} from "@/services/catalog-admin.service";
import { getProductByIdPublic } from "@/services/catalog/public-catalog.service";
import { getOptionalUser } from "@/server/auth/session";
import { canEditCatalog } from "@/lib/catalog-rules";
import { productWriteSchema } from "@/validations/catalog";

export const dynamic = "force-dynamic";

const readLimiter = catalogApiLimiter("api-product-detail", 120);
const writeLimiter = catalogApiLimiter("api-product-write", 30);

async function idFrom(context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) throw new ValidationError("Invalid product id.");
  return id;
}

/**
 * GET /api/products/:id
 *
 * Public by default: returns the same public projection as the listing, so
 * internal fields (cost price, supplier references, admin notes, tax rate, the
 * search vector) cannot leak through this route.
 *
 * A catalog editor gets the admin shape instead, because the edit form needs the
 * fields the storefront must never see. The branch is driven by the session role,
 * never by a request parameter.
 */
export const GET = withErrorHandling(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(readLimiter, request);
  const id = await idFrom(context);

  const user = await getOptionalUser().catch(() => null);
  if (user && canEditCatalog(user.role)) {
    const detail = await getAdminProduct(id);
    return apiOk({ scope: "admin", product: detail });
  }

  const product = await getProductByIdPublic(id);
  return apiOk({ scope: "public", product });
}, "api-product-detail");

/**
 * PUT /api/products/:id — full update. Requires a catalog editor.
 */
export const PUT = withErrorHandling(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(writeLimiter, request);
  const user = await requireCatalogEditorApi();
  const id = await idFrom(context);

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
  const updated = await updateProduct({ id: user.id, role: user.role, ...contextInfo }, id, parsed.data);
  return apiOk(updated);
}, "api-product-update");

/**
 * DELETE /api/products/:id
 *
 * Archives rather than hard-deletes. Products are referenced by orders, reviews,
 * wishlists and carts; removing the row would either fail on a foreign key or
 * orphan real history. Archiving keeps every reference intact while taking the
 * product off the storefront — which is what "delete" means operationally.
 */
export const DELETE = withErrorHandling(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(writeLimiter, request);
  const user = await requireCatalogEditorApi();
  const id = await idFrom(context);

  const contextInfo = await authRequestContext(request.headers);
  await archiveProduct({ id: user.id, role: user.role, ...contextInfo }, id);
  return apiOk({ archived: true, id });
}, "api-product-delete");
