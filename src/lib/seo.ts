import type { Metadata } from "next";
import { siteConfig } from "@/config/site";
import { plainText } from "@/lib/plain-text";
import { isSafeImageSrc, safeHref } from "@/lib/safe-url";

/**
 * Central SEO architecture. Pages compose metadata through `buildMetadata`
 * so title templates, Open Graph, Twitter cards and canonical URLs stay
 * consistent everywhere.
 */

export interface PageSeoInput {
  title?: string;
  description?: string;
  /** Route path used to build the canonical + OG URL, e.g. "/legal/privacy". */
  path?: string;
  /** Absolute or site-relative OG image path. */
  image?: string;
  noIndex?: boolean;
}

const DEFAULT_OG_IMAGE = "/images/og.jpg";

export function absoluteUrl(path = "/"): string {
  return `${siteConfig.url}${path.startsWith("/") ? path : `/${path}`}`;
}

export function buildMetadata(input: PageSeoInput = {}): Metadata {
  const { title, description = siteConfig.description, path = "/", image, noIndex } = input;

  const url = absoluteUrl(path);
  const ogImage = image ?? DEFAULT_OG_IMAGE;

  return {
    title, // layout's title template renders "%s · Inkline"
    description,
    alternates: { canonical: url },
    robots: noIndex ? { index: false, follow: false } : undefined,
    openGraph: {
      type: "website",
      siteName: siteConfig.name,
      title: title ? `${title} · ${siteConfig.name}` : `${siteConfig.name} — ${siteConfig.tagline}`,
      description,
      url,
      locale: "en_IN",
      images: [{ url: ogImage, width: 1200, height: 630, alt: siteConfig.name }],
    },
    twitter: {
      card: "summary_large_image",
      title: title ? `${title} · ${siteConfig.name}` : siteConfig.name,
      description,
      images: [ogImage],
    },
  };
}

function metaImage(src: string | null | undefined): string | undefined {
  if (!src || !isSafeImageSrc(src)) return undefined;
  return src;
}

export function productMetadata(input: {
  title: string;
  description?: string | null;
  slug: string;
  image?: string | null;
  noIndex?: boolean;
}): Metadata {
  const title = plainText(input.title, 70) || "Product";
  const description = plainText(
    input.description || `${title} from ${siteConfig.name}. Printed after you order.`,
    160,
  );
  return buildMetadata({
    title,
    description,
    // Always the clean URL: `?color=&size=` variants never become their own indexable pages.
    path: `/product/${input.slug}`,
    image: metaImage(input.image),
    noIndex: input.noIndex,
  });
}

export function categoryMetadata(input: {
  title: string;
  description?: string | null;
  slug: string;
  image?: string | null;
}): Metadata {
  const title = plainText(input.title, 70) || "Category";
  const description = plainText(
    input.description || `Shop ${title} at ${siteConfig.name}. Printed after you order.`,
    160,
  );
  return buildMetadata({
    title,
    description,
    path: `/category/${input.slug}`,
    image: metaImage(input.image),
  });
}

export function collectionMetadata(input: {
  title: string;
  description?: string | null;
  slug: string;
  image?: string | null;
}): Metadata {
  const title = plainText(input.title, 70) || "Collection";
  const description = plainText(
    input.description || `${title} — a collection from ${siteConfig.name}.`,
    160,
  );
  return buildMetadata({
    title,
    description,
    path: `/collection/${input.slug}`,
    image: metaImage(input.image),
  });
}

/** Internal search results are not indexable. The query is plain text only. */
export function searchMetadata(query: string): Metadata {
  const clean = plainText(query, 60);
  return buildMetadata({
    title: clean ? `Search: ${clean}` : "Search",
    description: clean
      ? `Search results for “${clean}” on ${siteConfig.name}.`
      : `Search original artwork on ${siteConfig.name}.`,
    path: "/search",
    noIndex: true,
  });
}

export function organizationJsonLd() {
  const sameAs = Object.values(siteConfig.social)
    .map((href) => safeHref(href, ""))
    .filter((href) => href.startsWith("https://"));

  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: plainText(siteConfig.legalName, 120),
    url: siteConfig.url,
    email: siteConfig.contact.email,
    logo: `${siteConfig.url}/icon.svg`,
    sameAs,
  };
}

export function websiteJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: plainText(siteConfig.name, 80),
    url: siteConfig.url,
    description: plainText(siteConfig.description, 300),
    potentialAction: {
      "@type": "SearchAction",
      target: `${siteConfig.url}/search?q={search_term_string}`,
      "query-input": "required name=search_term_string",
    },
  };
}

export function breadcrumbJsonLd(items: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: plainText(item.name, 80),
      item: `${siteConfig.url}${item.path.startsWith("/") ? item.path : `/${item.path}`}`,
    })),
  };
}

const AVAILABILITY: Record<string, string> = {
  in_stock: "https://schema.org/InStock",
  low_stock: "https://schema.org/LimitedAvailability",
  sold_out: "https://schema.org/OutOfStock",
  coming_soon: "https://schema.org/PreOrder",
  discontinued: "https://schema.org/Discontinued",
};

/** Schema.org wants a decimal string. Built from integer paise, not floating-point money math. */
export function schemaPrice(paise: number): string {
  const safe = Number.isInteger(paise) && paise >= 0 ? paise : 0;
  const whole = Math.trunc(safe / 100);
  const frac = String(safe % 100).padStart(2, "0");
  return `${whole}.${frac}`;
}

export function productJsonLd(input: {
  name: string;
  description?: string | null;
  slug: string;
  image?: string | null;
  pricePaise: number;
  availability?: string;
  sku?: string | null;
  rating?: { value: number; count: number };
  /** Per-variant offers. Omitted → a single offer at `pricePaise`. */
  offers?: { sku: string; pricePaise: number; orderable: boolean }[];
}) {
  const productUrl = `${siteConfig.url}/product/${input.slug}`;
  const offerList = (input.offers ?? [])
    .filter((offer) => Number.isInteger(offer.pricePaise) && offer.pricePaise > 0)
    .slice(0, 50)
    .map((offer) => ({
      "@type": "Offer",
      sku: plainText(offer.sku, 64),
      priceCurrency: siteConfig.commerce.currency,
      price: schemaPrice(offer.pricePaise),
      availability: offer.orderable ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      url: productUrl,
    }));
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: plainText(input.name, 120),
    description: plainText(input.description, 300),
    url: productUrl,
    brand: { "@type": "Brand", name: plainText(siteConfig.name, 80) },
    offers:
      offerList.length > 1
        ? {
            "@type": "AggregateOffer",
            priceCurrency: siteConfig.commerce.currency,
            lowPrice: schemaPrice(Math.min(...input.offers!.map((offer) => offer.pricePaise).filter((value) => value > 0))),
            highPrice: schemaPrice(Math.max(...input.offers!.map((offer) => offer.pricePaise))),
            offerCount: offerList.length,
            offers: offerList,
          }
        : offerList.length === 1
          ? offerList[0]
          : {
              "@type": "Offer",
              priceCurrency: siteConfig.commerce.currency,
              price: schemaPrice(input.pricePaise),
              availability: AVAILABILITY[input.availability ?? ""] ?? "https://schema.org/PreOrder",
              url: productUrl,
            },
  };
  if (input.sku && offerList.length <= 1) data.sku = plainText(input.sku, 64);
  if (input.image && isSafeImageSrc(input.image)) {
    data.image = input.image.startsWith("http") ? input.image : `${siteConfig.url}${input.image}`;
  }
  if (input.rating && input.rating.count > 0 && input.rating.value >= 1 && input.rating.value <= 5) {
    data.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: input.rating.value,
      reviewCount: input.rating.count,
    };
  }
  return data;
}
