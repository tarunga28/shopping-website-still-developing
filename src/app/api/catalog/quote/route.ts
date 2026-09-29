import { apiOk, withErrorHandling } from "@/lib/api-response";
import { RateLimitError, ValidationError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { quoteSku } from "@/services/catalog-query.service";

export const dynamic = "force-dynamic";

const limiter = createRateLimiter({ limit: 30, windowMs: 60_000, namespace: "catalog-quote" });

/** Authoritative price. A client-supplied price is ignored. */
export const POST = withErrorHandling(async (request: Request) => {
  const { success } = limiter.check(clientIp(request));
  if (!success) throw new RateLimitError();
  let body: { sku?: unknown; clientPricePaise?: unknown };
  try {
    body = (await request.json()) as { sku?: unknown; clientPricePaise?: unknown };
  } catch {
    throw new ValidationError("Invalid request body.");
  }
  if (typeof body.sku !== "string" || !/^[A-Z0-9][A-Z0-9-]*$/.test(body.sku)) {
    throw new ValidationError("A valid SKU is required.");
  }
  const clientPrice = typeof body.clientPricePaise === "number" ? body.clientPricePaise : null;
  return apiOk(await quoteSku(body.sku, clientPrice));
}, "catalog-quote");
