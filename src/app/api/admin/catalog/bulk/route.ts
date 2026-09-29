import { apiOk, withErrorHandling } from "@/lib/api-response";
import { ValidationError } from "@/lib/errors";
import { requireCatalogEditorApi } from "@/server/auth/catalog-access";
import { authRequestContext } from "@/server/auth/session";
import { bulkCatalog } from "@/services/catalog-admin.service";
import { bulkSchema } from "@/validations/catalog";

export const dynamic = "force-dynamic";

export const POST = withErrorHandling(async (request: Request) => {
  const user = await requireCatalogEditorApi();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ValidationError("Invalid request body.");
  }
  const parsed = bulkSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the bulk action.");
  const actorContext = await authRequestContext(request.headers);
  return apiOk(await bulkCatalog({ id: user.id, role: user.role, ...actorContext }, parsed.data));
}, "admin-catalog-bulk");
