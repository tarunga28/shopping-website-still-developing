import type { MetadataRoute } from "next";
import { absoluteUrl } from "@/lib/seo";

/**
 * Sitemap architecture. Static routes now; product/collection/category
 * URLs are appended from the database when the catalog ships.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  return [
    { url: absoluteUrl("/"), lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: absoluteUrl("/shop"), lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: absoluteUrl("/faqs"), lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: absoluteUrl("/legal/privacy"), lastModified: now, changeFrequency: "yearly", priority: 0.2 },
    { url: absoluteUrl("/legal/terms"), lastModified: now, changeFrequency: "yearly", priority: 0.2 },
    { url: absoluteUrl("/legal/shipping"), lastModified: now, changeFrequency: "monthly", priority: 0.4 },
    { url: absoluteUrl("/legal/refunds"), lastModified: now, changeFrequency: "monthly", priority: 0.4 },
  ];
}
