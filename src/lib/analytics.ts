/**
 * Storefront analytics interface.
 *
 * Events are named and typed so a later provider can subscribe.
 * Nothing is sent anywhere unless `registerAnalyticsSink` is called AND
 * the event's consent category is granted. This file never calls a
 * third-party endpoint.
 */

import { hasConsent, type ConsentCategory } from "@/lib/consent";

export const STOREFRONT_EVENTS = {
  HERO_CTA_CLICK: "HERO_CTA_CLICK",
  CATEGORY_CLICK: "CATEGORY_CLICK",
  PRODUCT_CLICK: "PRODUCT_CLICK",
  COLLECTION_CLICK: "COLLECTION_CLICK",
  NEWSLETTER_SIGNUP: "NEWSLETTER_SIGNUP",
  SEARCH_OPENED: "SEARCH_OPENED",
  ACCOUNT_OPENED: "ACCOUNT_OPENED",
  CART_OPENED: "CART_OPENED",
  WISHLIST_OPENED: "WISHLIST_OPENED",
  /** Catalog browsing. Payloads carry slugs, counts and filter *names* only — never PII. */
  CATALOG_VIEWED: "CATALOG_VIEWED",
  CATEGORY_VIEWED: "CATEGORY_VIEWED",
  COLLECTION_VIEWED: "COLLECTION_VIEWED",
  FILTER_APPLIED: "FILTER_APPLIED",
  FILTER_CLEARED: "FILTER_CLEARED",
  SORT_CHANGED: "SORT_CHANGED",
  PAGINATION_CLICKED: "PAGINATION_CLICKED",
  WISHLIST_CLICKED: "WISHLIST_CLICKED",
  /** Product page. Payloads carry slugs, option keys and counts only — never PII or prices the client typed. */
  PRODUCT_VIEWED: "PRODUCT_VIEWED",
  PRODUCT_IMAGE_VIEWED: "PRODUCT_IMAGE_VIEWED",
  VARIANT_SELECTED: "VARIANT_SELECTED",
  SIZE_SELECTED: "SIZE_SELECTED",
  COLOR_SELECTED: "COLOR_SELECTED",
  WISHLIST_ADDED: "WISHLIST_ADDED",
  WISHLIST_REMOVED: "WISHLIST_REMOVED",
  ADD_TO_CART_CLICKED: "ADD_TO_CART_CLICKED",
  SIZE_GUIDE_OPENED: "SIZE_GUIDE_OPENED",
} as const;

export type StorefrontEventName = (typeof STOREFRONT_EVENTS)[keyof typeof STOREFRONT_EVENTS];

export type AnalyticsValue = string | number | boolean | null;

export interface StorefrontEvent {
  name: StorefrontEventName;
  consent: ConsentCategory;
  payload?: Record<string, AnalyticsValue>;
}

export type AnalyticsSink = (event: StorefrontEvent) => void;

let sink: AnalyticsSink | null = null;

/** Future analytics provider entry point. No default implementation. */
export function registerAnalyticsSink(next: AnalyticsSink | null): void {
  sink = next;
}

export function trackStorefrontEvent(event: StorefrontEvent): void {
  if (!sink) return;
  // Analytics must never break the page: a failing sink or consent check is swallowed.
  try {
    if (!hasConsent(event.consent)) return;
    sink(event);
  } catch {
    /* intentionally ignored */
  }
}

export function trackFromDataset(element: Element): void {
  const name = element.getAttribute("data-track");
  if (!name || !(name in STOREFRONT_EVENTS)) return;
  const payload: Record<string, AnalyticsValue> = {};
  const id = element.getAttribute("data-track-id");
  const label = element.getAttribute("data-track-label");
  if (id) payload.id = id.slice(0, 80);
  if (label) payload.label = label.slice(0, 80);
  trackStorefrontEvent({
    name: name as StorefrontEventName,
    consent: "analytics",
    payload,
  });
}
