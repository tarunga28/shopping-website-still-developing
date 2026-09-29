import type { Metadata } from "next";
import { CatalogLoadError } from "@/components/catalog/catalog-states";
import { TaxonomyGrid } from "@/components/catalog/taxonomy-grid";
import { CatalogIntro } from "@/components/storefront/catalog-intro";
import { JsonLd } from "@/components/storefront/json-ld";
import { Container } from "@/components/ui/container";
import { EmptyState } from "@/components/ui/empty-state";
import { errorContext, logger } from "@/lib/logger";
import { breadcrumbJsonLd, buildMetadata } from "@/lib/seo";
import { getCachedCategories, getCachedCategoryCounts } from "@/services/catalog/cached";

export const metadata: Metadata = buildMetadata({
  title: "Categories",
  description: "Browse every Inkline category, from tees and hoodies to mugs and posters.",
  path: "/categories",
});

export default async function CategoriesPage() {
  let cards;
  try {
    const [tree, counts] = await Promise.all([getCachedCategories(), getCachedCategoryCounts()]);
    cards = tree
      .filter((category) => category.parentId === null && (counts[category.id]?.count ?? 0) > 0)
      .map((category) => ({
        href: `/category/${category.slug}`,
        name: category.name,
        description: category.description?.trim() ?? "",
        count: counts[category.id]?.count ?? 0,
        image: category.image,
      }));
  } catch (error) {
    logger.error("Categories index failed", errorContext(error));
    return (
      <Container className="py-16">
        <CatalogLoadError />
      </Container>
    );
  }

  return (
    <>
      <JsonLd
        data={breadcrumbJsonLd([
          { name: "Home", path: "/" },
          { name: "Categories", path: "/categories" },
        ])}
      />
      <CatalogIntro
        eyebrow="Browse"
        title="Categories"
        description="Find what you are looking for by product type."
        crumbs={[{ label: "Home", href: "/" }, { label: "Categories" }]}
      />
      <Container className="py-10 md:py-14">
        {cards.length === 0 ? (
          <EmptyState title="Our store is getting ready." description="New designs are coming soon." action={{ label: "Return Home", href: "/" }} />
        ) : (
          <TaxonomyGrid items={cards} />
        )}
      </Container>
    </>
  );
}
