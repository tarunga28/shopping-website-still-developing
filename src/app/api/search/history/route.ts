import { apiOk, withErrorHandling } from "@/lib/api-response";
import { catalogApiLimiter, enforceRateLimit } from "@/lib/catalog/api";
import { ValidationError } from "@/lib/errors";
import { requireUser } from "@/server/auth/session";
import {
  MAX_HISTORY_ENTRIES,
  clearSearchHistory,
  getSearchHistory,
  removeHistoryEntry,
} from "@/services/search/history.service";

export const dynamic = "force-dynamic";

const limiter = catalogApiLimiter("api-search-history", 60);

/**
 * GET /api/search/history — the signed-in shopper's recent searches.
 *
 * Requires authentication, and the user id comes from the session. There is no
 * parameter that selects whose history to read, because that is precisely the
 * parameter that must not exist.
 */
export const GET = withErrorHandling(async (request: Request) => {
  enforceRateLimit(limiter, request);
  const user = await requireUser("/login");

  const url = new URL(request.url);
  const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, MAX_HISTORY_ENTRIES)
      : MAX_HISTORY_ENTRIES;

  const entries = await getSearchHistory(user.id, { limit });
  return apiOk({ entries, maxEntries: MAX_HISTORY_ENTRIES });
}, "api-search-history-get");

/**
 * DELETE /api/search/history?entryId=<id> — remove one entry.
 * DELETE /api/search/history                 — clear everything.
 */
export const DELETE = withErrorHandling(async (request: Request) => {
  enforceRateLimit(limiter, request);
  const user = await requireUser("/login");

  const url = new URL(request.url);
  const entryId = url.searchParams.get("entryId");

  if (entryId) {
    // A UUID shape check before the query: an attacker probing for other users'
    // entry ids gets a 422 rather than a slow "not found" per guess.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entryId)) {
      throw new ValidationError("Invalid entry id.");
    }
    const removed = await removeHistoryEntry(user.id, entryId);
    return apiOk({ removed });
  }

  const removed = await clearSearchHistory(user.id);
  return apiOk({ removed });
}, "api-search-history-delete");
