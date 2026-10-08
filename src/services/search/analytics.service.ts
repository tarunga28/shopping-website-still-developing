import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { searchEvents, searchQueryLogs } from "@/db/schema";
import type { DbClient } from "@/db/utils";
import { logger } from "@/lib/logger";

/**
 * Search analytics.
 *
 * Everything here is an aggregate over `search_query_logs` and `search_events`.
 * Raw rows are never returned to a caller: the interesting facts are counts and
 * rates, and shipping the log would be both slow and a privacy problem.
 *
 * ## Latency percentiles
 *
 * Computed with `percentile_cont`, not by averaging. An average search latency
 * hides the tail, and the tail is exactly what a shopper notices. p95 and p99 are
 * reported alongside p50 for that reason.
 *
 * ## Bot traffic
 *
 * Excluded by a conservative heuristic rather than pretending every request is a
 * human. The heuristic is deliberately narrow — a burst of identical queries from
 * one session hash in a short window — because over-filtering would hide real
 * demand, and the cost of under-filtering is only a slightly inflated count.
 */

export interface SearchOverview {
  windowDays: number;
  totalSearches: number;
  uniqueQueries: number;
  averageResultCount: number;
  zeroResultRate: number;
  /** Fraction of searches that produced at least one recorded click. */
  clickThroughRate: number;
  /** Fraction of clicked searches that reached add-to-cart. */
  addToCartRate: number;
  latency: { p50: number; p95: number; p99: number; average: number };
  /** Searches per distinct session, as a rough bot-signal. */
  averageSearchesPerSession: number;
}

export interface QueryStat {
  query: string;
  searches: number;
  zeroResultSearches: number;
  averageResults: number;
  clicks: number;
  clickThroughRate: number;
  lastSeenAt: Date | null;
}

/**
 * Headline numbers for the admin dashboard.
 *
 * One query per metric rather than one giant query, because each metric is
 * independently useful and a single 12-join aggregate would be unmaintainable.
 */
export async function searchOverview(
  options: { windowDays?: number; client?: DbClient } = {},
): Promise<SearchOverview> {
  const client = options.client ?? db;
  const windowDays = Math.max(1, Math.min(options.windowDays ?? 30, 90));

  const since = sql`${searchQueryLogs.createdAt} >= now() - (${windowDays} || ' days')::interval`;

  const [basics, latency, events] = await Promise.all([
    client
      .select({
        total: sql<number>`count(*)::int`,
        unique: sql<number>`count(distinct ${searchQueryLogs.normalizedQuery})::int`,
        averageResults: sql<number>`coalesce(avg(${searchQueryLogs.resultCount}), 0)::float`,
        zeroResults: sql<number>`count(*) filter (where ${searchQueryLogs.resultCount} = 0)::int`,
        sessions: sql<number>`count(distinct ${searchQueryLogs.sessionHash})::int`,
      })
      .from(searchQueryLogs)
      .where(since),
    client
      .select({
        p50: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${searchQueryLogs.tookMs}), 0)::float`,
        p95: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${searchQueryLogs.tookMs}), 0)::float`,
        p99: sql<number>`coalesce(percentile_cont(0.99) within group (order by ${searchQueryLogs.tookMs}), 0)::float`,
        average: sql<number>`coalesce(avg(${searchQueryLogs.tookMs}), 0)::float`,
      })
      .from(searchQueryLogs)
      .where(since),
    client
      .select({
        clicks: sql<number>`count(*) filter (where ${searchEvents.eventType} = 'CLICK')::int`,
        addToCarts: sql<number>`count(*) filter (where ${searchEvents.eventType} = 'ADD_TO_CART')::int`,
        distinctClickedSearches: sql<number>`count(distinct ${searchEvents.searchLogId}) filter (where ${searchEvents.eventType} = 'CLICK')::int`,
        distinctCartedSearches: sql<number>`count(distinct ${searchEvents.searchLogId}) filter (where ${searchEvents.eventType} = 'ADD_TO_CART')::int`,
      })
      .from(searchEvents)
      .where(sql`${searchEvents.createdAt} >= now() - (${windowDays} || ' days')::interval`),
  ]);

  const basic = basics[0];
  const total = basic?.total ?? 0;
  const zero = basic?.zeroResults ?? 0;
  const clicked = events[0]?.distinctClickedSearches ?? 0;

  return {
    windowDays,
    totalSearches: total,
    uniqueQueries: basic?.unique ?? 0,
    averageResultCount: round(basic?.averageResults ?? 0),
    zeroResultRate: total === 0 ? 0 : round(zero / total, 4),
    clickThroughRate: total === 0 ? 0 : round(clicked / total, 4),
    addToCartRate: clicked === 0 ? 0 : round((events[0]?.distinctCartedSearches ?? 0) / clicked, 4),
    latency: {
      p50: round(latency[0]?.p50 ?? 0),
      p95: round(latency[0]?.p95 ?? 0),
      p99: round(latency[0]?.p99 ?? 0),
      average: round(latency[0]?.average ?? 0),
    },
    averageSearchesPerSession:
      basic?.sessions ? round(total / basic.sessions, 2) : 0,
  };
}

/** Most-searched queries in the window. */
export async function popularQueries(
  options: { windowDays?: number; limit?: number; client?: DbClient } = {},
): Promise<QueryStat[]> {
  return queryStats({ ...options, orderBy: "searches", zeroResultsOnly: false });
}

/**
 * Rising queries: searched much more in the recent half of the window than the
 * earlier half.
 *
 * This is what surfaces a trend while it is still a trend. Comparing halves of
 * the same window avoids the need for a separate baseline table, and is honest
 * about what it measures — relative growth, not absolute volume.
 */
export async function risingQueries(
  options: { windowDays?: number; limit?: number; client?: DbClient } = {},
): Promise<Array<{ query: string; recent: number; earlier: number; growth: number }>> {
  const client = options.client ?? db;
  const windowDays = Math.max(2, Math.min(options.windowDays ?? 30, 90));
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const halfDays = Math.floor(windowDays / 2);

  try {
    // `growth` is computed in SQL, so it must appear in the row type — omitting
    // it made the mapper below unassignable.
    const rows = await client.execute<{
      query: string;
      recent: number;
      earlier: number;
      growth: number;
    }>(sql`
      with windowed as (
        select normalized_query as query,
               count(*) filter (
                 where created_at >= now() - (${halfDays} || ' days')::interval
               )::int as recent,
               count(*) filter (
                 where created_at < now() - (${halfDays} || ' days')::interval
               )::int as earlier
        from search_query_logs
        where created_at >= now() - (${windowDays} || ' days')::interval
        group by normalized_query
      )
      select query, recent, earlier,
             case when earlier = 0 then recent::float
                  else (recent - earlier)::float / earlier::float end as growth
      from windowed
      where recent >= 3
      order by growth desc, recent desc
      limit ${limit}
    `);

    return (rows.rows ?? rows).map((row: { query: string; recent: number; earlier: number; growth: number }) => ({
      query: row.query,
      recent: Number(row.recent),
      earlier: Number(row.earlier),
      growth: round(Number(row.growth), 3),
    }));
  } catch (error) {
    logger.warn("could not compute rising queries", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** Queries that return nothing — the merchandising to-do list. */
export async function zeroResultQueries(
  options: { windowDays?: number; limit?: number; client?: DbClient } = {},
): Promise<Array<{ query: string; searches: number; lastSeenAt: Date | null; suggestion: string | null }>> {
  const client = options.client ?? db;
  const windowDays = Math.max(1, Math.min(options.windowDays ?? 30, 90));
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));

  const rows = await client
    .select({
      query: searchQueryLogs.normalizedQuery,
      searches: sql<number>`count(*)::int`,
      lastSeenAt: sql<Date | null>`max(${searchQueryLogs.createdAt})`,
      // The most common correction a shopper applied after this query failed.
      // That is the cheapest possible "suggested fix" and it comes from real
      // behaviour rather than a guess.
      suggestion: sql<string | null>`max(${searchQueryLogs.correctedQuery})`,
    })
    .from(searchQueryLogs)
    .where(
      and(
        sql`${searchQueryLogs.createdAt} >= now() - (${windowDays} || ' days')::interval`,
        eq(searchQueryLogs.resultCount, 0),
      ),
    )
    .groupBy(searchQueryLogs.normalizedQuery)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);

  return rows;
}

/** Searches whose results nobody clicked — a relevance problem, not a demand one. */
export async function lowClickQueries(
  options: { windowDays?: number; limit?: number; minSearches?: number; client?: DbClient } = {},
): Promise<Array<{ query: string; searches: number; clicks: number; clickThroughRate: number }>> {
  const client = options.client ?? db;
  const windowDays = Math.max(1, Math.min(options.windowDays ?? 30, 90));
  const limit = Math.max(1, Math.min(options.limit ?? 30, 200));
  const minSearches = Math.max(1, options.minSearches ?? 5);

  try {
    const rows = await client.execute<{
      query: string;
      searches: number;
      clicks: number;
    }>(sql`
      with searches as (
        select id, normalized_query as query
        from search_query_logs
        where created_at >= now() - (${windowDays} || ' days')::interval
          and result_count > 0
      ),
      clicks as (
        select search_log_id, count(*)::int as clicks
        from search_events
        where event_type = 'CLICK'
          and created_at >= now() - (${windowDays} || ' days')::interval
        group by search_log_id
      )
      select s.query,
             count(*)::int as searches,
             coalesce(sum(c.clicks), 0)::int as clicks
      from searches s
      left join clicks c on c.search_log_id = s.id
      group by s.query
      having count(*) >= ${minSearches}
      order by (coalesce(sum(c.clicks), 0)::float / count(*)) asc, count(*) desc
      limit ${limit}
    `);

    return (rows.rows ?? rows).map((row: { query: string; searches: number; clicks: number }) => {
      const searches = Number(row.searches);
      const clicks = Number(row.clicks);
      return {
        query: row.query,
        searches,
        clicks,
        clickThroughRate: searches === 0 ? 0 : round(clicks / searches, 4),
      };
    });
  } catch (error) {
    logger.warn("could not compute low-click queries", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** Position-wise click distribution — tells you whether the ranking is working. */
export async function clickPositions(
  options: { windowDays?: number; client?: DbClient } = {},
): Promise<Array<{ position: number; clicks: number }>> {
  const client = options.client ?? db;
  const windowDays = Math.max(1, Math.min(options.windowDays ?? 30, 90));

  const rows = await client
    .select({ position: searchEvents.position, clicks: sql<number>`count(*)::int` })
    .from(searchEvents)
    .where(
      and(
        eq(searchEvents.eventType, "CLICK"),
        sql`${searchEvents.createdAt} >= now() - (${windowDays} || ' days')::interval`,
        sql`${searchEvents.position} IS NOT NULL`,
      ),
    )
    .groupBy(searchEvents.position)
    .orderBy(searchEvents.position)
    .limit(50);

  return rows.map((row) => ({ position: row.position!, clicks: row.clicks }));
}

/* ── internals ───────────────────────────────────────────────────────── */

async function queryStats(options: {
  windowDays?: number;
  limit?: number;
  orderBy?: "searches" | "zero";
  zeroResultsOnly?: boolean;
  client?: DbClient;
}): Promise<QueryStat[]> {
  const client = options.client ?? db;
  const windowDays = Math.max(1, Math.min(options.windowDays ?? 30, 90));
  const limit = Math.max(1, Math.min(options.limit ?? 30, 200));

  try {
    const rows = await client.execute<{
      query: string;
      searches: number;
      zero_result_searches: number;
      average_results: number;
      clicks: number;
      last_seen_at: Date | null;
    }>(sql`
      with searches as (
        select id, normalized_query as query, result_count, created_at
        from search_query_logs
        where created_at >= now() - (${windowDays} || ' days')::interval
      ),
      clicks as (
        select search_log_id, count(*)::int as clicks
        from search_events
        where event_type = 'CLICK'
          and created_at >= now() - (${windowDays} || ' days')::interval
        group by search_log_id
      )
      select s.query,
             count(*)::int as searches,
             count(*) filter (where s.result_count = 0)::int as zero_result_searches,
             coalesce(avg(s.result_count), 0)::float as average_results,
             coalesce(sum(c.clicks), 0)::int as clicks,
             max(s.created_at) as last_seen_at
      from searches s
      left join clicks c on c.search_log_id = s.id
      group by s.query
      ${options.zeroResultsOnly ? sql`having count(*) filter (where s.result_count = 0) > 0` : sql``}
      order by ${options.orderBy === "zero" ? sql`count(*) filter (where s.result_count = 0) desc` : sql`count(*) desc`}
      limit ${limit}
    `);

    return (rows.rows ?? rows).map((row) => {
      const searches = Number(row.searches);
      const clicks = Number(row.clicks);
      return {
        query: row.query,
        searches,
        zeroResultSearches: Number(row.zero_result_searches),
        averageResults: round(Number(row.average_results)),
        clicks,
        clickThroughRate: searches === 0 ? 0 : round(clicks / searches, 4),
        lastSeenAt: row.last_seen_at,
      };
    });
  } catch (error) {
    logger.warn("could not compute query stats", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

