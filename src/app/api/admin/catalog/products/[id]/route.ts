import { apiOk, withErrorHandling } from "@/lib/api-response";
import { ValidationError } from "@/lib/errors";
import { requireCatalogEditorApi } from "@/server/auth/catalog-access";
import { authRequestContext } from "@/server/auth/session";
import { getAdminProduct, updateProduct } from "@/services/catalog-admin.service";
import { productWriteSchema } from "@/validations/catalog";
import { z } from "zod";

export const dynamic = "force-dynamic";

async function idFrom(context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) throw new ValidationError("Invalid product id.");
  return id;
}

export const GET = withErrorHandling(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  await requireCatalogEditorApi();
  const detail = await getAdminProduct(await idFrom(context));
  return apiOk({
    id: detail.product.id,
    name: detail.product.name,
    slug: detail.product.slug,
    status: detail.product.status,
    productType: detail.product.productType,
    pricePaise: detail.product.basePrice,
    compareAtPaise: detail.product.compareAtPrice,
    adminNotes: detail.product.adminNotes,
    supplierCostPaise: detail.supplierCostPaise,
    estimatedShippingPaise: detail.product.estimatedShippingPaise,
    estimatedPaymentFeePaise: detail.product.estimatedPaymentFeePaise,
    blockers: detail.blockers,
    referenced: detail.referenced,
    variants: detail.variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      name: variant.name,
      size: variant.size,
      color: variant.color,
      pricePaise: variant.price,
      availability: variant.availability,
    })),
  });
}, "admin-catalog-product");

export const PATCH = withErrorHandling(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const user = await requireCatalogEditorApi();
  const id = await idFrom(context);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ValidationError("Invalid request body.");
  }
  const parsed = productWriteSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the product.");
  const actorContext = await authRequestContext(request.headers);
  const updated = await updateProduct({ id: user.id, role: user.role, ...actorContext }, id, parsed.data);
  return apiOk(updated);
}, "admin-catalog-update");
