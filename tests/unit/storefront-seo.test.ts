import { describe, expect, it } from "vitest";
import { siteConfig } from "@/config/site";
import { filterScheduled } from "@/lib/schedule";
import { jsonLdScript, plainText } from "@/lib/plain-text";
import {
  breadcrumbJsonLd,
  buildMetadata,
  categoryMetadata,
  collectionMetadata,
  organizationJsonLd,
  productJsonLd,
  productMetadata,
  searchMetadata,
  websiteJsonLd,
} from "@/lib/seo";
import { categoryPath, collectionPath, productPath } from "@/lib/storefront-paths";
import { parsePublicSlug } from "@/lib/slug";

describe("storefront SEO", () => {
  it("builds a canonical homepage title, description and social image", () => {
    const meta = buildMetadata({
      title: "Original art, printed after you order",
      description: "Browse the catalogue.",
      path: "/",
      image: "/images/og.jpg",
    });
    expect(meta.alternates?.canonical).toBe(`${siteConfig.url}/`);
    expect(meta.description).toBe("Browse the catalogue.");
    expect(meta.openGraph?.images).toEqual([
      expect.objectContaining({ url: "/images/og.jpg", width: 1200, height: 630 }),
    ]);
  });

  it("emits slug canonicals and strips HTML from product, category and collection metadata", () => {
    const product = productMetadata({
      title: "<script>alert(1)</script> Grid Tee",
      description: "A <b>tee</b> &amp; a print",
      slug: "offbeat-grid-tee",
      image: "/images/products/tee.jpg",
    });
    expect(product.title).toBe("alert(1) Grid Tee");
    expect(String(product.description)).not.toContain("<");
    expect(product.alternates?.canonical).toBe(`${siteConfig.url}/product/offbeat-grid-tee`);

    expect(categoryMetadata({ title: "Mugs", slug: "mugs" }).alternates?.canonical).toBe(
      `${siteConfig.url}/category/mugs`,
    );
    expect(collectionMetadata({ title: "Wave", slug: "wave-study" }).alternates?.canonical).toBe(
      `${siteConfig.url}/collection/wave-study`,
    );
  });

  it("marks search results noindex and refuses unsafe structured-data injection", () => {
    const search = searchMetadata("<img src=x onerror=alert(1)>tees");
    expect(search.robots).toEqual({ index: false, follow: false });
    expect(String(search.title)).not.toContain("<");

    const org = organizationJsonLd();
    const site = websiteJsonLd();
    const crumbs = breadcrumbJsonLd([
      { name: "Home", path: "/" },
      { name: "Mugs", path: categoryPath("mugs") },
    ]);
    const product = productJsonLd({
      name: "Tee </script><script>alert(1)</script>",
      slug: "offbeat-grid-tee",
      pricePaise: 89900,
      availability: "in_stock",
      rating: { value: 4.8, count: 0 },
      image: "javascript:alert(1)",
    });

    expect(org["@type"]).toBe("Organization");
    expect(site["@type"]).toBe("WebSite");
    expect(site.potentialAction.target).toContain("/search?q={search_term_string}");
    expect(crumbs.itemListElement).toHaveLength(2);
    expect(product.offers).toEqual(expect.objectContaining({ price: "899.00", priceCurrency: "INR" }));
    expect(product.aggregateRating).toBeUndefined();
    expect(product.image).toBeUndefined();
    expect(jsonLdScript(product)).not.toContain("</");
    expect(plainText("<b>Hi</b>")).toBe("Hi");
  });

  it("uses public slug paths and ignores database ids", () => {
    expect(productPath("offbeat-grid-tee")).toBe("/product/offbeat-grid-tee");
    expect(categoryPath("t-shirts")).toBe("/category/t-shirts");
    expect(collectionPath("limited-drop")).toBe("/collection/limited-drop");
    expect(productPath("offbeat-grid-tee")).not.toContain("cuid");
    expect(parsePublicSlug("Offbeat-Grid-Tee")).toEqual({ slug: "offbeat-grid-tee", redirectToLower: true });
    expect(parsePublicSlug("../admin")).toEqual({ slug: null, redirectToLower: false });
  });

  it("hides inactive and expired campaigns", () => {
    const now = new Date("2026-09-29T12:00:00.000Z");
    const visible = filterScheduled(
      [
        { id: "live", active: true, message: "Live" },
        { id: "off", active: false, message: "Off" },
        { id: "future", active: true, startsAt: "2026-10-01T00:00:00.000Z", message: "Later" },
        { id: "ended", active: true, endsAt: "2026-09-01T00:00:00.000Z", message: "Ended" },
        { id: "bad", active: true, startsAt: "not-a-date", message: "Bad" },
      ],
      now,
    );
    expect(visible.map((item) => item.id)).toEqual(["live"]);
  });
});
