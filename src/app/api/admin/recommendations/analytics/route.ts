import { z } from "zod";

import { apiOk, withErrorHandling } from "@/lib/api-response";
import { catalogApiLimiter, enforceRateLimit } from "@/lib/catalog/api";
import { ValidationError } from "@/lib/errors";
import { resolveRecommendationType } from "@/lib/recommendations/types";
import {
  ctrByPosition,
  metricsTimeSeries,
  performanceByType,
  recommendationOverview,
  topRecommendedProducts,
} from "@/services/recommendations/metrics.service";
import { computeCoverage } from "@/services/recommendations/compute.service";
import { getFeatureFlags, getSettings, listConfigs } from "@/services/recommendations/config.service";
import { requireCatalogEditorApi } from "@/server/auth/catalog-access";

export const dynamic = "force-dynamic";

const limiter = catalogApiLimiter("api-admin-recommendation-analytics", 60);

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional(),
  type: z.string().max(64).optional(),
});

/**
 * GET /api/admin/recommendations/analytics
 *
 *   days   window for the overview and per-type breakdown, 1–365
 *   type   restrict the time series to one recommendation type
 *
 * One payload for the whole dashboard rather than five endpoints, because the
 * page renders all of it at once and five sequential admin requests would make
 * the dashboard visibly assemble itself.
 *
 * Admin-only: this exposes revenue attribution and per-type conversion, which
 * are competitive information and not part of any public response.
 */
export const GET = withErrorHandling(async (request: Request) => {
  enforceRateLimit(limiter, request);
  await requireCatalogEditorApi();

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    days: url.searchParams.get("days") ?? undefined,
    type: url.searchParams.get("type") ?? undefined,
  });
  if (!parsed.success) {
    throw new ValidationError("Invalid analytics request", parsed.error.flatten());
  }

  const days = parsed.data.days ?? 30;
  const type = parsed.data.type ? resolveRecommendationType(parsed.data.type) : null;
  if (parsed.data.type && !type) {
    throw new ValidationError(`Unknown recommendation type: ${parsed.data.type}`);
  }

  // Concurrent: these are independent aggregate queries and the dashboard
  // needs all of them, so there is no reason to serialize the round trips.
  const [overview, byType, positions, topProducts, series, coverage, flags, settings, configs] =
    await Promise.all([
      recommendationOverview({ windowDays: days }),
      performanceByType({ windowDays: days }),
      ctrByPosition({ windowDays: days }),
      topRecommendedProducts({ windowDays: days }),
      metricsTimeSeries({ days, type: type ?? undefined }),
      computeCoverage(),
      getFeatureFlags(),
      getSettings(),
      listConfigs(),
    ]);

  // Ranked by CTR so the weakest slots are visible without sorting by hand.
  const weakest = [...byType]
    .filter((row) => row.impressions >= 50)
    .sort((a, b) => a.ctr - b.ctr)
    .slice(0, 5);
  const strongest = [...byType]
    .filter((row) => row.impressions >= 50)
    .sort((a, b) => b.ctr - a.ctr)
    .slice(0, 5);

  return apiOk({
    overview,
    byType,
    strongest,
    weakest,
    positions,
    topProducts,
    series,
    coverage,
    flags,
    settings,
    configs: configs.map((config) => ({
      recommendationType: config.recommendationType,
      version: config.version,
      label: config.label,
      isActive: config.isActive,
      updatedAt: config.updatedAt,
    })),
  });
});
