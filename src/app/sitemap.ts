import type { MetadataRoute } from "next";
import { absoluteUrl } from "@/lib/seo";
import { categoryPath, collectionPath, productPath } from "@/lib/storefront-paths";
import {
  listActiveCollections,
  listSitemapProducts,
  listStorefrontCategories,
} from "@/services/catalog.service";

/**
 * Sitemap. Catalogue URLs are appended when the database answers.
 * A database miss still returns the static public routes.
 * Dynamic so a live database is read at request time, not frozen at build.
 */
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: absoluteUrl("/"), lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: absoluteUrl("/shop"), lastModified: now, changeFrequency: "daily", priority: 0.9 },
    { url: absoluteUrl("/categories"), lastModified: now, changeFrequency: "weekly", priority: 0.6 },
    { url: absoluteUrl("/collections"), lastModified: now, changeFrequency: "weekly", priority: 0.6 },
    { url: absoluteUrl("/search"), lastModified: now, changeFrequency: "weekly", priority: 0.3 },
    { url: absoluteUrl("/faqs"), lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: absoluteUrl("/legal/privacy"), lastModified: now, changeFrequency: "yearly", priority: 0.2 },
    { url: absoluteUrl("/legal/terms"), lastModified: now, changeFrequency: "yearly", priority: 0.2 },
    { url: absoluteUrl("/legal/shipping"), lastModified: now, changeFrequency: "monthly", priority: 0.4 },
    { url: absoluteUrl("/legal/refunds"), lastModified: now, changeFrequency: "monthly", priority: 0.4 },
  ];

  try {
    const [products, categories, collections] = await Promise.all([
      listSitemapProducts(5000),
      listStorefrontCategories(),
      listActiveCollections(),
    ]);
    return [
      ...staticRoutes,
      ...categories.map((category) => ({
        url: absoluteUrl(categoryPath(category.slug)),
        lastModified: now,
        changeFrequency: "weekly" as const,
        priority: 0.7,
      })),
      ...collections.map((collection) => ({
        url: absoluteUrl(collectionPath(collection.slug)),
        lastModified: now,
        changeFrequency: "weekly" as const,
        priority: 0.6,
      })),
      ...products.map((product) => ({
        url: absoluteUrl(productPath(product.slug)),
        lastModified: product.updatedAt,
        changeFrequency: "weekly" as const,
        priority: 0.8,
      })),
    ];
  } catch {
    return staticRoutes;
  }
}
