import { z } from "zod";

import { apiOk, withErrorHandling } from "@/lib/api-response";
import { catalogApiLimiter, enforceRateLimit } from "@/lib/catalog/api";
import { ValidationError } from "@/lib/errors";
import { requireCatalogEditorApi } from "@/server/auth/catalog-access";
import {
  countUnindexed,
  indexStatus,
  processIndexQueue,
  refreshDerivedIndexes,
  reindexBrand,
  reindexCatalog,
  reindexCategory,
  reindexTargets,
} from "@/services/search/index.service";

export const dynamic = "force-dynamic";

/** Re-indexing is expensive; these limits keep a double-click from doubling it. */
const limiter = catalogApiLimiter("api-admin-search-index", 12);

const targetSchema = z.object({
  kind: z.enum(["all", "category", "brand", "queue", "derived"]),
  id: z.string().uuid().optional(),
  batchSize: z.number().int().min(50).max(2000).optional(),
});

/** GET /api/admin/search/index — current index health. */
export const GET = withErrorHandling(async (request: Request) => {
  enforceRateLimit(limiter, request);
  await requireCatalogEditorApi();

  const [status, stale, targets] = await Promise.all([
    indexStatus(),
    countUnindexed(),
    reindexTargets(),
  ]);

  return apiOk({ status: { ...status, staleProducts: stale }, targets });
}, "api-admin-search-index-get");

/**
 * POST /api/admin/search/index
 *
 *   { kind: "all" }                     rebuild the whole catalog index
 *   { kind: "category", id }            rebuild one category subtree
 *   { kind: "brand", id }               rebuild one brand's products
 *   { kind: "queue" }                   drain the pending catalog-event queue
 *   { kind: "derived" }                 rebuild vocabulary + suggestions
 *
 * The routine path is "queue": product edits write to the outbox and a scheduled
 * call drains it, so no administrator has to remember to re-index anything. The
 * other kinds exist for recovery after a bulk import or a schema change.
 */
export const POST = withErrorHandling(async (request: Request) => {
  enforceRateLimit(limiter, request);
  await requireCatalogEditorApi();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ValidationError("Invalid request body.");
  }

  const parsed = targetSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the reindex target.");
  }

  const { kind, id, batchSize } = parsed.data;

  if (kind === "category" || kind === "brand") {
    if (!id) throw new ValidationError("An id is required to reindex a category or brand.");
    const result =
      kind === "category" ? await reindexCategory(id) : await reindexBrand(id);
    return apiOk({ kind, ...result });
  }

  if (kind === "queue") {
    const result = await processIndexQueue({ batchSize });
    return apiOk({ kind, ...result });
  }

  if (kind === "derived") {
    const result = await refreshDerivedIndexes();
    return apiOk({ kind, ...result });
  }

  const result = await reindexCatalog({ batchSize });
  return apiOk({ kind, ...result });
}, "api-admin-search-index-post");
