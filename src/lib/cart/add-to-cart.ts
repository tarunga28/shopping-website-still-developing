import { quantitySchema } from "@/lib/catalog/quantity";
import { validateCartLineAction } from "@/server/actions/cart-actions";
import type { PurchasableItem } from "@/services/catalog/purchasable.service";

/**
 * The storefront's single "add to cart" entry point.
 *
 * The cart itself does not exist yet. This interface is what the product page
 * calls today, and what a real cart plugs into later via `registerCartAdapter`
 * without touching any page code. Until an adapter is registered the result is
 * CART_UNAVAILABLE: the selection has been verified by the server, but nothing
 * is stored and nothing pretends to be in a cart.
 */

export interface AddToCartInput {
  productId: string;
  variantId: string;
  quantity: number;
}

export type AddToCartResult =
  | { status: "ADDED"; item: PurchasableItem }
  | { status: "CART_UNAVAILABLE"; item: PurchasableItem }
  | { status: "REJECTED"; message: string };

/** Implemented by the future cart. It receives server-verified data only. */
export interface CartAdapter {
  addLine(item: PurchasableItem): Promise<{ ok: true } | { ok: false; message: string }>;
}

let adapter: CartAdapter | null = null;

export function registerCartAdapter(next: CartAdapter | null): void {
  adapter = next;
}

export async function addProductToCart(input: AddToCartInput): Promise<AddToCartResult> {
  if (!quantitySchema.safeParse(input.quantity).success) {
    return { status: "REJECTED", message: "Choose a quantity between 1 and 10." };
  }
  // Re-validated on the server: ids are looked up, price is read from the database.
  const verified = await validateCartLineAction({
    productId: input.productId,
    variantId: input.variantId,
    quantity: input.quantity,
  });
  if (!verified.ok) return { status: "REJECTED", message: verified.message };
  if (!adapter) return { status: "CART_UNAVAILABLE", item: verified.item };
  const added = await adapter.addLine(verified.item);
  return added.ok ? { status: "ADDED", item: verified.item } : { status: "REJECTED", message: added.message };
}
