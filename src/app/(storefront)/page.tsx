import type { Metadata } from "next";
import { Categories } from "@/components/home/categories";
import { DesignShowcase } from "@/components/home/design-showcase";
import { FeaturedCollection } from "@/components/home/featured-collection";
import { FeaturedProducts } from "@/components/home/featured-products";
import { Hero } from "@/components/home/hero";
import { HowItWorks } from "@/components/home/how-it-works";
import { Marquee } from "@/components/home/marquee";
import { NewArrivals } from "@/components/home/new-arrivals";
import { Newsletter } from "@/components/home/newsletter";
import { PromoBanners } from "@/components/home/promo-banner";
import { Reviews } from "@/components/home/reviews";
import { WhyUs } from "@/components/home/why-us";
import { JsonLd } from "@/components/storefront/json-ld";
import { homepageSections, storefrontContent } from "@/content/storefront";
import { organizationJsonLd, websiteJsonLd, buildMetadata } from "@/lib/seo";
import { loadHomepage } from "@/services/storefront.service";

export const metadata: Metadata = buildMetadata({
  title: "Original art, printed after you order",
  description:
    "Inkline prints original artwork on tees, hoodies, mugs, posters and more after you order. Browse the catalogue, save pieces to a wishlist, and join the list for launch notes.",
  path: "/",
  image: "/images/og.jpg",
});

export default async function HomePage() {
  const home = await loadHomepage();
  const visible = new Set(homepageSections.filter((section) => section.visible).map((section) => section.id));

  return (
    <>
      <JsonLd data={[organizationJsonLd(), websiteJsonLd()]} />
      {visible.has("hero") ? <Hero /> : null}
      {visible.has("marquee") ? <Marquee /> : null}
      {visible.has("promo") ? (
        <PromoBanners banners={storefrontContent.banners} placement="after-hero" />
      ) : null}
      {visible.has("categories") ? (
        <Categories categories={home.categories.data} status={home.categories.status} />
      ) : null}
      {visible.has("featured-products") ? (
        <FeaturedProducts
          products={home.featuredProducts.data}
          status={home.featuredProducts.status}
          savedIds={home.savedIds}
        />
      ) : null}
      {visible.has("new-arrivals") ? (
        <NewArrivals products={home.newArrivals.data} status={home.newArrivals.status} savedIds={home.savedIds} />
      ) : null}
      {visible.has("featured-collection") ? (
        <FeaturedCollection
          collection={home.featuredCollection.data?.collection ?? null}
          products={home.featuredCollection.data?.products ?? []}
          status={home.featuredCollection.status}
          savedIds={home.savedIds}
        />
      ) : null}
      {visible.has("how-it-works") ? <HowItWorks /> : null}
      {visible.has("why-us") ? <WhyUs /> : null}
      {visible.has("design-showcase") ? <DesignShowcase /> : null}
      {visible.has("reviews") ? <Reviews reviews={home.reviews.data} status={home.reviews.status} /> : null}
      {visible.has("newsletter") ? <Newsletter /> : null}
      {visible.has("promo") ? (
        <PromoBanners banners={storefrontContent.banners} placement="before-footer" />
      ) : null}
    </>
  );
}
