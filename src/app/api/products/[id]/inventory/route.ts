import { z } from "zod";

import { apiOk, withErrorHandling } from "@/lib/api-response";
import { catalogApiLimiter, enforceRateLimit } from "@/lib/catalog/api";
import { ValidationError } from "@/lib/errors";
import { getOptionalUser } from "@/server/auth/session";
import { canEditCatalog } from "@/lib/catalog-rules";
import { requireCatalogEditorApi } from "@/server/auth/catalog-access";
import {
  adjustInventory,
  getInventoryLedger,
  getProductStock,
} from "@/services/catalog/inventory.service";
import { inventoryAdjustSchema } from "@/validations/catalog";

export const dynamic = "force-dynamic";

const readLimiter = catalogApiLimiter("api-inventory", 90);
const writeLimiter = catalogApiLimiter("api-inventory-write", 30);

async function idFrom(context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) throw new ValidationError("Invalid product id.");
  return id;
}

/**
 * GET /api/products/:id/inventory
 *
 * Stock levels are public — the storefront has to show availability — but the
 * ledger is not. A ledger exposes supplier movements, damage write-offs and
 * cancellation patterns, so it is editor-only on the same path.
 */
export const GET = withErrorHandling(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  enforceRateLimit(readLimiter, request);
  const productId = await idFrom(context);

  const url = new URL(request.url);
  const variantId = url.searchParams.get("variantId") || null;

  const stock = await getProductStock(productId);
  if (!variantId) return apiOk({ scope: "public", productId, stock });

  const user = await getOptionalUser().catch(() => null);
  if (!user || !canEditCatalog(user.role)) {
    return apiOk({ scope: "public", productId, stock });
  }

  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 200) : 50;
  const offsetRaw = Number(url.searchParams.get("offset"));
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.trunc(offsetRaw) : 0;

  const ledger = await getInventoryLedger({ productId, variantId }, { limit, offset });
  return apiOk({ scope: "admin", productId, stock, ledger: ledger.entries, ledgerTotal: ledger.total });
}, "api-inventory");

/**
 * POST /api/products/:id/inventory — apply a stock movement.
 *
 * Every change goes through the ledger inside a transaction with a row lock, so
 * two concurrent adjustments cannot both succeed against the same stock. The
 * referenceId makes a replayed request a no-op, which is what makes this safe to
 * retry from a client that timed out.
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

  const parsed = inventoryAdjustSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the adjustment.");
  }

  const result = await adjustInventory({ id: user.id }, { ...parsed.data, productId });
  return apiOk(result);
}, "api-inventory-adjust");
