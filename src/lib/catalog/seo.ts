import type { Metadata } from "next";
import { siteConfig } from "@/config/site";
import { buildMetadata, absoluteUrl } from "@/lib/seo";
import { plainText } from "@/lib/plain-text";
import type { ParsedCatalogParams } from "./params";

/**
 * Indexing strategy for catalog listings (controlled URL space):
 *
 *  - The clean URL (`/shop`, `/category/x`, `/collection/y`) is indexable.
 *  - `?page=N` (N ≥ 2, nothing else in the query) is indexable and
 *    self-canonical, with rel=prev/next, so deep products stay discoverable.
 *  - EVERY other query string — filters, sorting, `page=1`, unknown or
 *    malformed parameters — is `noindex, follow` and canonicalises to the
 *    clean URL. Arbitrary parameter combinations therefore cannot create
 *    indexable duplicates, and crawlers still follow links to products.
 *  - Filter landing pages meant for SEO must be added deliberately later as
 *    dedicated routes/whitelisted entries; none exist today.
 */

export interface CatalogSeoInput {
  basePath: string;
  title: string;
  description: string;
  image?: string | null;
  parsed: ParsedCatalogParams;
  page: number;
  totalPages: number;
}

export function isIndexableCatalogUrl(parsed: ParsedCatalogParams): boolean {
  if (parsed.hasNonPageParams) return false;
  if (parsed.rawPage === null) return true;
  return parsed.filters.page > 1 && String(parsed.filters.page) === parsed.rawPage;
}

export function catalogCanonicalPath(basePath: string, parsed: ParsedCatalogParams): string {
  return isIndexableCatalogUrl(parsed) && parsed.filters.page > 1 ? `${basePath}?page=${parsed.filters.page}` : basePath;
}

export function catalogMetadata(input: CatalogSeoInput): Metadata {
  const { basePath, parsed, page, totalPages } = input;
  const title = plainText(input.title, 70) || siteConfig.name;
  const indexable = isIndexableCatalogUrl(parsed);
  const canonicalPath = catalogCanonicalPath(basePath, parsed);
  const pageSuffix = indexable && page > 1 ? ` — Page ${page}` : "";

  const metadata = buildMetadata({
    title: `${title}${pageSuffix}`,
    description: plainText(input.description, 160),
    path: canonicalPath,
    image: input.image ?? undefined,
  });

  const pagination: NonNullable<Metadata["pagination"]> = {};
  if (indexable) {
    if (page > 1) pagination.previous = absoluteUrl(page === 2 ? basePath : `${basePath}?page=${page - 1}`);
    if (page < totalPages) pagination.next = absoluteUrl(`${basePath}?page=${page + 1}`);
  }

  return {
    ...metadata,
    robots: indexable ? undefined : { index: false, follow: true },
    ...(pagination.previous || pagination.next ? { pagination } : {}),
  };
}
