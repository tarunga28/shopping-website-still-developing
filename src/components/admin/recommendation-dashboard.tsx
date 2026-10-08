"use client";

import { AlertTriangle, CheckCircle2, MousePointerClick, ShoppingCart, TrendingUp } from "lucide-react";

import { StatCard } from "@/components/cards/stat-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The recommendation operations dashboard (§41).
 *
 * Ordered so the numbers that predict trouble come first. CTR is what people
 * ask for, but coverage and fallback rate are what actually warn you something
 * is wrong: when the offline job stops running, the engine silently degrades to
 * the popularity fallback, which still returns plausible products — so CTR
 * stays respectable while the recommendations stop being recommendations.
 */

export interface DashboardOverview {
  windowDays: number;
  impressions: number;
  clicks: number;
  addToCarts: number;
  purchases: number;
  revenuePaise: number;
  ctr: number;
  addToCartRate: number;
  conversionRate: number;
  revenuePerImpressionPaise: number;
  requests: number;
  fallbackRate: number;
  averageLatencyMs: number;
  zeroResultRate: number;
}

export interface TypePerformanceRow {
  recommendationType: string;
  impressions: number;
  clicks: number;
  purchases: number;
  revenuePaise: number;
  ctr: number;
  conversionRate: number;
  revenuePerImpressionPaise: number;
}

export interface PositionRow {
  position: number;
  impressions: number;
  clicks: number;
  ctr: number;
}

export interface TopProductRow {
  productId: string;
  name: string;
  slug: string;
  impressions: number;
  clicks: number;
  purchases: number;
  ctr: number;
}

export interface SeriesRow {
  date: string;
  recommendationType: string;
  impressions: number;
  clicks: number;
  purchases: number;
  revenuePaise: number;
  ctr: number;
}

export interface CoverageInfo {
  products: number;
  withSimilarity: number;
  withCoPurchase: number;
  withPopularity: number;
  similarityCoverage: number;
  coPurchaseCoverage: number;
  popularityCoverage: number;
}

export interface ConfigRow {
  recommendationType: string;
  version: string;
  label: string;
  isActive: boolean;
  updatedAt: string;
}

export interface DegradedRequestRow {
  recommendationId: string;
  recommendationType: string;
  contextProductId: string | null;
  candidateCount: number;
  resultCount: number;
  fallbackReason: string | null;
  createdAt: string;
}

export interface RecommendationDashboardProps {
  overview: DashboardOverview | null;
  byType: TypePerformanceRow[];
  positions: PositionRow[];
  topProducts: TopProductRow[];
  series: SeriesRow[];
  coverage: CoverageInfo | null;
  flags: Record<string, boolean> | null;
  settings: Record<string, number> | null;
  configs: ConfigRow[];
  degradedRequests: DegradedRequestRow[];
}

/** Paise to a readable rupee figure. */
function rupees(paise: number): string {
  if (!Number.isFinite(paise)) return "—";
  const value = paise / 100;
  if (value >= 100_000) return `₹${(value / 100_000).toFixed(2)}L`;
  if (value >= 1_000) return `₹${(value / 1_000).toFixed(1)}k`;
  return `₹${value.toFixed(0)}`;
}

function percent(value: number, places = 1): string {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(places)}%`;
}

function compact(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** A human label for the enum name, so the table does not shout in SCREAMING_SNAKE. */
function typeLabel(type: string): string {
  return type
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function RecommendationDashboard({
  overview,
  byType,
  positions,
  topProducts,
  coverage,
  flags,
  configs,
  degradedRequests,
}: RecommendationDashboardProps) {
  // Below this, the offline job is effectively not covering the catalog and
  // most requests are running on the content-similarity floor.
  const similarityLow = coverage ? coverage.similarityCoverage < 0.5 : false;
  const fallbackHigh = overview ? overview.fallbackRate > 0.15 : false;

  return (
    <div className="space-y-8">
      {(similarityLow || fallbackHigh) && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div>
            <p className="font-medium">Recommendations are degraded</p>
            <p className="mt-1 text-amber-800">
              {similarityLow
                ? `Only ${percent(coverage?.similarityCoverage ?? 0)} of the catalog has precomputed similarity, so most requests fall back to on-the-fly content similarity. `
                : ""}
              {fallbackHigh
                ? `${percent(overview?.fallbackRate ?? 0)} of requests used a fallback strategy rather than the one their type calls for. `
                : ""}
              Run <code className="rounded bg-amber-100 px-1">npm run recommendations:compute</code>.
            </p>
          </div>
        </div>
      )}

      {overview ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            icon={MousePointerClick}
            label="Click-through rate"
            value={percent(overview.ctr, 2)}
            hint={`${compact(overview.clicks)} clicks / ${compact(overview.impressions)} impressions`}
          />
          <StatCard
            icon={ShoppingCart}
            label="Conversion rate"
            value={percent(overview.conversionRate, 2)}
            hint={`${compact(overview.purchases)} purchases · ${rupees(overview.revenuePaise)} revenue`}
          />
          <StatCard
            icon={TrendingUp}
            label="Revenue / impression"
            value={rupees(overview.revenuePerImpressionPaise)}
            hint={`Add-to-cart rate ${percent(overview.addToCartRate, 2)}`}
          />
          <StatCard
            icon={fallbackHigh ? AlertTriangle : CheckCircle2}
            label="Fallback rate"
            value={percent(overview.fallbackRate)}
            hint={`${compact(overview.requests)} requests · p50 ${overview.averageLatencyMs}ms`}
          />
        </div>
      ) : null}

      {coverage ? (
        <Card>
          <CardHeader>
            <CardTitle>Precomputed table coverage</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-smoke">
              {compact(coverage.products)} searchable products. A rail for a product with no row in
              these tables falls back to a weaker strategy, so coverage is the earliest signal that
              the offline job has stopped running.
            </p>
            <dl className="mt-4 grid gap-4 sm:grid-cols-3">
              <CoverageBar label="Similarity" value={coverage.similarityCoverage} count={coverage.withSimilarity} />
              <CoverageBar label="Co-purchase" value={coverage.coPurchaseCoverage} count={coverage.withCoPurchase} />
              <CoverageBar label="Popularity" value={coverage.popularityCoverage} count={coverage.withPopularity} />
            </dl>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Performance by type</CardTitle>
        </CardHeader>
        <CardContent>
          {byType.length === 0 ? (
            <p className="text-sm text-smoke">
              No recommendation events recorded yet. Impressions are reported by the rails on the
              storefront once a shopper scrolls one into view.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-smoke">
                    <th className="py-2 pr-4 font-medium">Type</th>
                    <th className="py-2 pr-4 text-right font-medium">Impressions</th>
                    <th className="py-2 pr-4 text-right font-medium">CTR</th>
                    <th className="py-2 pr-4 text-right font-medium">Conv.</th>
                    <th className="py-2 text-right font-medium">Rev / impr.</th>
                  </tr>
                </thead>
                <tbody>
                  {byType.map((row) => (
                    <tr key={row.recommendationType} className="border-b last:border-0">
                      <td className="py-2 pr-4">{typeLabel(row.recommendationType)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{compact(row.impressions)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{percent(row.ctr, 2)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{percent(row.conversionRate, 2)}</td>
                      <td className="py-2 text-right tabular-nums">{rupees(row.revenuePerImpressionPaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>CTR by position</CardTitle>
          </CardHeader>
          <CardContent>
            {positions.length === 0 ? (
              <p className="text-sm text-smoke">No position data yet.</p>
            ) : (
              <div className="space-y-1.5">
                {positions.slice(0, 12).map((row) => (
                  <div key={row.position} className="flex items-center gap-3 text-xs">
                    <span className="w-6 shrink-0 text-right tabular-nums text-smoke">{row.position}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
                      <div
                        className="h-full rounded bg-foreground/70"
                        // Scaled against the best position, so the shape of the
                        // drop-off is visible rather than the absolute numbers.
                        style={{
                          width: `${Math.min(100, (row.ctr / Math.max(...positions.map((p) => p.ctr), 1e-9)) * 100)}%`,
                        }}
                      />
                    </div>
                    <span className="w-14 shrink-0 text-right tabular-nums">{percent(row.ctr, 2)}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-3 text-xs text-smoke">
              A steep drop-off is normal. A flat line usually means the ranking is not ordering by
              relevance.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Most recommended products</CardTitle>
          </CardHeader>
          <CardContent>
            {topProducts.length === 0 ? (
              <p className="text-sm text-smoke">Nothing recommended yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {topProducts.slice(0, 10).map((product) => (
                  <li key={product.productId} className="flex items-baseline justify-between gap-3">
                    <span className="truncate">{product.name}</span>
                    <span className="shrink-0 tabular-nums text-xs text-smoke">
                      {compact(product.impressions)} impr · {percent(product.ctr, 1)} CTR
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {degradedRequests.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Recent degraded requests</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-smoke">
              Requests that could not use the strategy their type calls for. Use{" "}
              <code className="rounded bg-muted px-1">/admin/recommendations?view=trace</code> style
              debugging on the API to see why.
            </p>
            <ul className="mt-4 space-y-2 text-sm">
              {degradedRequests.map((request) => (
                <li key={request.recommendationId} className="flex flex-wrap items-baseline gap-2">
                  <Badge variant="soft">{typeLabel(request.recommendationType)}</Badge>
                  <span className="text-xs text-smoke">
                    {request.candidateCount} candidates → {request.resultCount} results
                    {request.fallbackReason ? ` · ${request.fallbackReason}` : ""}
                  </span>
                  <span className="ml-auto text-xs tabular-nums text-smoke">
                    {new Date(request.createdAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {configs.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Ranking configurations</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-smoke">
              One active weight set per type. Activating a previous version is the rollback — no
              deploy required.
            </p>
            <ul className="mt-4 space-y-2 text-sm">
              {configs.map((config) => (
                <li key={`${config.recommendationType}:${config.version}`} className="flex flex-wrap items-center gap-2">
                  <Badge variant={config.isActive ? "default" : "outline"}>
                    {typeLabel(config.recommendationType)}
                  </Badge>
                  <span className="font-mono text-xs">{config.version}</span>
                  <span className="text-xs text-smoke">{config.label}</span>
                  {config.isActive ? <Badge variant="soft">active</Badge> : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {flags ? (
        <Card>
          <CardHeader>
            <CardTitle>Feature flags</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-smoke">
              Every flag defaults to the safe state. Turning one off takes effect on the next
              request, which is how a misbehaving strategy is disabled without a rollback.
            </p>
            <ul className="mt-4 flex flex-wrap gap-2">
              {Object.entries(flags).map(([name, enabled]) => (
                <li key={name}>
                  <Badge variant={enabled ? "default" : "outline"}>
                    {name.replace(/([A-Z])/g, " $1").trim()} · {enabled ? "on" : "off"}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function CoverageBar({ label, value, count }: { label: string; value: number; count: number }) {
  const pct = Math.round(value * 100);
  const tone = pct >= 80 ? "bg-emerald-500" : pct >= 50 ? "bg-amber-500" : "bg-red-500";
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span>{label}</span>
        <span className="tabular-nums text-smoke">{pct}%</span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded bg-muted">
        <div className={`h-full rounded ${tone}`} style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <p className="mt-1 text-xs text-smoke">{compact(count)} products</p>
    </div>
  );
}
