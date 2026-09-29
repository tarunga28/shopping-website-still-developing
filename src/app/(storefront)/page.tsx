import type { Metadata } from "next";
import { Categories } from "@/components/home/categories";
import { FeaturedProducts } from "@/components/home/featured-products";
import { Hero } from "@/components/home/hero";
import { HowItWorks } from "@/components/home/how-it-works";
import { Marquee } from "@/components/home/marquee";
import { NewArrivals } from "@/components/home/new-arrivals";
import { Newsletter } from "@/components/home/newsletter";
import { StudioStrip } from "@/components/home/studio-strip";
import { Testimonials } from "@/components/home/testimonials";
import { WhyUs } from "@/components/home/why-us";
import { listActiveProductSummaries } from "@/services/catalog.service";
import { buildMetadata } from "@/lib/seo";

export const metadata: Metadata = buildMetadata({ path: "/" });

/**
 * Storefront home — product sections read the REAL catalog (ACTIVE rows
 * only). Editorial sections remain content-driven.
 */
export default async function HomePage() {
  const products = await listActiveProductSummaries();

  return (
    <>
      <Hero />
      <Marquee />
      <Categories />
      <NewArrivals products={products} />
      <FeaturedProducts products={products} />
      <HowItWorks />
      <WhyUs />
      <Testimonials />
      <Newsletter />
      <StudioStrip />
    </>
  );
}
