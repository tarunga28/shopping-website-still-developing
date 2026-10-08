import type { Metadata } from "next";
import { Suspense } from "react";

import { CatalogIntro } from "@/components/storefront/catalog-intro";
import { SearchResults } from "@/components/search/search-results";
import { Container } from "@/components/ui/container";
import { Spinner } from "@/components/ui/spinner";
import { searchMetadata } from "@/lib/seo";
import { sanitizeSearchQuery } from "@/lib/slug";

/**
 * The search page.
 *
 * The shell is a server component so metadata and the page frame render without
 * JavaScript; the interactive part (query, filters, sort, results) is a client
 * component suspended inside it. That split keeps first paint fast while still
 * letting the whole search state live in the URL.
 */

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}): Promise<Metadata> {
  const { q } = await searchParams;
  return searchMetadata(sanitizeSearchQuery(q));
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = sanitizeSearchQuery(typeof params.q === "string" ? params.q : params.q?.[0]);

  return (
    <>
      <CatalogIntro
        eyebrow="Search"
        title={query ? `Results for “${query}”` : "Search"}
        description="Search by product, brand, category, attribute, SKU, or barcode. Try “gaming laptop under 70000” or “black shoes size 9”."
        crumbs={[{ label: "Home", href: "/" }, { label: "Search" }]}
      />
      <Container className="py-10 md:py-14">
        <Suspense
          fallback={
            <div className="flex justify-center py-16" aria-busy>
              <Spinner label="Loading search" />
            </div>
          }
        >
          <SearchResults />
        </Suspense>
      </Container>
    </>
  );
}
