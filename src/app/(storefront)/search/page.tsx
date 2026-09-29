import type { Metadata } from "next";
import { CatalogBrowser } from "@/components/catalog/catalog-browser";
import { CatalogIntro } from "@/components/storefront/catalog-intro";
import { SearchForm } from "@/components/storefront/search-form";
import { Container } from "@/components/ui/container";
import { EmptySearch } from "@/components/ui/empty-state";
import { searchMetadata } from "@/lib/seo";
import { sanitizeSearchQuery } from "@/lib/slug";
import { getSavedProductIds } from "@/services/storefront.service";

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
  const savedIds = await getSavedProductIds().catch(() => [] as string[]);

  return (
    <>
      <CatalogIntro
        eyebrow="Search"
        title={query ? `Results for “${query}”` : "Search"}
        description="Search published names, slugs, tags and categories. This is a simple match, not a full search engine."
        crumbs={[
          { label: "Home", href: "/" },
          { label: "Search" },
        ]}
      />
      <Container className="py-10 md:py-14">
        <SearchForm initialQuery={query} />
        <div className="mt-10">
          {query.length > 0 && query.length < 2 ? (
            <EmptySearch query={query} />
          ) : query.length >= 2 ? (
            <CatalogBrowser pathname="/search" searchParams={{ ...params, q: query }} locked={{ q: query }} title="Search results" savedIds={savedIds} />
          ) : null}
        </div>
      </Container>
    </>
  );
}
