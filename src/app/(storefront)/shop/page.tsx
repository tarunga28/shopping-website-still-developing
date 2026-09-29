import type { Metadata } from "next";
import { ProductListing } from "@/components/catalog/product-listing";
import { TrustIndicators } from "@/components/brand/trust-badges";
import { Container } from "@/components/ui/container";
import { Badge } from "@/components/ui/badge";
import { listActiveProductSummaries } from "@/services/catalog.service";
import { buildMetadata } from "@/lib/seo";

export const metadata: Metadata = buildMetadata({
  title: "Shop the preview catalogue",
  description:
    "Browse the Inkline preview catalogue — original artwork on tees, hoodies, mugs, posters and more. Every piece printed on demand; checkout opens at launch.",
  path: "/shop",
});

/**
 * Shop — live active catalogue from the database. Listing chrome (sort,
 * layout, count) is functional; filtering activates with the catalog UI milestone.
 */
export default async function ShopPage() {
  const products = await listActiveProductSummaries();

  return (
    <>
      <section className="border-b-[1.5px] border-ink bg-cream">
        <Container className="py-14 md:py-20">
          <Badge variant="new">Live catalogue</Badge>
          <h1 className="mt-5 font-display text-4xl font-extrabold uppercase leading-[0.95] tracking-tight sm:text-6xl lg:text-7xl">
            The full drop,
            <br />
            first look<span className="text-flame">.</span>
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-smoke">
            Everything here is printed fresh after you order — checkout unlocks at launch with
            secure UPI &amp; card payments.
          </p>
          <TrustIndicators className="mt-8" />
        </Container>
      </section>

      <Container className="py-12 md:py-16">
        <ProductListing products={products} />
      </Container>
    </>
  );
}
