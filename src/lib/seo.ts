import type { Metadata } from "next";
import { siteConfig } from "@/config/site";

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
