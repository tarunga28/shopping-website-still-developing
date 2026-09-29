"use client";

import { ShoppingBag } from "lucide-react";
import type { ReactNode } from "react";
import { ComingSoonDialog } from "@/components/layout/coming-soon-dialog";
import { storefrontContent } from "@/content/storefront";
import { siteConfig } from "@/config/site";
import { trackStorefrontEvent, STOREFRONT_EVENTS } from "@/lib/analytics";
import { cn } from "@/lib/utils";

/**
 * Cart entry point.
 * When the cart feature is off, there is no count — a zero badge would
 * imply a working cart. The dialog explains that checkout is not open.
 */
export function CartButton({
  count = null,
  className,
}: {
  /** Omit or pass null when the cart system is not connected. */
  count?: number | null;
  className?: string;
}) {
  const cartLive = siteConfig.features.cart;
  const showCount = cartLive && typeof count === "number";
  const label = showCount ? `Cart, ${count} ${count === 1 ? "item" : "items"}` : "Cart — checkout is not open yet";

  const trigger = (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() =>
        trackStorefrontEvent({ name: STOREFRONT_EVENTS.CART_OPENED, consent: "analytics" })
      }
      className={cn(
        "relative flex size-10 shrink-0 items-center justify-center rounded-pill border-[1.5px] border-ink bg-paper",
        "transition-all duration-300 hover:bg-ink hover:text-paper",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame",
        className,
      )}
    >
      <ShoppingBag className="size-4" aria-hidden />
      {showCount ? (
        <span className="absolute -right-1 -top-1 flex min-w-4 items-center justify-center rounded-pill bg-flame px-1 font-mono text-[9px] font-semibold text-on-accent">
          {count}
        </span>
      ) : null}
    </button>
  );

  if (cartLive) return trigger;

  return (
    <ComingSoonDialog
      feature={storefrontContent.cart.feature}
      description={storefrontContent.cart.description}
      trigger={trigger}
    />
  );
}

export function CartButtonSlot({ children }: { children?: ReactNode }) {
  return children ?? <CartButton />;
}
