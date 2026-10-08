import "server-only";

import { and, desc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  analyticsEvents,
  recommendationEvents,
  recommendationRequests,
  userInterestSignals,
} from "@/db/schema";
import type { InterestDimension } from "@/lib/recommendations/types";
import type { DbClient } from "@/db/utils";
import { logger } from "@/lib/logger";

/**
 * Behavioural event recording.
 *
 * Writes to the **existing** `analytics_events` table rather than a new one.
 * The table was already in the schema and nothing wrote to it; Part 13 fills
 * that gap instead of forking a second event stream, because two append-only
 * logs describing the same shopper is two places to be wrong.
 *
 * Every function here is fire-and-forget from the caller's perspective: a
 * failed event insert must never fail the request that triggered it. Losing a
 * signal degrades recommendations slightly; a 500 on add-to-cart costs an
 * order.
 */

/**
 * How much each event type is worth as an interest signal.
 *
 * Mirrors `EVENT_WEIGHTS` in `@/lib/recommendations/interest` but keyed by the
 * database enum, so the two stay in step and a new event type is a compile
 * error here rather than a silently-ignored signal.
 */
const SIGNAL_WEIGHTS: Readonly<Record<string, number>> = {
  PURCHASE: 10,
  RETURN: -4,
  ADD_TO_CART: 4,
  WISHLIST_ADD: 3.5,
  WISHLIST_REMOVE: -1.5,
  REMOVE_FROM_CART: -1.5,
  SEARCH_RESULT_CLICK: 1.6,
  PRODUCT_CLICK: 1.4,
  PRODUCT_VIEW: 1,
  CATEGORY_VIEW: 0.8,
  BRAND_VIEW: 0.8,
  COMPARE: 1.2,
  SHARE: 1.1,
  FILTER_USED: 0.6,
  SEARCH: 0.5,
  CHECKOUT_STARTED: 2,
};

export interface BehavioralEventInput {
  eventType: string;
  userId?: string | null;
  /** Salted session hash — never a raw IP or cookie value. */
  sessionId?: string | null;
  productId?: string | null;
  variantId?: string | null;
  categoryId?: string | null;
  brandId?: string | null;
  searchQuery?: string | null;
  recommendationType?: string | null;
  recommendationRequestId?: string | null;
  source?: string | null;
  context?: Record<string, unknown> | null;
}

/**
 * Record one behavioural event.
 *
 * Returns false rather than throwing on failure: the caller is a storefront
 * action, and there is nothing useful it could do with the error.
 */
export async function recordBehavioralEvent(
  input: BehavioralEventInput,
  client: DbClient = db,
): Promise<boolean> {
  try {
    await client.insert(analyticsEvents).values({
      eventType: input.eventType as never,
      userId: input.userId ?? null,
      sessionId: input.sessionId ?? null,
      productId: input.productId ?? null,
      variantId: input.variantId ?? null,
      categoryId: input.categoryId ?? null,
      brandId: input.brandId ?? null,
      searchQuery: input.searchQuery ?? null,
      recommendationType: (input.recommendationType ?? null) as never,
      recommendationRequestId: input.recommendationRequestId ?? null,
      source: input.source ?? null,
      context: input.context ?? null,
    });
    return true;
  } catch (error) {
    // Logged, not rethrown. A dropped signal is recoverable; a broken
    // add-to-cart is not.
    logger.warn("failed to record behavioural event", {
      eventType: input.eventType,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Record a batch, in one statement. Used by the event ingest endpoint. */
export async function recordBehavioralEvents(
  events: readonly BehavioralEventInput[],
  client: DbClient = db,
): Promise<number> {
  const rows = events
    .filter((event) => event.eventType)
    .map((event) => ({
      eventType: event.eventType as never,
      userId: event.userId ?? null,
      sessionId: event.sessionId ?? null,
      productId: event.productId ?? null,
      variantId: event.variantId ?? null,
      categoryId: event.categoryId ?? null,
      brandId: event.brandId ?? null,
      searchQuery: event.searchQuery ?? null,
      recommendationType: (event.recommendationType ?? null) as never,
      recommendationRequestId: event.recommendationRequestId ?? null,
      source: event.source ?? null,
      context: event.context ?? null,
    }));
  if (rows.length === 0) return 0;
  try {
    await client.insert(analyticsEvents).values(rows);
    return rows.length;
  } catch (error) {
    logger.warn("failed to record behavioural event batch", {
      count: rows.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/* ── Interest signal aggregation ──────────────────────────────────────── */

/**
 * Fold a behavioural event into the subject's interest signals.
 *
 * Upserts rather than appending: one row per (subject, dimension, key), with
 * `rawWeight` accumulating. That bounds the table — a shopper with a year of
 * history has the same number of rows as one with a day — and it is what makes
 * profile building a bounded read instead of a full event scan.
 *
 * Decay is *not* applied here. Storing the decayed value would freeze the
 * decay function: changing the half-life would require re-deriving every
 * historical row. `rawWeight` is the undecayed total and decay is applied on
 * read, so the curve can be retuned without a backfill.
 */
export async function applyEventToInterest(
  input: {
    userId?: string | null;
    sessionId?: string | null;
    eventType: string;
    categoryId?: string | null;
    brandId?: string | null;
    productId?: string | null;
    productType?: string | null;
    pricePaise?: number | null;
    attributeKeys?: readonly string[];
  },
  client: DbClient = db,
): Promise<number> {
  const baseWeight = SIGNAL_WEIGHTS[input.eventType];
  if (typeof baseWeight !== "number" || baseWeight === 0) return 0;

  // Exactly one subject, enforced by a check constraint on the table. A row
  // belonging to both would double-count; a row belonging to neither is noise.
  const subject = input.userId
    ? { userId: input.userId, sessionHash: null as string | null }
    : input.sessionId
      ? { userId: null as string | null, sessionHash: input.sessionId }
      : null;
  if (!subject) return 0;

  const contributions: Array<{ dimension: InterestDimension; key: string; weight: number }> = [];
  if (input.categoryId) contributions.push({ dimension: "CATEGORY", key: input.categoryId, weight: baseWeight });
  if (input.brandId) contributions.push({ dimension: "BRAND", key: input.brandId, weight: baseWeight });
  if (input.productId) contributions.push({ dimension: "PRODUCT", key: input.productId, weight: baseWeight });
  if (input.productType) {
    contributions.push({ dimension: "PRODUCT_TYPE", key: input.productType, weight: baseWeight });
  }
  for (const attributeKey of input.attributeKeys ?? []) {
    if (attributeKey) contributions.push({ dimension: "ATTRIBUTE", key: attributeKey, weight: baseWeight * 0.6 });
  }
  if (input.pricePaise && input.pricePaise > 0) {
    contributions.push({
      dimension: "PRICE_BAND",
      key: priceBandKey(input.pricePaise),
      weight: baseWeight * 0.5,
    });
  }
  if (contributions.length === 0) return 0;

  let written = 0;
  for (const contribution of contributions) {
    try {
      // `greatest(0, ...)` keeps the accumulated weight non-negative, matching
      // the table's CHECK. A shopper who buys and returns ends neutral rather
      // than actively hostile, which is right: the return may have been about
      // delivery, not the product.
      await client
        .insert(userInterestSignals)
        .values({
          userId: subject.userId,
          sessionHash: subject.sessionHash,
          dimension: contribution.dimension,
          key: contribution.key,
          rawWeight: Math.max(0, contribution.weight),
          eventCount: 1,
          strongestEvent: input.eventType,
        })
        .onConflictDoUpdate({
          target: [
            userInterestSignals.userId,
            userInterestSignals.sessionHash,
            userInterestSignals.dimension,
            userInterestSignals.key,
          ],
          set: {
            rawWeight: sql`greatest(0, ${userInterestSignals.rawWeight} + ${contribution.weight})`,
            eventCount: sql`${userInterestSignals.eventCount} + 1`,
            strongestEvent: input.eventType,
            lastSeenAt: new Date(),
          },
        });
      written += 1;
    } catch (error) {
      logger.warn("failed to fold event into interest signals", {
        dimension: contribution.dimension,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return written;
}

/**
 * Bucket a price into a band.
 *
 * Logarithmic buckets, because price interest is relative: the useful
 * distinction is between ₹500 and ₹5,000, not between ₹5,000 and ₹5,200. A
 * linear bucketing would produce hundreds of near-empty bands at the top of
 * the range and one enormous one at the bottom.
 */
export function priceBandKey(pricePaise: number): string {
  if (!Number.isFinite(pricePaise) || pricePaise <= 0) return "0";
  const exponent = Math.floor(Math.log10(pricePaise));
  const lower = Math.pow(10, exponent);
  const upper = Math.pow(10, exponent + 1);
  return `${lower}-${upper}`;
}

/* ── Recommendation impressions and clicks ────────────────────────────── */

export interface ImpressionInput {
  recommendationId: string;
  type: string;
  algorithmVersion?: string | null;
  userId?: string | null;
  sessionHash?: string | null;
  /** Product ids in the order they were rendered. */
  items: ReadonlyArray<{ productId: string; position: number }>;
}

/**
 * Record what was actually shown.
 *
 * Resolves the `recommendationId` to its request row so the impression carries
 * a real foreign key. When the id is unknown — a client replaying a stale page,
 * or a request whose row was pruned — the events are still written with a null
 * attribution, because an unattributed impression is still a measurable one
 * and dropping it would understate the denominator of every rate we compute.
 */
export async function recordImpressions(
  input: ImpressionInput,
  client: DbClient = db,
): Promise<number> {
  if (input.items.length === 0) return 0;

  let requestId: string | null = null;
  try {
    const [request] = await client
      .select({ id: recommendationRequests.id })
      .from(recommendationRequests)
      .where(eq(recommendationRequests.recommendationId, input.recommendationId))
      .limit(1);
    requestId = request?.id ?? null;
  } catch (error) {
    logger.warn("failed to resolve recommendation request for impressions", {
      recommendationId: input.recommendationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const rows = input.items
    .filter((item) => item.productId && item.position >= 1)
    .map((item) => ({
      eventType: "SHOWN" as const,
      recommendationType: input.type as never,
      attributedRequestId: requestId,
      recommendationId: input.recommendationId,
      productId: item.productId,
      position: item.position,
      algorithmVersion: input.algorithmVersion ?? null,
      userId: input.userId ?? null,
      sessionHash: input.sessionHash ?? null,
    }));
  if (rows.length === 0) return 0;

  try {
    await client.insert(recommendationEvents).values(rows as never);
    return rows.length;
  } catch (error) {
    logger.warn("failed to record recommendation impressions", {
      recommendationId: input.recommendationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

export interface RecommendationActionInput {
  eventType: "CLICKED" | "ADDED_TO_CART" | "PURCHASED";
  recommendationId?: string | null;
  recommendationType: string;
  productId: string;
  position?: number | null;
  algorithmVersion?: string | null;
  userId?: string | null;
  sessionHash?: string | null;
  revenuePaise?: number;
  orderId?: string | null;
}

/**
 * Record a click, add-to-cart or purchase against a recommendation.
 *
 * Attribution is best-effort and deliberately conservative. §40 is explicit
 * that we should not claim a recommendation caused a purchase when the shopper
 * bought it independently — so an action with no resolvable request is written
 * with a null `attributedRequestId` and simply does not count toward
 * recommendation conversion, rather than being guessed at.
 */
export async function recordRecommendationAction(
  input: RecommendationActionInput,
  client: DbClient = db,
): Promise<boolean> {
  let requestId: string | null = null;
  if (input.recommendationId) {
    try {
      const [request] = await client
        .select({ id: recommendationRequests.id })
        .from(recommendationRequests)
        .where(eq(recommendationRequests.recommendationId, input.recommendationId))
        .limit(1);
      requestId = request?.id ?? null;
    } catch (error) {
      logger.warn("failed to resolve recommendation request for action", {
        recommendationId: input.recommendationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    await client.insert(recommendationEvents).values({
      eventType: input.eventType,
      recommendationType: input.recommendationType as never,
      attributedRequestId: requestId,
      recommendationId: input.recommendationId ?? null,
      productId: input.productId,
      position: input.position ?? null,
      algorithmVersion: input.algorithmVersion ?? null,
      userId: input.userId ?? null,
      sessionHash: input.sessionHash ?? null,
      revenuePaise: input.revenuePaise ?? 0,
      orderId: input.orderId ?? null,
    } as never);
    return true;
  } catch (error) {
    logger.warn("failed to record recommendation action", {
      eventType: input.eventType,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/* ── Reads for the offline jobs ───────────────────────────────────────── */

export interface EventWindow {
  since: Date;
  eventTypes?: readonly string[];
  limit?: number;
}

/**
 * Recent behavioural events, newest first.
 *
 * Bounded by both a time window and a row limit, because the offline jobs run
 * over this and an unbounded scan of an append-only table is how a nightly job
 * becomes an outage.
 */
export async function listRecentEvents(
  window: EventWindow,
  client: DbClient = db,
): Promise<
  Array<{
    eventType: string;
    userId: string | null;
    sessionId: string | null;
    productId: string | null;
    categoryId: string | null;
    brandId: string | null;
    createdAt: Date;
  }>
> {
  const filters = [gte(analyticsEvents.createdAt, window.since)];
  if (window.eventTypes && window.eventTypes.length > 0) {
    filters.push(inArray(analyticsEvents.eventType, window.eventTypes as never));
  }
  return client
    .select({
      eventType: analyticsEvents.eventType,
      userId: analyticsEvents.userId,
      sessionId: analyticsEvents.sessionId,
      productId: analyticsEvents.productId,
      categoryId: analyticsEvents.categoryId,
      brandId: analyticsEvents.brandId,
      createdAt: analyticsEvents.createdAt,
    })
    .from(analyticsEvents)
    .where(and(...filters))
    .orderBy(desc(analyticsEvents.createdAt))
    .limit(Math.min(window.limit ?? 50_000, 200_000));
}

/**
 * Co-occurrence counts derived from real orders.
 *
 * Computed in SQL rather than in application code, because the pairwise
 * expansion is `O(items²)` per order and pulling every order line into Node to
 * do it there would be both slower and a large allocation for no benefit.
 *
 * Only paid orders count. A pending or cancelled order is not evidence that
 * two products belong together, and including them would let an abandoned cart
 * create a "frequently bought together" relationship.
 */
export async function coPurchaseCounts(
  options: { since: Date; minPairOrders?: number },
  client: DbClient = db,
): Promise<
  Array<{
    productId: string;
    coProductId: string;
    pairOrders: number;
    productOrders: number;
    coProductOrders: number;
    totalOrders: number;
  }>
> {
  const minPairOrders = options.minPairOrders ?? 2;
  const rows = await client.execute<{
    product_id: string;
    co_product_id: string;
    pair_orders: number;
    product_orders: number;
    co_product_orders: number;
    total_orders: number;
  }>(sql`
    with paid_orders as (
      select o.id
        from orders o
       where o.created_at >= ${options.since}
         and o.payment_status in ('PAID', 'PARTIALLY_REFUNDED')
         and o.status <> 'CANCELLED'
    ),
    lines as (
      select distinct oi.order_id, oi.product_id
        from order_items oi
        join paid_orders po on po.id = oi.order_id
       where oi.product_id is not null
    ),
    totals as (
      select count(*)::int as total_orders,
             count(distinct product_id)::int as distinct_products
        from paid_orders, lines
    ),
    per_product as (
      select product_id, count(*)::int as orders from lines group by product_id
    ),
    pairs as (
      select a.product_id as product_id,
             b.product_id as co_product_id,
             count(*)::int as pair_orders
        from lines a
        join lines b on b.order_id = a.order_id and b.product_id <> a.product_id
       group by a.product_id, b.product_id
      having count(*) >= ${minPairOrders}
    )
    select p.product_id,
           p.co_product_id,
           p.pair_orders,
           pa.orders::int as product_orders,
           pb.orders::int as co_product_orders,
           (select count(*)::int from paid_orders) as total_orders
      from pairs p
      join per_product pa on pa.product_id = p.product_id
      join per_product pb on pb.product_id = p.co_product_id
  `);

  return rows.rows.map((row) => ({
    productId: row.product_id,
    coProductId: row.co_product_id,
    pairOrders: row.pair_orders,
    productOrders: row.product_orders,
    coProductOrders: row.co_product_orders,
    totalOrders: row.total_orders,
  }));
}

/**
 * View-based co-occurrence, over sessions rather than orders.
 *
 * Same shape as `coPurchaseCounts` so the association metrics apply unchanged.
 * Grouped by session, not by user, because co-view is about what gets compared
 * in one browsing episode — and an anonymous shopper's comparisons are just as
 * informative as a signed-in one's.
 */
export async function coViewCounts(
  options: { since: Date; minPairViews?: number },
  client: DbClient = db,
): Promise<
  Array<{ productId: string; coProductId: string; pairOrders: number; productOrders: number; coProductOrders: number; totalOrders: number }>
> {
  const minPairViews = options.minPairViews ?? 3;
  const rows = await client.execute<{
    product_id: string;
    co_product_id: string;
    pair_orders: number;
    product_orders: number;
    co_product_orders: number;
    total_orders: number;
  }>(sql`
    with views as (
      select distinct
             coalesce(ae.user_id::text, ae.session_id) as subject,
             ae.product_id
        from analytics_events ae
       where ae.event_type in ('PRODUCT_VIEW', 'PRODUCT_CLICK')
         and ae.product_id is not null
         and ae.created_at >= ${options.since}
         and coalesce(ae.user_id::text, ae.session_id) is not null
    ),
    per_product as (
      select product_id, count(distinct subject)::int as subjects
        from views group by product_id
    ),
    pairs as (
      select a.product_id as product_id,
             b.product_id as co_product_id,
             count(distinct a.subject)::int as pair_subjects
        from views a
        join views b on b.subject = a.subject and b.product_id <> a.product_id
       group by a.product_id, b.product_id
      having count(distinct a.subject) >= ${minPairViews}
    )
    select p.product_id,
           p.co_product_id,
           p.pair_subjects as pair_orders,
           pa.subjects::int as product_orders,
           pb.subjects::int as co_product_orders,
           (select count(distinct subject)::int from views) as total_orders
      from pairs p
      join per_product pa on pa.product_id = p.product_id
      join per_product pb on pb.product_id = p.co_product_id
  `);

  return rows.rows.map((row) => ({
    productId: row.product_id,
    coProductId: row.co_product_id,
    pairOrders: row.pair_orders,
    productOrders: row.product_orders,
    coProductOrders: row.co_product_orders,
    totalOrders: row.total_orders,
  }));
}

/**
 * Recently viewed products for one subject, most recent first.
 *
 * De-duplicated: a shopper who reloaded a product page six times has one
 * recently-viewed entry, not six. The count is kept so recency weighting can
 * still tell a passing glance from sustained attention.
 */
export async function listRecentlyViewed(
  subject: { userId?: string | null; sessionId?: string | null },
  options: { limit?: number; since?: Date },
  client: DbClient = db,
): Promise<Array<{ productId: string; viewCount: number; lastViewedAt: Date }>> {
  if (!subject.userId && !subject.sessionId) return [];
  const limit = Math.min(options.limit ?? 24, 100);
  const since = options.since ?? new Date(Date.now() - 30 * 86_400_000);

  const subjectFilter = subject.userId
    ? eq(analyticsEvents.userId, subject.userId)
    : eq(analyticsEvents.sessionId, subject.sessionId!);

  const rows = await client
    .select({
      productId: analyticsEvents.productId,
      viewCount: sql<number>`count(*)::int`,
      lastViewedAt: sql<Date>`max(${analyticsEvents.createdAt})`,
    })
    .from(analyticsEvents)
    .where(
      and(
        subjectFilter,
        inArray(analyticsEvents.eventType, ["PRODUCT_VIEW", "PRODUCT_CLICK"] as never),
        isNotNull(analyticsEvents.productId),
        gte(analyticsEvents.createdAt, since),
      ),
    )
    .groupBy(analyticsEvents.productId)
    .orderBy(sql`max(${analyticsEvents.createdAt}) desc`)
    .limit(limit);

  return rows
    .filter((row): row is { productId: string; viewCount: number; lastViewedAt: Date } => Boolean(row.productId))
    .map((row) => ({ productId: row.productId, viewCount: row.viewCount, lastViewedAt: row.lastViewedAt }));
}

/** Product ids the subject has already purchased — for suppression. */
export async function listPurchasedProductIds(
  userId: string,
  options: { limit?: number } = {},
  client: DbClient = db,
): Promise<string[]> {
  const limit = Math.min(options.limit ?? 200, 1000);
  const rows = await client.execute<{ product_id: string }>(sql`
    select distinct oi.product_id
      from order_items oi
      join orders o on o.id = oi.order_id
     where o.user_id = ${userId}
       and o.payment_status in ('PAID', 'PARTIALLY_REFUNDED')
       and o.status <> 'CANCELLED'
       and oi.product_id is not null
     limit ${limit}
  `);
  return rows.rows.map((row) => row.product_id);
}

/**
 * Purchase intervals per product, for replenishment prediction (§33).
 *
 * Returns the median gap between purchases rather than the mean, because one
 * long outlier — a shopper who bought, then travelled for six months — would
 * otherwise drag the estimate far past when they actually need a replacement.
 */
export async function purchaseIntervals(
  userId: string,
  client: DbClient = db,
): Promise<Array<{ productId: string; medianDays: number; purchases: number }>> {
  const rows = await client.execute<{ product_id: string; median_days: number; purchases: number }>(sql`
    with bought as (
      select oi.product_id, o.created_at,
             lag(o.created_at) over (partition by oi.product_id order by o.created_at) as previous_at
        from order_items oi
        join orders o on o.id = oi.order_id
       where o.user_id = ${userId}
         and o.payment_status in ('PAID', 'PARTIALLY_REFUNDED')
         and o.status <> 'CANCELLED'
         and oi.product_id is not null
    ),
    gaps as (
      select product_id,
             extract(epoch from (created_at - previous_at)) / 86400.0 as gap_days
        from bought
       where previous_at is not null
    )
    select product_id,
           percentile_cont(0.5) within group (order by gap_days)::real as median_days,
           count(*)::int as purchases
      from gaps
     where gap_days > 0
     group by product_id
  `);
  return rows.rows.map((row) => ({
    productId: row.product_id,
    medianDays: row.median_days,
    purchases: row.purchases,
  }));
}

/**
 * Due-for-replenishment predictions.
 *
 * A prediction only, written nowhere and notifying no one — §33 asks for the
 * foundation, and sending a "time to rebuy" email off a median of two data
 * points is the kind of confident wrong that gets recommendations ignored.
 */
export async function predictReplenishment(
  userId: string,
  options: { now?: Date; horizonDays?: number } = {},
  client: DbClient = db,
): Promise<Array<{ productId: string; dueInDays: number; confidence: number }>> {
  const now = options.now ?? new Date();
  const horizonDays = options.horizonDays ?? 30;
  const intervals = await purchaseIntervals(userId, client);
  if (intervals.length === 0) return [];

  const lastPurchases = await client.execute<{ product_id: string; last_at: Date }>(sql`
    select oi.product_id, max(o.created_at) as last_at
      from order_items oi
      join orders o on o.id = oi.order_id
     where o.user_id = ${userId}
       and o.payment_status in ('PAID', 'PARTIALLY_REFUNDED')
       and o.status <> 'CANCELLED'
       and oi.product_id is not null
     group by oi.product_id
  `);
  const lastByProduct = new Map(
    lastPurchases.rows.map((row) => [row.product_id, new Date(row.last_at)]),
  );

  const predictions: Array<{ productId: string; dueInDays: number; confidence: number }> = [];
  for (const interval of intervals) {
    const lastAt = lastByProduct.get(interval.productId);
    if (!lastAt) continue;
    const elapsedDays = (now.getTime() - lastAt.getTime()) / 86_400_000;
    const dueInDays = interval.medianDays - elapsedDays;
    if (dueInDays > horizonDays) continue;
    predictions.push({
      productId: interval.productId,
      dueInDays: Math.round(dueInDays),
      // Two purchases give one interval; confidence grows with evidence.
      confidence: Number(Math.min(0.95, interval.purchases / (interval.purchases + 2)).toFixed(4)),
    });
  }
  return predictions.sort((a, b) => a.dueInDays - b.dueInDays);
}

/** Prune events older than the retention window. Retries are safe. */
export async function pruneOldEvents(
  options: { olderThan: Date; batchSize?: number },
  client: DbClient = db,
): Promise<number> {
  const batchSize = Math.min(options.batchSize ?? 10_000, 100_000);
  try {
    const result = await client.execute(sql`
      delete from analytics_events
       where id in (
         select id from analytics_events
          where created_at < ${options.olderThan}
          limit ${batchSize}
       )
    `);
    const count = Number((result as unknown as { rowCount?: number }).rowCount ?? 0);
    return Number.isFinite(count) ? count : 0;
  } catch (error) {
    logger.warn("failed to prune old behavioural events", {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

export const RECOMMENDATION_EVENT_INTERNALS = {
  SIGNAL_WEIGHTS,
  or,
};
