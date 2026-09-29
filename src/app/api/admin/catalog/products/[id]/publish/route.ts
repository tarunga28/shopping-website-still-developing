import { apiOk, withErrorHandling } from "@/lib/api-response";
import { ValidationError } from "@/lib/errors";
import { requireCatalogEditorApi } from "@/server/auth/catalog-access";
import { authRequestContext } from "@/server/auth/session";
import { publishProduct } from "@/services/catalog-admin.service";
import { z } from "zod";

export const dynamic = "force-dynamic";

export const POST = withErrorHandling(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const user = await requireCatalogEditorApi();
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) throw new ValidationError("Invalid product id.");
  const actorContext = await authRequestContext(request.headers);
  await publishProduct({ id: user.id, role: user.role, ...actorContext }, id);
  return apiOk({ status: "ACTIVE" });
}, "admin-catalog-publish");
