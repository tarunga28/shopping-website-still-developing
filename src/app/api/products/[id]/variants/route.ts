import { z } from "zod";

import { apiOk, withErrorHandling } from "@/lib/api-response";
import { catalogApiLimiter, enforceRateLimit } from "@/lib/catalog/api";
import { ValidationError } from "@/lib/errors";
import { attributeValueKey, cleanAttributeValue } from "@/lib/catalog/attributes";
import { getOptionalUser } from "@/server/auth/session";
import { canEditCatalog } from "@/lib/catalog-rules";
import { requireCatalogEditorApi } from "@/server/auth/catalog-access";
import {
  createVariant,
  listVariants,
  type VariantWithAttributes,
} from "@/services/catalog/variant.service";
import { flexibleVariantWriteSchema } from "@/validations/catalog";

export const dynamic = "force-dynamic";

const readLimiter = catalogApiLimiter("api-variants", 90);
const writeLimiter = catalogApiLimiter("api-variants-write", 30);

async function idFrom(context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) throw new ValidationError("Invalid product id.");
  return id;
}

/**
 * Variants are public, but cost price is not. The storefront needs to know a
 * variant exists and what it costs the customer; what it cost us is a margin
 * input and must never reach a public response.
 *
 * Explicit projection rather than deleting keys, so a future internal column
 * cannot leak by default.
 */
function publicVariant(variant: VariantWithAttributes) {
  return {
    id: variant.id,
    sku: variant.sku,
    name: variant.name,
    price: variant.price,
    compareAtPrice: variant.compareAtPrice,
    barcode: variant.barcode,
    availability: variant.availability,
    stockQuantity: variant.stockQuantity,
    isActive: variant.isActive,
    position: variant.position,
    attributes: variant.attributes,
  };
}

/**
 * GET /api/products/:id/variants
 *
 * Full rows (including cost price) for catalog editors, public projection for
 * everyone else. The branch is decided by the session role, never by a query
 * parameter — otherwise a client could ask for the internal shape.
 */
export const GET = withErrorHandling(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(readLimiter, request);
  const productId = await idFrom(context);
  const variants = await listVariants(productId);

  const user = await getOptionalUser().catch(() => null);
  const isEditor = Boolean(user && canEditCatalog(user.role));

  return apiOk({
    scope: isEditor ? "admin" : "public",
    variants: isEditor ? variants : variants.map(publicVariant),
  });
}, "api-variants");

/**
 * POST /api/products/:id/variants — add a variant. Requires a catalog editor.
 *
 * Runs inside the service's own transaction, which writes the attribute rows,
 * the combo hash and the opening STOCK_IN ledger entry together — so a variant
 * can never exist with stock that the ledger cannot account for.
 */
export const POST = withErrorHandling(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(writeLimiter, request);
  const user = await requireCatalogEditorApi();
  const productId = await idFrom(context);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ValidationError("Invalid request body.");
  }

  const parsed = flexibleVariantWriteSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the variant.");
  }

  // The wire format is a plain { axisCode: value } map because that is what a
  // form can submit; the service works in assignments, which carry the canonical
  // key and the display label separately. Deriving both here keeps the combo
  // hash consistent with variants created through the bulk generator.
  const { attributes, ...rest } = parsed.data;
  const assignments = Object.entries(attributes).map(([code, value]) => ({
    code,
    valueKey: attributeValueKey(value),
    valueLabel: cleanAttributeValue(value),
    optionId: null,
  }));

  const created = await createVariant({ id: user.id }, productId, { ...rest, assignments });
  return apiOk(created);
}, "api-variant-create");
