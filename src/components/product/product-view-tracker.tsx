"use client";

import { useEffect } from "react";
import { STOREFRONT_EVENTS, trackStorefrontEvent } from "@/lib/analytics";

/** Fires `PRODUCT_VIEWED` once per product. Slug only — no price, no customer data. */
export function ProductViewTracker({ slug }: { slug: string }) {
  useEffect(() => {
    trackStorefrontEvent({ name: STOREFRONT_EVENTS.PRODUCT_VIEWED, consent: "analytics", payload: { slug } });
  }, [slug]);
  return null;
}
