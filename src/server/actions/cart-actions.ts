"use server";

import { headers } from "next/headers";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import {
  getPurchasableVariant,
  type PurchasableFailure,
  type PurchasableItem,
} from "@/services/catalog/purchasable.service";

/**
 * Cart boundary (foundation only — there is no cart, checkout or payment yet).
 * It accepts three values from the browser — productId, variantId, quantity —
 * and answers with data read from the database. Price, totals, discount and
 * supplier cost are not inputs: any such field in the payload is ignored.
 */

export type ValidateCartLineResult =
  | { ok: true; item: PurchasableItem }
  | { ok: false; reason: PurchasableFailure | "RATE_LIMITED" | "ERROR"; message: string };

const limiter = createRateLimiter({ limit: 60, windowMs: 60_000, namespace: "cart-validate" });

const MESSAGES: Record<PurchasableFailure | "RATE_LIMITED" | "ERROR", string> = {
  INVALID_INPUT: "That selection isn't valid. Please choose your options again.",
  INVALID_QUANTITY: "Choose a quantity between 1 and 10.",
  NOT_FOUND: "This product or option is no longer available.",
  UNAVAILABLE: "This option is currently unavailable.",
  RATE_LIMITED: "Too many attempts. Please wait a moment and try again.",
  ERROR: "We couldn't check this item right now. Please try again.",
};

export async function validateCartLineAction(input: unknown): Promise<ValidateCartLineResult> {
  try {
    const request = new Request("http://internal.local/", { headers: await headers() });
    if (!limiter.check(clientIp(request)).success) {
      return { ok: false, reason: "RATE_LIMITED", message: MESSAGES.RATE_LIMITED };
    }
    // Only the three identifying fields are read; anything else is discarded.
    const source = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
    const result = await getPurchasableVariant({
      productId: source.productId,
      variantId: source.variantId,
      quantity: source.quantity,
    });
    if (result.ok) return { ok: true, item: result.item };
    return { ok: false, reason: result.reason, message: MESSAGES[result.reason] };
  } catch {
    return { ok: false, reason: "ERROR", message: MESSAGES.ERROR };
  }
}
