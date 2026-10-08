import "server-only";

import { and, desc, eq, gte, sql } from "drizzle-orm";

import { db } from "@/db";
import { recommendationEvents, recommendationMetrics, recommendationRequests } from "@/db/schema";
import type { DbClient } from "@/db/utils";
import { logger } from "@/lib/logger";
import { recommendationBusinessMetrics } from "@/lib/recommendations/evaluate";
import type { RecommendationType } from "@/lib/recommendations/types";
import { DEFAULT_SETTINGS } from "./config.service";

/**
 * Recommendation metrics and attribution.
 *
 * Attribution is deliberately conservative. §40 is explicit: do not claim a
 * recommendation caused a purchase when the shopper bought it independently.
 * So a purchase counts toward a recommendation only when there is a recorded
 * impression of that product to that subject inside the attribution window —
 * exposure that actually happened, not exposure we assume.
 *
 * Everything else is arithmetic over `recommendation_events`, pre-aggregated
 * into `recommendation_metrics` by the offline job so a 30-day dashboard chart
 * does not scan an append-only event table.
 */

export interface AttributionInput {
  productId: string;
  userId?: string | null;
  sessionHash?: string | null;
  /** Purchase time; the window is measured backwards from here. */
  occurredAt?: Date;
  windowDays?: number;
}

export interface AttributionResult {
  attributed: boolean;
  requestId: string | null;
  recommendationId: string | null;
  recommendationType: RecommendationType | null;
  position: number | null;
  algorithmVersion: string | null;
  /** Hours between impression and action. */
  hoursToAction: number | null;
}

/**
 * Find the impression a purchase should be attributed to.
 *
 * Requires all three of: the same product, the same subject, and an impression
 * inside the window. When several qualify, the most recent wins — the last
 * thing a shopper saw is the most plausible cause, and crediting an older
 * impression would overstate how long a recommendation stays effective.
 */
export async function findAttribution(
  input: AttributionInput,
  client: DbClient = db,
): Promise<AttributionResult> {
  const none: AttributionResult = {
    attributed: false,
    requestId: null,
    recommendationId: null,
    recommendationType: null,
    position: null,
    algorithmVersion: null,
    hoursToAction: null,
  };
  if (!input.userId && !input.sessionHash) return none;

  const occurredAt = input.occurredAt ?? new Date();
  const windowDays = input.windowDays ?? DEFAULT_SETTINGS.attributionWindowDays;
  const windowStart = new Date(occurredAt.getTime() - windowDays * 86_400_000);

  const subjectFilter = input.userId
    ? eq(recommendationEvents.userId, input.userId)
    : eq(recommendationEvents.sessionHash, input.sessionHash!);

  try {
    const rows = await client
      .select({
        attributedRequestId: recommendationEvents.attributedRequestId,
        recommendationId: recommendationEvents.recommendationId,
        recommendationType: recommendationEvents.recommendationType,
        position: recommendationEvents.position,
        algorithmVersion: recommendationEvents.algorithmVersion,
        createdAt: recommendationEvents.createdAt,
      })
      .from(recommendationEvents)
      .where(
        and(
          eq(recommendationEvents.eventType, "SHOWN"),
          eq(recommendationEvents.productId, input.productId),
          subjectFilter,
          gte(recommendationEvents.createdAt, windowStart),
        ),
      )
      .orderBy(desc(recommendationEvents.createdAt))
      .limit(1);

    const impression = rows[0];
    if (!impression) return none;

    return {
      attributed: true,
      requestId: impression.attributedRequestId,
      recommendationId: impression.recommendationId,
      recommendationType: impression.recommendationType,
      position: impression.position,
      algorithmVersion: impression.algorithmVersion,
      hoursToAction: Number(
        ((occurredAt.getTime() - new Date(impression.createdAt).getTime()) / 3_600_000).toFixed(2),
      ),
    };
  } catch (error) {
    logger.warn("failed to resolve recommendation attribution", {
      error: error instanceof Error ? error.message : String(error),
    });
    return none;
  }
}

/* ── Dashboard aggregates ─────────────────────────────────────────────── */

export interface RecommendationOverview {
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
  /** Share of requests that returned nothing at all. */
  zeroResultRate: number;
}

/**
 * Headline numbers across the window.
 *
 * Fallback rate and zero-result rate are reported alongside CTR on purpose.
 * A rail can show a healthy CTR while quietly serving the global-popularity
 * fallback for half its requests, and the CTR alone would look fine.
 */
export async function recommendationOverview(
  options: { windowDays?: number } = {},
  client: DbClient = db,
): Promise<RecommendationOverview> {
  const windowDays = Math.min(Math.max(options.windowDays ?? 30, 1), 365);
  const since = new Date(Date.now() - windowDays * 86_400_000);

  const eventsResult = await client.execute<{
    impressions: number;
    clicks: number;
    add_to_carts: number;
    purchases: number;
    revenue_paise: number;
  }>(sql`
    select
      count(*) filter (where event_type = 'SHOWN')::int as impressions,
      count(*) filter (where event_type = 'CLICKED')::int as clicks,
      count(*) filter (where event_type = 'ADDED_TO_CART')::int as add_to_carts,
      count(*) filter (where event_type = 'PURCHASED')::int as purchases,
      coalesce(sum(revenue_paise) filter (where event_type = 'PURCHASED'), 0)::bigint as revenue_paise
      from recommendation_events
     where created_at >= ${since}
  `);

  const requestsResult = await client.execute<{
    requests: number;
    fallbacks: number;
    zero_results: number;
    avg_latency: number | null;
  }>(sql`
    select count(*)::int as requests,
           count(*) filter (where fallback_used)::int as fallbacks,
           count(*) filter (where result_count = 0)::int as zero_results,
           avg(took_ms)::real as avg_latency
      from recommendation_requests
     where created_at >= ${since}
  `);

  const events = eventsResult.rows[0];
  const requests = requestsResult.rows[0];

  const counts = {
    impressions: events?.impressions ?? 0,
    clicks: events?.clicks ?? 0,
    addToCarts: events?.add_to_carts ?? 0,
    purchases: events?.purchases ?? 0,
    revenuePaise: Number(events?.revenue_paise ?? 0),
  };
  const business = recommendationBusinessMetrics(counts);
  const totalRequests = requests?.requests ?? 0;

  return {
    windowDays,
    ...counts,
    ...business,
    requests: totalRequests,
    fallbackRate: totalRequests > 0 ? Number(((requests?.fallbacks ?? 0) / totalRequests).toFixed(4)) : 0,
    zeroResultRate: totalRequests > 0 ? Number(((requests?.zero_results ?? 0) / totalRequests).toFixed(4)) : 0,
    averageLatencyMs: Math.round(requests?.avg_latency ?? 0),
  };
}

export interface TypePerformance {
  recommendationType: RecommendationType;
  impressions: number;
  clicks: number;
  purchases: number;
  revenuePaise: number;
  ctr: number;
  conversionRate: number;
  revenuePerImpressionPaise: number;
}

/** Per-type performance, best CTR first. */
export async function performanceByType(
  options: { windowDays?: number; limit?: number } = {},
  client: DbClient = db,
): Promise<TypePerformance[]> {
  const windowDays = Math.min(Math.max(options.windowDays ?? 30, 1), 365);
  const limit = Math.min(options.limit ?? 20, 50);
  const since = new Date(Date.now() - windowDays * 86_400_000);

  const rows = await client.execute<{
    recommendation_type: RecommendationType;
    impressions: number;
    clicks: number;
    add_to_carts: number;
    purchases: number;
    revenue_paise: number;
  }>(sql`
    select recommendation_type,
           count(*) filter (where event_type = 'SHOWN')::int as impressions,
           count(*) filter (where event_type = 'CLICKED')::int as clicks,
           count(*) filter (where event_type = 'ADDED_TO_CART')::int as add_to_carts,
           count(*) filter (where event_type = 'PURCHASED')::int as purchases,
           coalesce(sum(revenue_paise) filter (where event_type = 'PURCHASED'), 0)::bigint as revenue_paise
      from recommendation_events
     where created_at >= ${since}
     group by recommendation_type
     order by count(*) filter (where event_type = 'SHOWN') desc
     limit ${limit}
  `);

  return rows.rows.map((row) => {
    const business = recommendationBusinessMetrics({
      impressions: row.impressions,
      clicks: row.clicks,
      addToCarts: row.add_to_carts,
      purchases: row.purchases,
      revenuePaise: Number(row.revenue_paise),
    });
    return {
      recommendationType: row.recommendation_type,
      impressions: row.impressions,
      clicks: row.clicks,
      purchases: row.purchases,
      revenuePaise: Number(row.revenue_paise),
      ctr: business.ctr,
      conversionRate: business.conversionRate,
      revenuePerImpressionPaise: business.revenuePerImpressionPaise,
    };
  });
}

/**
 * CTR by position.
 *
 * The diagnostic behind "is the rail working or is position 1 doing all the
 * work?". A steep drop-off is normal; a flat line usually means the ranking is
 * not actually ordering by relevance.
 */
export async function ctrByPosition(
  options: { windowDays?: number; maxPosition?: number } = {},
  client: DbClient = db,
): Promise<Array<{ position: number; impressions: number; clicks: number; ctr: number }>> {
  const windowDays = Math.min(Math.max(options.windowDays ?? 30, 1), 365);
  const maxPosition = Math.min(options.maxPosition ?? 20, 60);
  const since = new Date(Date.now() - windowDays * 86_400_000);

  const rows = await client.execute<{ position: number; impressions: number; clicks: number }>(sql`
    with shown as (
      select attributed_request_id, product_id, position
        from recommendation_events
       where event_type = 'SHOWN'
         and position is not null
         and position <= ${maxPosition}
         and created_at >= ${since}
    ),
    clicked as (
      select attributed_request_id, product_id
        from recommendation_events
       where event_type = 'CLICKED'
         and created_at >= ${since}
    )
    select s.position::int as position,
           count(*)::int as impressions,
           count(c.product_id)::int as clicks
      from shown s
      left join clicked c
        on c.attributed_request_id = s.attributed_request_id
       and c.product_id = s.product_id
     group by s.position
     order by s.position
  `);

  return rows.rows.map((row) => ({
    position: row.position,
    impressions: row.impressions,
    clicks: row.clicks,
    ctr: row.impressions > 0 ? Number((row.clicks / row.impressions).toFixed(6)) : 0,
  }));
}

/** Products recommended most often, with how they performed. */
export async function topRecommendedProducts(
  options: { windowDays?: number; limit?: number } = {},
  client: DbClient = db,
): Promise<
  Array<{
    productId: string;
    name: string;
    slug: string;
    impressions: number;
    clicks: number;
    purchases: number;
    ctr: number;
  }>
> {
  const windowDays = Math.min(Math.max(options.windowDays ?? 30, 1), 365);
  const limit = Math.min(options.limit ?? 20, 100);
  const since = new Date(Date.now() - windowDays * 86_400_000);

  const rows = await client.execute<{
    product_id: string;
    name: string;
    slug: string;
    impressions: number;
    clicks: number;
    purchases: number;
  }>(sql`
    select re.product_id,
           coalesce(psi.name, '(removed)') as name,
           coalesce(psi.slug, '') as slug,
           count(*) filter (where re.event_type = 'SHOWN')::int as impressions,
           count(*) filter (where re.event_type = 'CLICKED')::int as clicks,
           count(*) filter (where re.event_type = 'PURCHASED')::int as purchases
      from recommendation_events re
      left join product_search_index psi on psi.product_id = re.product_id
     where re.created_at >= ${since}
       and re.product_id is not null
     group by re.product_id, psi.name, psi.slug
     order by count(*) filter (where re.event_type = 'SHOWN') desc
     limit ${limit}
  `);

  return rows.rows.map((row) => ({
    productId: row.product_id,
    name: row.name,
    slug: row.slug,
    impressions: row.impressions,
    clicks: row.clicks,
    purchases: row.purchases,
    ctr: row.impressions > 0 ? Number((row.clicks / row.impressions).toFixed(6)) : 0,
  }));
}

/* ── Rollups ──────────────────────────────────────────────────────────── */

/**
 * Roll a day's events into `recommendation_metrics`.
 *
 * Idempotent: the upsert target is (date, type, algorithm version), so running
 * it twice for the same day produces the same row rather than doubling the
 * counts. That is what makes the job safely retryable.
 *
 * `clicks <= impressions` is a CHECK on the table, so the counts are clamped —
 * a click recorded for an impression that was pruned would otherwise make the
 * insert fail and take the whole rollup with it.
 */
export async function rollUpMetrics(
  options: { date?: Date; client?: DbClient } = {},
  client: DbClient = options.client ?? db,
): Promise<number> {
  const day = options.date ?? new Date();
  const dayStart = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const bucket = dayStart.toISOString().slice(0, 10);

  const rows = await client.execute<{
    recommendation_type: RecommendationType;
    algorithm_version: string;
    impressions: number;
    clicks: number;
    add_to_carts: number;
    purchases: number;
    revenue_paise: number;
  }>(sql`
    select recommendation_type,
           coalesce(algorithm_version, '') as algorithm_version,
           count(*) filter (where event_type = 'SHOWN')::int as impressions,
           count(*) filter (where event_type = 'CLICKED')::int as clicks,
           count(*) filter (where event_type = 'ADDED_TO_CART')::int as add_to_carts,
           count(*) filter (where event_type = 'PURCHASED')::int as purchases,
           coalesce(sum(revenue_paise) filter (where event_type = 'PURCHASED'), 0)::bigint as revenue_paise
      from recommendation_events
     where created_at >= ${dayStart} and created_at < ${dayEnd}
     group by recommendation_type, coalesce(algorithm_version, '')
  `);

  let written = 0;
  for (const row of rows.rows) {
    const impressions = row.impressions;
    // Clamped so the table's CHECK cannot fail the whole batch.
    const clicks = Math.min(row.clicks, impressions);
    const ctr = impressions > 0 ? clicks / impressions : 0;
    try {
      await client
        .insert(recommendationMetrics)
        .values({
          bucketDate: bucket,
          recommendationType: row.recommendation_type,
          algorithmVersion: row.algorithm_version,
          impressions,
          clicks,
          addToCarts: row.add_to_carts,
          purchases: row.purchases,
          revenuePaise: Number(row.revenue_paise),
          ctr: Number(ctr.toFixed(6)),
          computedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            recommendationMetrics.bucketDate,
            recommendationMetrics.recommendationType,
            recommendationMetrics.algorithmVersion,
          ],
          set: {
            impressions,
            clicks,
            addToCarts: row.add_to_carts,
            purchases: row.purchases,
            revenuePaise: Number(row.revenue_paise),
            ctr: Number(ctr.toFixed(6)),
            computedAt: new Date(),
          },
        });
      written += 1;
    } catch (error) {
      logger.warn("failed to roll up recommendation metrics", {
        bucket,
        type: row.recommendation_type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return written;
}

/** Time series for the dashboard chart, from the rollup table. */
export async function metricsTimeSeries(
  options: { type?: RecommendationType; days?: number } = {},
  client: DbClient = db,
): Promise<
  Array<{
    date: string;
    recommendationType: RecommendationType;
    impressions: number;
    clicks: number;
    purchases: number;
    revenuePaise: number;
    ctr: number;
  }>
> {
  const days = Math.min(Math.max(options.days ?? 30, 1), 365);
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const filters = options.type
    ? and(gte(recommendationMetrics.bucketDate, since), eq(recommendationMetrics.recommendationType, options.type))
    : gte(recommendationMetrics.bucketDate, since);

  const rows = await client
    .select({
      date: recommendationMetrics.bucketDate,
      recommendationType: recommendationMetrics.recommendationType,
      impressions: recommendationMetrics.impressions,
      clicks: recommendationMetrics.clicks,
      purchases: recommendationMetrics.purchases,
      revenuePaise: recommendationMetrics.revenuePaise,
      ctr: recommendationMetrics.ctr,
    })
    .from(recommendationMetrics)
    .where(filters)
    .orderBy(recommendationMetrics.bucketDate);

  return rows.map((row) => ({
    date: row.date,
    recommendationType: row.recommendationType,
    impressions: row.impressions,
    clicks: row.clicks,
    purchases: row.purchases,
    revenuePaise: row.revenuePaise,
    ctr: row.ctr,
  }));
}

/**
 * Products a subject has been shown too often without acting.
 *
 * Used as a soft penalty, never a hard exclusion. §46 is explicit that one
 * abandoned view must not suppress a product forever — but a product shown
 * twelve times and never clicked is worth fading, because continuing to show
 * it wastes a slot and trains the shopper to ignore the rail.
 */
export async function overExposedProductIds(
  subject: { userId?: string | null; sessionHash?: string | null },
  options: { threshold?: number; windowDays?: number } = {},
  client: DbClient = db,
): Promise<Set<string>> {
  if (!subject.userId && !subject.sessionHash) return new Set();
  const threshold = options.threshold ?? DEFAULT_SETTINGS.overExposureImpressions;
  const windowDays = options.windowDays ?? 30;
  const since = new Date(Date.now() - windowDays * 86_400_000);

  const subjectFilter = subject.userId
    ? eq(recommendationEvents.userId, subject.userId)
    : eq(recommendationEvents.sessionHash, subject.sessionHash!);

  const rows = await client
    .select({
      productId: recommendationEvents.productId,
      shown: sql<number>`count(*)::int`,
    })
    .from(recommendationEvents)
    .where(
      and(
        eq(recommendationEvents.eventType, "SHOWN"),
        subjectFilter,
        gte(recommendationEvents.createdAt, since),
      ),
    )
    .groupBy(recommendationEvents.productId)
    .having(sql`count(*) >= ${threshold}`);

  return new Set(
    rows
      .filter((row): row is { productId: string; shown: number } => Boolean(row.productId))
      .map((row) => row.productId),
  );
}

/** Prune recommendation events beyond the retention window. */
export async function pruneRecommendationEvents(
  options: { olderThan: Date; batchSize?: number },
  client: DbClient = db,
): Promise<number> {
  const batchSize = Math.min(options.batchSize ?? 20_000, 200_000);
  try {
    const result = await client.execute(sql`
      delete from recommendation_events
       where id in (
         select id from recommendation_events
          where created_at < ${options.olderThan}
          limit ${batchSize}
       )
    `);
    const count = Number((result as unknown as { rowCount?: number }).rowCount ?? 0);
    return Number.isFinite(count) ? count : 0;
  } catch (error) {
    logger.warn("failed to prune recommendation events", {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/** Prune request rows beyond retention, after their events are gone. */
export async function pruneRecommendationRequests(
  options: { olderThan: Date; batchSize?: number },
  client: DbClient = db,
): Promise<number> {
  const batchSize = Math.min(options.batchSize ?? 20_000, 200_000);
  try {
    const result = await client.execute(sql`
      delete from recommendation_requests
       where id in (
         select id from recommendation_requests
          where created_at < ${options.olderThan}
          limit ${batchSize}
       )
    `);
    const count = Number((result as unknown as { rowCount?: number }).rowCount ?? 0);
    return Number.isFinite(count) ? count : 0;
  } catch (error) {
    logger.warn("failed to prune recommendation requests", {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}
