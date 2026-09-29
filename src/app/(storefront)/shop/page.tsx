import type { Metadata } from "next";
import { CatalogBrowser } from "@/components/catalog/catalog-browser";
import { TrustIndicators } from "@/components/brand/trust-badges";
import { CatalogIntro } from "@/components/storefront/catalog-intro";
import { Container } from "@/components/ui/container";
import { listStorefrontCategories } from "@/services/catalog.service";
import { listPublicFacets } from "@/services/catalog-query.service";
import { getSavedProductIds } from "@/services/storefront.service";
import { buildMetadata } from "@/lib/seo";

export const metadata: Metadata = buildMetadata({
  title: "Shop",
  description:
    "Browse published Inkline artwork on tees, hoodies, mugs, posters and more. Pieces are printed after you order. Checkout is not open yet.",
  path: "/shop",
});

export default async function ShopPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const [categories, facets, savedIds] = await Promise.all([
    listStorefrontCategories().catch(() => []),
    listPublicFacets().catch(() => ({ colors: [], sizes: [] })),
    getSavedProductIds().catch(() => [] as string[]),
  ]);

  return (
    <>
      <CatalogIntro
        eyebrow="Catalogue"
        title="The full catalogue"
        description="Everything published is printed after you order. Checkout is not open yet — you can still open a piece and save it."
        crumbs={[
          { label: "Home", href: "/" },
          { label: "Shop" },
        ]}
      />
      <Container className="py-10 md:py-14">
        <CatalogBrowser
          pathname="/shop"
          searchParams={params}
          categories={categories.map((category) => ({ slug: category.slug, name: category.name }))}
          colors={facets.colors}
          sizes={facets.sizes}
          savedIds={savedIds}
        />
        <TrustIndicators variant="grid" className="mt-14" />
      </Container>
    </>
  );
}
