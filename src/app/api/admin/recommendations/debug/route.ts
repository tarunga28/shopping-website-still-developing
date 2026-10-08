import { z } from "zod";

import { apiOk, withErrorHandling } from "@/lib/api-response";
import { catalogApiLimiter, enforceRateLimit } from "@/lib/catalog/api";
import { ValidationError } from "@/lib/errors";
import { resolveRecommendationType } from "@/lib/recommendations/types";
import {
  explainSimilarity,
  listRecentRequests,
  requestImpressions,
  seedTableCoverage,
  traceRecommendation,
} from "@/services/recommendations/debug.service";
import { requireCatalogEditorApi } from "@/server/auth/catalog-access";

export const dynamic = "force-dynamic";

const limiter = catalogApiLimiter("api-admin-recommendation-debug", 30);

const querySchema = z.object({
  /** trace | similarity | requests | impressions | coverage */
  view: z.enum(["trace", "similarity", "requests", "impressions", "coverage"]).default("trace"),
  type: z.string().max(64).optional(),
  productId: z.string().uuid().optional(),
  otherProductId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  requestId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(40).optional(),
  degradedOnly: z.enum(["true", "false"]).optional(),
});

/**
 * GET /api/admin/recommendations/debug
 *
 *   view=trace        full candidate trace for a type + seed + subject
 *   view=similarity   why two specific products score as similar
 *   view=requests     recent requests, optionally only degraded ones
 *   view=impressions  what a specific request actually returned
 *   view=coverage     precomputed-table coverage for a seed product
 *
 * The diagnostic endpoint behind §42. It exposes score breakdowns and
 * exclusion reasons — precisely the internals §36 keeps out of the public
 * response — which is why it sits behind the catalog-editor check.
 *
 * A trace re-runs the real pipeline rather than replaying a stored result,
 * because the question is normally "what would happen now", and a stored trace
 * would describe a candidate pool that has since changed. Nothing is persisted,
 * so debugging cannot pollute the metrics it is explaining.
 */
export const GET = withErrorHandling(async (request: Request) => {
  enforceRateLimit(limiter, request);
  await requireCatalogEditorApi();

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    view: url.searchParams.get("view") ?? "trace",
    type: url.searchParams.get("type") ?? undefined,
    productId: url.searchParams.get("productId") ?? undefined,
    otherProductId: url.searchParams.get("otherProductId") ?? undefined,
    categoryId: url.searchParams.get("categoryId") ?? undefined,
    userId: url.searchParams.get("userId") ?? undefined,
    requestId: url.searchParams.get("requestId") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    degradedOnly: url.searchParams.get("degradedOnly") ?? undefined,
  });
  if (!parsed.success) {
    throw new ValidationError("Invalid debug request", parsed.error.flatten());
  }
  const input = parsed.data;

  if (input.view === "similarity") {
    if (!input.productId || !input.otherProductId) {
      throw new ValidationError("similarity view requires productId and otherProductId");
    }
    const breakdown = await explainSimilarity(input.productId, input.otherProductId);
    if (!breakdown) {
      throw new ValidationError("One or both products are not in the search index");
    }
    return apiOk({ view: "similarity", ...breakdown });
  }

  if (input.view === "requests") {
    const type = input.type ? resolveRecommendationType(input.type) : null;
    if (input.type && !type) {
      throw new ValidationError(`Unknown recommendation type: ${input.type}`);
    }
    const requests = await listRecentRequests({
      limit: input.limit ?? 50,
      type: type ?? undefined,
      degradedOnly: input.degradedOnly === "true",
    });
    return apiOk({ view: "requests", requests });
  }

  if (input.view === "impressions") {
    if (!input.requestId) throw new ValidationError("impressions view requires requestId");
    const impressions = await requestImpressions(input.requestId);
    return apiOk({ view: "impressions", requestId: input.requestId, impressions });
  }

  if (input.view === "coverage") {
    if (!input.productId) throw new ValidationError("coverage view requires productId");
    const coverage = await seedTableCoverage(input.productId);
    return apiOk({ view: "coverage", productId: input.productId, ...coverage });
  }

  // view === "trace"
  const type = resolveRecommendationType(input.type ?? "");
  if (!type) {
    throw new ValidationError(`A valid recommendation type is required, got: ${input.type ?? "(none)"}`);
  }

  const trace = await traceRecommendation({
    type,
    productId: input.productId ?? null,
    categoryId: input.categoryId ?? null,
    userId: input.userId ?? null,
    limit: input.limit ?? 12,
  });

  return apiOk({ view: "trace", trace });
});
