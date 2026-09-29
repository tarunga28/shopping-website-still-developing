import { z } from "zod";

/** Per-line purchase cap. A POD site has no stock count; this is a sanity bound. */
export const MIN_QUANTITY = 1;
export const MAX_QUANTITY = 10;

/** Server-side quantity contract: a real integer between 1 and MAX_QUANTITY. */
export const quantitySchema = z.number().int().min(MIN_QUANTITY).max(MAX_QUANTITY);

/** Clamp UI input. Non-numbers fall back to the minimum instead of NaN. */
export function clampQuantity(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return MIN_QUANTITY;
  return Math.min(MAX_QUANTITY, Math.max(MIN_QUANTITY, Math.trunc(n)));
}
