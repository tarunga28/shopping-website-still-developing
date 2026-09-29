"use client";

import { toast } from "sonner";

/**
 * Notification presets — one import keeps toast copy, variants and
 * durations consistent across the whole product.
 */

const base = { duration: 3500 };

export const notify = {
  success: (message: string, description?: string) => toast.success(message, { ...base, description }),
  error: (message: string, description?: string) => toast.error(message, { ...base, description }),
  warning: (message: string, description?: string) => toast.warning(message, { ...base, description }),
  info: (message: string, description?: string) => toast.info(message, { ...base, description }),

  /* Commerce presets (currently fire local UI events; they will become
     real cart/wishlist flows in the commerce milestone). */
  addedToCart: (productName: string) => toast.success("Added to cart", { ...base, description: productName }),
  addedToWishlist: (productName: string) =>
    toast.success("Saved to wishlist", { ...base, description: productName }),
  removed: (itemLabel: string) => toast.info("Removed", { ...base, description: itemLabel }),
  couponApplied: (code: string) => toast.success("Coupon applied", { ...base, description: code.toUpperCase() }),
  genericError: () => toast.error("Something went wrong", { ...base, description: "Please try again." }),
};
