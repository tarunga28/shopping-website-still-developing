import { z } from "zod";

import { apiOk, withErrorHandling } from "@/lib/api-response";
import { catalogApiLimiter, enforceRateLimit } from "@/lib/catalog/api";
import { ValidationError } from "@/lib/errors";
import { looksLikeBot, searchSessionHash } from "@/lib/search/session";
import { resolveRecommendationType } from "@/lib/recommendations/types";
import {
  applyEventToInterest,
  recordBehavioralEvents,
  recordImpressions,
  recordRecommendationAction,
  type BehavioralEventInput,
} from "@/services/recommendations/events.service";
import { getOptionalUser } from "@/server/auth/session";

export const dynamic = "force-dynamic";

/**
 * Event ingest is the highest-volume write endpoint in Part 13: every
 * impression on every rail posts here. The limit is generous enough for real
 * browsing but bounded, because an unbounded ingest endpoint is how an
 * analytics table becomes a denial-of-service against the database.
 */
const limiter = catalogApiLimiter("api-recommendation-events", 240);

/** Maximum events accepted per request. A rail renders at most a few dozen. */
const MAX_EVENTS_PER_REQUEST = 60;

const impressionItemSchema = z.object({
  productId: z.string().uuid(),
  position: z.number().int().min(1).max(500),
});

const eventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("impression"),
    recommendationId: z.string().min(8).max(128),
    type: z.string().min(1).max(64),
    algorithmVersion: z.string().max(64).optional(),
    items: z.array(impressionItemSchema).min(1).max(MAX_EVENTS_PER_REQUEST),
  }),
  z.object({
    kind: z.literal("action"),
    eventType: z.enum(["CLICKED", "ADDED_TO_CART", "PURCHASED"]),
    recommendationId: z.string().min(8).max(128).optional(),
    type: z.string().min(1).max(64),
    productId: z.string().uuid(),
    position: z.number().int().min(1).max(500).optional(),
    algorithmVersion: z.string().max(64).optional(),
    revenuePaise: z.number().int().min(0).max(100_000_000).optional(),
  }),
  z.object({
    kind: z.literal("behavioral"),
    events: z
      .array(
        z.object({
          eventType: z.string().min(1).max(64),
          productId: z.string().uuid().optional(),
          variantId: z.string().uuid().optional(),
          categoryId: z.string().uuid().optional(),
          brandId: z.string().uuid().optional(),
          searchQuery: z.string().max(200).optional(),
          source: z.string().max(64).optional(),
        }),
      )
      .min(1)
      .max(MAX_EVENTS_PER_REQUEST),
  }),
]);

/**
 * POST /api/recommendations/events
 *
 * One endpoint for three event shapes, because they share an identity model
 * (user or salted session) and a rate limit, and splitting them would mean
 * three endpoints to keep in sync for no benefit.
 *
 *   kind=impression   a rail was rendered; items carry positions
 *   kind=action       a recommended product was clicked / carted / purchased
 *   kind=behavioral   a raw storefront event, folded into interest signals
 *
 * Every request is acknowledged with `accepted`, even when some events were
 * dropped. A client that retries on partial failure would double-count the
 * events that did land, which is worse than losing the ones that did not.
 *
 * Bot traffic is dropped rather than rejected, for the same reason the search
 * click endpoint does it: a crawler should not learn it was detected, and the
 * client should not retry.
 */
export const POST = withErrorHandling(async (request: Request) => {
  enforceRateLimit(limiter, request);

  if (looksLikeBot(request)) {
    return apiOk({ accepted: 0, ignored: "bot" });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ValidationError("Request body must be JSON");
  }

  const parsed = eventSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError("Invalid recommendation event payload", parsed.error.flatten());
  }

  const user = await getOptionalUser().catch(() => null);
  const sessionHash = searchSessionHash({ userId: user?.id ?? null, request });
  const payload = parsed.data;

  if (payload.kind === "impression") {
    const type = resolveRecommendationType(payload.type);
    if (!type) throw new ValidationError(`Unknown recommendation type: ${payload.type}`);

    const recorded = await recordImpressions({
      recommendationId: payload.recommendationId,
      type,
      algorithmVersion: payload.algorithmVersion ?? null,
      userId: user?.id ?? null,
      sessionHash,
      items: payload.items,
    });
    return apiOk({ accepted: recorded, kind: "impression" });
  }

  if (payload.kind === "action") {
    const type = resolveRecommendationType(payload.type);
    if (!type) throw new ValidationError(`Unknown recommendation type: ${payload.type}`);

    const recorded = await recordRecommendationAction({
      eventType: payload.eventType,
      recommendationId: payload.recommendationId ?? null,
      recommendationType: type,
      productId: payload.productId,
      position: payload.position ?? null,
      algorithmVersion: payload.algorithmVersion ?? null,
      userId: user?.id ?? null,
      sessionHash,
      revenuePaise: payload.revenuePaise ?? 0,
    });

    // A purchase or add-to-cart is also a strong interest signal, so it feeds
    // the profile as well as the recommendation metrics.
    if (recorded && (payload.eventType === "PURCHASED" || payload.eventType === "ADDED_TO_CART")) {
      await applyEventToInterest({
        userId: user?.id ?? null,
        sessionId: sessionHash,
        eventType: payload.eventType === "PURCHASED" ? "PURCHASE" : "ADD_TO_CART",
        productId: payload.productId,
      }).catch(() => 0);
    }

    return apiOk({ accepted: recorded ? 1 : 0, kind: "action" });
  }

  // kind === "behavioral"
  const rows: BehavioralEventInput[] = payload.events.map((event) => ({
    eventType: event.eventType,
    userId: user?.id ?? null,
    sessionId: sessionHash,
    productId: event.productId ?? null,
    variantId: event.variantId ?? null,
    categoryId: event.categoryId ?? null,
    brandId: event.brandId ?? null,
    searchQuery: event.searchQuery ?? null,
    source: event.source ?? null,
  }));

  const recorded = await recordBehavioralEvents(rows);

  // Fold each event into interest signals. Done best-effort per event so one
  // malformed row cannot lose the whole batch.
  let folded = 0;
  for (const event of payload.events) {
    const count = await applyEventToInterest({
      userId: user?.id ?? null,
      sessionId: sessionHash,
      eventType: event.eventType,
      productId: event.productId ?? null,
      categoryId: event.categoryId ?? null,
      brandId: event.brandId ?? null,
    }).catch(() => 0);
    folded += count;
  }

  return apiOk({ accepted: recorded, interestSignals: folded, kind: "behavioral" });
});
