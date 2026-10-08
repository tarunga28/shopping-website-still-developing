import { z } from "zod";

import { apiOk, withErrorHandling } from "@/lib/api-response";
import { catalogApiLimiter, enforceRateLimit } from "@/lib/catalog/api";
import { ValidationError } from "@/lib/errors";
import { requireCatalogEditorApi } from "@/server/auth/catalog-access";
import { authRequestContext } from "@/server/auth/session";
import {
  archiveCategory,
  updateCategory,
} from "@/services/catalog-admin.service";
import { categoryWriteSchema } from "@/validations/catalog";

const limiter = catalogApiLimiter("api-category-detail", 60);

async function idFrom(context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) throw new ValidationError("Invalid category id.");
  return id;
}

async function bodyFrom(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ValidationError("Invalid request body.");
  }
}

/**
 * PUT /api/categories/:id — full update. Requires a catalog editor.
 *
 * The slug history, the materialized path and the ancestor chain are all
 * recomputed inside the service, so a rename here cannot leave stale paths
 * behind on the descendants.
 */
export const PUT = withErrorHandling(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(limiter, request);
  const user = await requireCatalogEditorApi();
  const id = await idFrom(context);

  const parsed = categoryWriteSchema.safeParse(await bodyFrom(request));
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the category.");
  }

  const contextInfo = await authRequestContext(request.headers);
  const updated = await updateCategory({ id: user.id, role: user.role, ...contextInfo }, id, parsed.data);
  return apiOk(updated);
}, "api-category-update");

/**
 * DELETE /api/categories/:id
 *
 * Archives rather than hard-deletes, for the same reason as products: products,
 * collections and the category's own descendants reference this row. Archiving
 * keeps those references resolvable and takes the subtree off the storefront.
 *
 * `?reassignTo=<categoryId>` moves the live products to another category first.
 * The service refuses to archive a category that still has active products and
 * no reassignment target, so the storefront can never lose them silently.
 */
export const DELETE = withErrorHandling(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(limiter, request);
  const user = await requireCatalogEditorApi();
  const id = await idFrom(context);

  const url = new URL(request.url);
  const reassignParam = url.searchParams.get("reassignTo");
  const reassignToId = reassignParam?.trim() ? reassignParam.trim() : null;

  const contextInfo = await authRequestContext(request.headers);
  await archiveCategory({ id: user.id, role: user.role, ...contextInfo }, id, reassignToId);
  return apiOk({ archived: true, id, reassignToId });
}, "api-category-delete");
