"use client";

import { useEffect } from "react";
import { STOREFRONT_EVENTS, trackStorefrontEvent, type StorefrontEventName } from "@/lib/analytics";

const EVENT_FOR_SURFACE: Record<"shop" | "category" | "collection", StorefrontEventName> = {
  shop: STOREFRONT_EVENTS.CATALOG_VIEWED,
  category: STOREFRONT_EVENTS.CATEGORY_VIEWED,
  collection: STOREFRONT_EVENTS.COLLECTION_VIEWED,
};

/** Fires one view event per listing render. No-ops safely when no analytics sink/consent exists. */
export function CatalogViewTracker({
  surface,
  slug,
  total,
  page,
  filterCount,
}: {
  surface: "shop" | "category" | "collection";
  slug: string | null;
  total: number;
  page: number;
  filterCount: number;
}) {
  useEffect(() => {
    try {
      trackStorefrontEvent({
        name: EVENT_FOR_SURFACE[surface],
        consent: "analytics",
        payload: { slug, total, page, filters: filterCount },
      });
    } catch {
      // Analytics must never affect browsing.
    }
  }, [surface, slug, total, page, filterCount]);
  return null;
}
