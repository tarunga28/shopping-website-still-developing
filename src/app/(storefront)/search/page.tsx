import type { Metadata } from "next";
import { CatalogLoadError } from "@/components/catalog/catalog-states";
import { CatalogIntro } from "@/components/storefront/catalog-intro";
import { SearchForm } from "@/components/storefront/search-form";
import { Container } from "@/components/ui/container";
import { EmptySearch } from "@/components/ui/empty-state";
import { ProductCard } from "@/components/ui/product-card";
import { searchMetadata } from "@/lib/seo";
import { sanitizeSearchQuery } from "@/lib/slug";
import { getSavedProductIds, loadSearch } from "@/services/storefront.service";

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
  const [savedIds, results] = await Promise.all([
    getSavedProductIds().catch(() => [] as string[]),
    query.length >= 2 ? loadSearch(query) : Promise.resolve(null),
  ]);
  const saved = new Set(savedIds);

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
          ) : results?.status === "error" ? (
            <CatalogLoadError />
          ) : results && results.data.length === 0 ? (
            <EmptySearch query={query} />
          ) : results ? (
            <ul className="grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-3 xl:grid-cols-4">
              {results.data.map((product, index) => (
                <li key={product.id}>
                  <ProductCard product={product} saved={saved.has(product.id)} priority={index < 4} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Container>
    </>
  );
}
