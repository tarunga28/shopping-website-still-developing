import "server-only";
import { revalidatePath, revalidateTag } from "next/cache";
import { errorContext, logger } from "@/lib/logger";
import { CATALOG_CACHE_TAG } from "./constants";

/**
 * Called after every admin catalog write (products, variants, images,
 * categories, collections, bulk actions).
 *
 * `expire: 0` expires immediately, so the next storefront request re-reads
 * the database: a price change, an archived product or a product removed from
 * a category disappears from the catalog without waiting for the TTL. Cached
 * reads also carry a short TTL as a safety net (see CATALOG_REVALIDATE_SECONDS).
 *
 * Never throws: an invalidation problem must not turn a successful save into
 * an error. Outside a request context (scripts, tests) it is a no-op.
 */
export function invalidateCatalogCache(): void {
  try {
    revalidateTag(CATALOG_CACHE_TAG, { expire: 0 });
    for (const path of ["/shop", "/collections", "/categories", "/"]) revalidatePath(path);
    revalidatePath("/category/[slug]", "page");
    revalidatePath("/collection/[slug]", "page");
    revalidatePath("/product/[slug]", "page");
  } catch (error) {
    logger.warn("Catalog cache invalidation skipped", errorContext(error));
  }
}
