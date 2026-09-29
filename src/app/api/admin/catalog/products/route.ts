import { apiOk, withErrorHandling } from "@/lib/api-response";
import { ValidationError } from "@/lib/errors";
import { requireCatalogEditorApi } from "@/server/auth/catalog-access";
import { authRequestContext } from "@/server/auth/session";
import { createProduct } from "@/services/catalog-admin.service";
import { catalogQueryFromSearch, listCatalog } from "@/services/catalog-query.service";
import { productWriteSchema } from "@/validations/catalog";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async (request: Request) => {
  await requireCatalogEditorApi();
  const url = new URL(request.url);
  return apiOk(await listCatalog(catalogQueryFromSearch(url.searchParams, "admin")));
}, "admin-catalog-list");

export const POST = withErrorHandling(async (request: Request) => {
  const user = await requireCatalogEditorApi();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ValidationError("Invalid request body.");
  }
  const parsed = productWriteSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the product.");
  const context = await authRequestContext(request.headers);
  const created = await createProduct({ id: user.id, role: user.role, ...context }, parsed.data);
  return apiOk(created, { status: 201 });
}, "admin-catalog-create");
