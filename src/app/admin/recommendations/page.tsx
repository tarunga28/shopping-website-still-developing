import { AdminShell } from "@/components/layouts/admin-shell";
import { RecommendationDashboard } from "@/components/admin/recommendation-dashboard";
import { ErrorState } from "@/components/ui/error-state";
import { requireCatalogEditor } from "@/server/auth/catalog-access";
import {
  ctrByPosition,
  metricsTimeSeries,
  performanceByType,
  recommendationOverview,
  topRecommendedProducts,
} from "@/services/recommendations/metrics.service";
import { computeCoverage } from "@/services/recommendations/compute.service";
import { getFeatureFlags, getSettings, listConfigs } from "@/services/recommendations/config.service";
import { listRecentRequests } from "@/services/recommendations/debug.service";

export const dynamic = "force-dynamic";

/**
 * The recommendation operations dashboard (§41).
 *
 * Data is loaded on the server and handed to one client component for the
 * interactive parts, matching how the search dashboard is built: server-
 * rendered numbers that are correct on first paint, with the operator able to
 * switch windows and expand tables without a reload.
 *
 * Every loader is individually caught. This is a monitoring surface, and a
 * monitoring surface that fails wholesale because one aggregate query is slow
 * is worse than one that shows the seven things it could load.
 *
 * The most important number on this page is not CTR — it is **coverage** and
 * **fallback rate**. A rail can show a healthy CTR while quietly serving the
 * global-popularity fallback for most requests, because the fallback still
 * returns plausible-looking products. Coverage falling is the early warning
 * that the offline job has stopped running; CTR falling is the late one.
 */
export default async function AdminRecommendationsPage() {
  await requireCatalogEditor();

  const [overview, byType, positions, topProducts, series, coverage, flags, settings, configs, degradedRequests] =
    await Promise.all([
      recommendationOverview({ windowDays: 30 }).catch(() => null),
      performanceByType({ windowDays: 30 }).catch(() => []),
      ctrByPosition({ windowDays: 30 }).catch(() => []),
      topRecommendedProducts({ windowDays: 30, limit: 20 }).catch(() => []),
      metricsTimeSeries({ days: 30 }).catch(() => []),
      computeCoverage().catch(() => null),
      getFeatureFlags().catch(() => null),
      getSettings().catch(() => null),
      listConfigs().catch(() => []),
      // Degraded requests first: this is the list an operator opens the page
      // to look at.
      listRecentRequests({ limit: 25, degradedOnly: true }).catch(() => []),
    ]);

  const loadFailed = !overview && !coverage;

  return (
    <AdminShell>
      <h1 className="font-display text-3xl font-extrabold uppercase">Recommendations</h1>
      <p className="mt-2 max-w-prose text-sm text-smoke">
        Impressions, click-through, conversion and revenue per recommendation type, plus the health
        of the precomputed tables behind them. Coverage and fallback rate matter more than CTR here:
        a rail can look healthy while quietly serving the popularity fallback, because the fallback
        still returns plausible products.
      </p>

      {loadFailed ? (
        <div className="mt-8">
          <ErrorState
            kind="api"
            title="Recommendation metrics didn't load"
            description="Apply the Part 13 migration (drizzle/0008_recommendation_engine.sql), then refresh. The storefront is unaffected — recommendations fall back to popularity when the engine cannot answer."
          />
        </div>
      ) : (
        <div className="mt-8">
          <RecommendationDashboard
          overview={overview}
          byType={byType}
          positions={positions}
          topProducts={topProducts}
          series={series}
          coverage={coverage}
          flags={flags}
          settings={settings}
          configs={configs.map((config) => ({
            recommendationType: config.recommendationType,
            version: config.version,
            label: config.label,
            isActive: config.isActive,
            updatedAt: config.updatedAt.toISOString(),
          }))}
          degradedRequests={degradedRequests.map((request) => ({
            recommendationId: request.recommendationId,
            recommendationType: request.recommendationType,
            contextProductId: request.contextProductId,
            candidateCount: request.candidateCount,
            resultCount: request.resultCount,
            fallbackReason: request.fallbackReason,
            createdAt: request.createdAt.toISOString(),
          }))}
          />
        </div>
      )}
    </AdminShell>
  );
}
