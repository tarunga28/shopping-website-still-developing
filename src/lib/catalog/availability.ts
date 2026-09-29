/**
 * Customer-facing availability for a print-on-demand catalog.
 *
 * There is no warehouse inventory and the supplier does not report stock yet,
 * so we never claim quantities. We only say what the database supports:
 *   AVAILABLE   – at least one variant is orderable
 *   UNAVAILABLE – every variant is explicitly marked out of stock
 *   UNKNOWN     – anything else (e.g. only pre-order variants, which checkout
 *                 does not support yet). We do not guess.
 */

export type ProductAvailabilityState = "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";

export interface VariantAvailabilityCounts {
  variantCount: number;
  /** Variants whose availability is IN_STOCK or LOW_STOCK. */
  orderableCount: number;
  outOfStockCount: number;
}

export function deriveAvailability(counts: VariantAvailabilityCounts | undefined): ProductAvailabilityState {
  if (!counts || counts.variantCount <= 0) return "UNKNOWN";
  if (counts.orderableCount > 0) return "AVAILABLE";
  if (counts.outOfStockCount >= counts.variantCount) return "UNAVAILABLE";
  return "UNKNOWN";
}

export const AVAILABILITY_LABELS: Record<ProductAvailabilityState, string> = {
  AVAILABLE: "Available",
  UNAVAILABLE: "Currently unavailable",
  UNKNOWN: "Availability not confirmed",
};
