import type { Metadata } from "next";
import { CatalogLoadError } from "@/components/catalog/catalog-states";
import { TaxonomyGrid } from "@/components/catalog/taxonomy-grid";
import { CatalogIntro } from "@/components/storefront/catalog-intro";
import { JsonLd } from "@/components/storefront/json-ld";
import { Container } from "@/components/ui/container";
import { EmptyState } from "@/components/ui/empty-state";
import { errorContext, logger } from "@/lib/logger";
import { breadcrumbJsonLd, buildMetadata } from "@/lib/seo";
import { getCachedCollections } from "@/services/catalog/cached";

export const metadata: Metadata = buildMetadata({
  title: "Collections",
  description: "Curated Inkline collections of original designs.",
  path: "/collections",
});

export default async function CollectionsPage() {
  let cards;
  try {
    const rows = await getCachedCollections();
    cards = rows
      .filter((row) => row.productCount > 0)
      .map((row) => ({
        href: `/collection/${row.slug}`,
        name: row.name,
        description: row.description,
        count: row.productCount,
        image: row.image,
      }));
  } catch (error) {
    logger.error("Collections index failed", errorContext(error));
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
          { name: "Collections", path: "/collections" },
        ])}
      />
      <CatalogIntro
        eyebrow="Curated"
        title="Collections"
        description="Hand-picked groups of designs."
        crumbs={[{ label: "Home", href: "/" }, { label: "Collections" }]}
      />
      <Container className="py-10 md:py-14">
        {cards.length === 0 ? (
          <EmptyState title="No collections yet." description="Check back soon, or explore everything in the shop." action={{ label: "Browse All Products", href: "/shop" }} />
        ) : (
          <TaxonomyGrid items={cards} />
        )}
      </Container>
    </>
  );
}
