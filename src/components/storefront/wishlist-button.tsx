"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Heart } from "lucide-react";
import { toggleWishlistAction } from "@/server/actions/account-actions";
import { notify } from "@/lib/toast";
import { loginPath } from "@/lib/storefront-paths";
import { cn } from "@/lib/utils";

export function WishlistButton({
  productId,
  productTitle,
  saved = false,
  className,
  label,
}: {
  productId: string;
  productTitle: string;
  saved?: boolean;
  className?: string;
  /** Visible label. Omit for an icon button. */
  label?: string;
}) {
  const router = useRouter();
  const [on, setOn] = useState(saved);
  const [pending, setPending] = useState(false);

  async function onClick() {
    if (pending) return;
    setPending(true);
    const result = await toggleWishlistAction(productId);
    setPending(false);
    if (result.ok) {
      setOn(result.saved);
      if (result.saved) notify.addedToWishlist(productTitle);
      else notify.removed(productTitle);
      router.refresh();
      return;
    }
    if ("requiresLogin" in result && result.requiresLogin) {
      router.push(loginPath("/account/wishlist"));
      return;
    }
    notify.error(result.error);
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      aria-busy={pending}
      disabled={pending}
      aria-label={on ? `Remove ${productTitle} from wishlist` : `Save ${productTitle} to wishlist`}
      className={cn(
        "inline-flex min-h-10 items-center justify-center gap-2 rounded-pill border-[1.5px] border-ink bg-paper px-3 text-[10px] font-semibold uppercase tracking-[0.14em] transition-colors hover:bg-ink hover:text-paper disabled:opacity-60",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame",
        on && "bg-flame text-on-accent hover:bg-ink hover:text-paper",
        !label && "size-10 px-0",
        className,
      )}
    >
      <Heart className={cn("size-4", on && "fill-current")} aria-hidden />
      {label ? <span>{on ? "Saved" : label}</span> : null}
    </button>
  );
}
