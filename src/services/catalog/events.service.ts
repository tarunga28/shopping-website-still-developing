import "server-only";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { catalogEvents, type CatalogEventType } from "@/db/schema";
import type { DbClient } from "@/db/utils";
import { errorContext, logger } from "@/lib/logger";

/**
 * Catalog event outbox.
 *
 * Events are written in the SAME database transaction as the state change they
 * describe. That is the whole point of an outbox: with a broker, a crash between
 * "commit" and "publish" loses the event, or publishing before commit announces
 * something that got rolled back. Here neither is possible — if the transaction
 * commits, the event exists; if it rolls back, it never did.
 *
 * Consumers (search indexer, recommendations, notifications, analytics, seller
 * dashboards) poll `claimEvents`, do their work, then call `markPublished`.
 * Redelivery is possible after a crash, so every consumer must be idempotent.
 */

export interface CatalogEventInput {
  eventType: CatalogEventType;
  aggregateType?: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  actorId?: string | null;
}

/**
 * Record an event. Must be called with the same `client` as the write it
 * describes so both land in one transaction.
 *
 * Never throws: a failed event write must not roll back a successful product
 * save. The state change is the important part; a missed event is recoverable
 * by re-indexing.
 */
export async function emitCatalogEvent(
  client: DbClient,
  input: CatalogEventInput,
): Promise<string | null> {
  try {
    const [row] = await client
      .insert(catalogEvents)
      .values({
        eventType: input.eventType,
        aggregateType: input.aggregateType ?? "product",
        aggregateId: input.aggregateId,
        payload: input.payload,
        actorId: input.actorId ?? null,
      })
      .returning({ id: catalogEvents.id });
    return row?.id ?? null;
  } catch (error) {
    logger.warn("Catalog event write failed", { eventType: input.eventType, ...errorContext(error) });
    return null;
  }
}

/** Convenience: emit several events inside one transaction. */
export async function emitCatalogEvents(
  client: DbClient,
  events: readonly CatalogEventInput[],
): Promise<number> {
  let written = 0;
  for (const event of events) {
    if (await emitCatalogEvent(client, event)) written += 1;
  }
  return written;
}

export interface ClaimedEvent {
  id: string;
  eventType: CatalogEventType;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  attemptCount: number;
  createdAt: Date;
}

/**
 * Take the next batch of unpublished events.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes several workers safe: each row is
 * locked by exactly one consumer, and the others skip past it instead of
 * queueing. Ordered by creation so the log is processed in order.
 */
export async function claimEvents(
  options: { limit?: number; maxAttempts?: number; eventTypes?: readonly CatalogEventType[] } = {},
  client: DbClient = db,
): Promise<ClaimedEvent[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const maxAttempts = options.maxAttempts ?? 5;

  const conditions = [isNull(catalogEvents.publishedAt), sql`${catalogEvents.attemptCount} < ${maxAttempts}`];
  if (options.eventTypes && options.eventTypes.length > 0) {
    conditions.push(inArray(catalogEvents.eventType, [...options.eventTypes]));
  }

  const rows = await client
    .select()
    .from(catalogEvents)
    .where(and(...conditions))
    .orderBy(asc(catalogEvents.createdAt), asc(catalogEvents.id))
    .limit(limit)
    .for("update", { skipLocked: true });

  if (rows.length === 0) return [];

  // Bump the attempt counter up front so a worker that dies mid-processing does
  // not hand the same event to the next worker forever.
  await client
    .update(catalogEvents)
    .set({ attemptCount: sql`${catalogEvents.attemptCount} + 1` })
    .where(inArray(catalogEvents.id, rows.map((row) => row.id)));

  return rows.map((row) => ({
    id: row.id,
    eventType: row.eventType,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    attemptCount: row.attemptCount,
    createdAt: row.createdAt,
  }));
}

export async function markEventsPublished(ids: readonly string[], client: DbClient = db): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await client
    .update(catalogEvents)
    .set({ publishedAt: new Date() })
    .where(and(inArray(catalogEvents.id, [...ids]), isNull(catalogEvents.publishedAt)));
  return Number(result.rowCount ?? ids.length);
}

export async function markEventFailed(
  id: string,
  error: unknown,
  client: DbClient = db,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await client.update(catalogEvents).set({ lastError: message.slice(0, 1000) }).where(eq(catalogEvents.id, id));
}

/** How far behind the outbox is — a simple operational health signal. */
export async function outboxDepth(client: DbClient = db): Promise<number> {
  const [row] = await client
    .select({ pending: sql<number>`count(*)::int` })
    .from(catalogEvents)
    .where(isNull(catalogEvents.publishedAt));
  return Number(row?.pending ?? 0);
}

/**
 * Drop published events older than `olderThan`. The outbox is a queue, not an
 * archive — the audit trail lives in `audit_events`.
 */
export async function prunePublishedEvents(
  olderThan: Date,
  client: DbClient = db,
): Promise<number> {
  const result = await client
    .delete(catalogEvents)
    .where(
      and(
        sql`${catalogEvents.publishedAt} IS NOT NULL`,
        sql`${catalogEvents.publishedAt} < ${olderThan}`,
      ),
    );
  return Number(result.rowCount ?? 0);
}
