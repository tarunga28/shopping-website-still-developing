import type { MetadataRoute } from "next";
import { absoluteUrl } from "@/lib/seo";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Private/engine routes — present now or arriving with later milestones.
        disallow: ["/api/", "/account", "/admin", "/checkout", "/cart"],
      },
    ],
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
