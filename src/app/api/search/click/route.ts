import { z } from "zod";

import { apiOk, withErrorHandling } from "@/lib/api-response";
import { catalogApiLimiter, enforceRateLimit } from "@/lib/catalog/api";
import { ValidationError } from "@/lib/errors";
import { searchSessionHash, looksLikeBot } from "@/lib/search/session";
import { getActiveRankingConfig } from "@/services/search/config.service";
import { db } from "@/db";
import { searchEvents } from "@/db/schema";
import { logger } from "@/lib/logger";
import { getOptionalUser } from "@/server/auth/session";

export const dynamic = "force-dynamic";

const limiter = catalogApiLimiter("api-search-click", 120);

/**
 * What a shopper did after searching.
 *
 * Bounded so a misbehaving client cannot inflate the analytics: position must be
 * a plausible result slot, and the event type is a closed set.
 */
const clickSchema = z.object({
  searchLogId: z.string().uuid(),
  productId: z.string().uuid().optional(),
  position: z.number().int().min(1).max(500).optional(),
  eventType: z.enum(["CLICK", "ADD_TO_CART", "PURCHASE", "NO_CLICK"]).default("CLICK"),
});

/**
 * POST /api/search/click
 *
 * Records a click, add-to-cart, or purchase against the search that produced it.
 * This is the measurement side of search: without it there is no way to tell
 * whether a ranking change helped or hurt, and relevance tuning becomes opinion.
 *
 * Bot traffic is dropped rather than recorded. A crawler clicking through a
 * result set would otherwise look like the most engaged shopper on the site.
 */
export const POST = withErrorHandling(async (request: Request) => {
  enforceRateLimit(limiter, request);

  if (looksLikeBot(request)) {
    // Acknowledged rather than rejected: a bot should not learn that it was
    // detected, and the client should not retry.
    return apiOk({ recorded: false, reason: "ignored" });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ValidationError("Invalid request body.");
  }

  const parsed = clickSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid click payload.");
  }

  const user = await getOptionalUser().catch(() => null);
  const sessionHash = searchSessionHash({ userId: user?.id ?? null, request });

  try {
    const [config] = await Promise.all([getActiveRankingConfig()]);

    await db.insert(searchEvents).values({
      searchLogId: parsed.data.searchLogId,
      productId: parsed.data.productId ?? null,
      position: parsed.data.position ?? null,
      eventType: parsed.data.eventType,
      sessionHash,
      rankingVersion: config.version,
      experimentVariant: null,
    });

    return apiOk({ recorded: true });
  } catch (error) {
    // Analytics must never surface as an error to the shopper. A failed click
    // record costs one data point; a red error on a product page costs a sale.
    logger.warn("could not record a search event", {
      error: error instanceof Error ? error.message : String(error),
    });
    return apiOk({ recorded: false, reason: "unavailable" });
  }
}, "api-search-click");
