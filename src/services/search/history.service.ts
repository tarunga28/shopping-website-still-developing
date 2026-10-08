import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import { searchHistory } from "@/db/schema";
import type { DbClient } from "@/db/utils";
import { logger } from "@/lib/logger";
import { canonicalQuery, sanitizeQuery } from "@/lib/catalog/search-text";
import type { SuggestionItem } from "@/lib/search/types";

/**
 * Per-user search history.
 *
 * ## Privacy boundaries
 *
 * Only signed-in users have server-side history, and only their own. Every read
 * takes the user id from the session, never from a request parameter — a caller
 * cannot ask for someone else's history even by trying.
 *
 * Anonymous visitors keep history in the browser. Deliberately: a server-side
 * history keyed by session id would be a durable, linkable browsing record for
 * people who never agreed to one.
 *
 * ## Bounded by design
 *
 * One row per (user, canonical query), upserted. Searching the same thing a
 * hundred times updates a counter rather than adding rows, and the list is
 * trimmed to `MAX_HISTORY_ENTRIES`. The table therefore cannot grow with usage.
 */

/** How many recent searches a user keeps. */
export const MAX_HISTORY_ENTRIES = 20;

/** Longest stored query. Anything longer is a paste, not a search. */
const MAX_STORED_QUERY_LENGTH = 120;

export interface HistoryEntry {
  id: string;
  rawQuery: string;
  normalizedQuery: string;
  resultCount: number;
  searchCount: number;
  lastSearchedAt: Date;
}

/**
 * Record a search for a signed-in user.
 *
 * Never throws. History is a convenience, and a convenience must not be able to
 * fail the search that triggered it.
 */
export async function recordSearch(input: {
  userId: string;
  query: string;
  resultCount: number;
  client?: DbClient;
}): Promise<void> {
  const client = input.client ?? db;
  const raw = sanitizeQuery(input.query).slice(0, MAX_STORED_QUERY_LENGTH).trim();
  if (raw.length < 2) return;

  const normalized = canonicalQuery(raw);

  try {
    await client
      .insert(searchHistory)
      .values({
        userId: input.userId,
        rawQuery: raw,
        normalizedQuery: normalized,
        resultCount: Math.max(0, input.resultCount),
        searchCount: 1,
        lastSearchedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [searchHistory.userId, searchHistory.normalizedQuery],
        set: {
          // The raw form is refreshed so the list shows how the shopper most
          // recently typed it, which is the form they will recognise.
          rawQuery: raw,
          resultCount: Math.max(0, input.resultCount),
          searchCount: sql`${searchHistory.searchCount} + 1`,
          lastSearchedAt: new Date(),
        },
      });

    await trimHistory(input.userId, client);
  } catch (error) {
    logger.warn("could not record search history", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Keep only the most recent N entries. */
async function trimHistory(userId: string, client: DbClient): Promise<void> {
  const stale = await client
    .select({ id: searchHistory.id })
    .from(searchHistory)
    .where(eq(searchHistory.userId, userId))
    .orderBy(desc(searchHistory.lastSearchedAt))
    .offset(MAX_HISTORY_ENTRIES);

  if (stale.length === 0) return;
  await client.delete(searchHistory).where(inArray(searchHistory.id, stale.map((row) => row.id)));
}

/** A user's recent searches, most recent first. */
export async function getSearchHistory(
  userId: string,
  options: { limit?: number; client?: DbClient } = {},
): Promise<HistoryEntry[]> {
  const client = options.client ?? db;
  const limit = Math.max(1, Math.min(options.limit ?? MAX_HISTORY_ENTRIES, MAX_HISTORY_ENTRIES));

  const rows = await client
    .select()
    .from(searchHistory)
    .where(eq(searchHistory.userId, userId))
    .orderBy(desc(searchHistory.lastSearchedAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    rawQuery: row.rawQuery,
    normalizedQuery: row.normalizedQuery,
    resultCount: row.resultCount,
    searchCount: row.searchCount,
    lastSearchedAt: row.lastSearchedAt,
  }));
}

/** Remove one entry. Scoped to the owner, so an id cannot delete another user's row. */
export async function removeHistoryEntry(
  userId: string,
  entryId: string,
  client: DbClient = db,
): Promise<boolean> {
  const [row] = await client
    .delete(searchHistory)
    .where(and(eq(searchHistory.userId, userId), eq(searchHistory.id, entryId)))
    .returning({ id: searchHistory.id });
  return Boolean(row);
}

/** Clear all of a user's history. */
export async function clearSearchHistory(userId: string, client: DbClient = db): Promise<number> {
  const rows = await client
    .delete(searchHistory)
    .where(eq(searchHistory.userId, userId))
    .returning({ id: searchHistory.id });
  return rows.length;
}

/** History rendered as autocomplete suggestions, ahead of everything else. */
export function historyToSuggestions(entries: readonly HistoryEntry[]): SuggestionItem[] {
  return entries.map((entry, index) => ({
    type: "HISTORY" as const,
    text: entry.rawQuery,
    href: `/search?q=${encodeURIComponent(entry.rawQuery)}`,
    imageUrl: null,
    meta: entry.searchCount > 1 ? `${entry.searchCount} searches` : null,
    // Highest weight: a shopper's own history is the most likely next search.
    weight: 2000 - index,
  }));
}
