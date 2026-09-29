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
  if (!hasConsent(event.consent)) return;
  sink(event);
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
