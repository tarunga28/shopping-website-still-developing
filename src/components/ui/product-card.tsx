"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, Heart, ShoppingBag } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Price } from "@/components/ui/price";
import { ProductImage } from "@/components/ui/product-image";
import { QuickViewDialog } from "@/components/cards/quick-view-dialog";
import { Rating } from "@/components/ui/rating";
import { ComingSoonDialog } from "@/components/layout/coming-soon-dialog";
import { toggleWishlistAction } from "@/server/actions/account-actions";
import { notify } from "@/lib/toast";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ProductBadge as ProductBadgeKind, ProductSummary } from "@/types";

const badgeMap: Record<ProductBadgeKind, { variant: "new" | "bestseller" | "sale" | "limited" | "sold-out"; label: string }> = {
  NEW: { variant: "new", label: "New" },
  BESTSELLER: { variant: "bestseller", label: "Bestseller" },
  SALE: { variant: "sale", label: "Sale" },
  LIMITED: { variant: "limited", label: "Limited" },
  LOW_STOCK: { variant: "limited", label: "Almost gone" },
  SOLD_OUT: { variant: "sold-out", label: "Sold out" },
};

const availabilityLabel: Record<NonNullable<ProductSummary["availability"]>, string | null> = {
  in_stock: null,
  low_stock: "Only a few left",
  sold_out: "Sold out",
  coming_soon: "Coming soon",
};

function discountPercent(pricePaise: number, compareAtPaise?: number): number | null {
  if (!compareAtPaise || compareAtPaise <= pricePaise) return null;
  return Math.round(((compareAtPaise - pricePaise) / compareAtPaise) * 100);
}

export interface ProductCardProps {
  product: ProductSummary;
  /** When PDP routes land, pass `href`; cards stay non-linked until then. */
  href?: string;
  /** Horizontal row layout for list views. */
  layout?: "grid" | "list";
  priority?: boolean;
}

/**
 * Commerce-ready product card. All purchase-adjacent actions are present
 * in the UI and wired to honest preview behaviors (quick view opens; cart/
 * wishlist announce launch states) until the commerce milestone lands.
 */
export function ProductCard({ product, href, layout = "grid", priority }: ProductCardProps) {
  const router = useRouter();
  const [wishlisted, setWishlisted] = useState(false);
  const [heartPending, setHeartPending] = useState(false);
  const soldOut = product.availability === "sold_out";
  const discount = discountPercent(product.pricePaise, product.compareAtPaise);
  const availabilityNote = product.availability ? availabilityLabel[product.availability] : null;

  async function onHeartClick(productId: string, productTitle: string) {
    if (heartPending) return;
    setHeartPending(true);
    const result = await toggleWishlistAction(productId);
    setHeartPending(false);
    if (result.ok) {
      setWishlisted(result.saved);
      if (result.saved) notify.addedToWishlist(productTitle);
      else notify.removed(productTitle);
      router.refresh();
      return;
    }
    if ("requiresLogin" in result && result.requiresLogin) {
      router.push(`/login?redirect=${encodeURIComponent("/account/wishlist")}`);
      return;
    }
    notify.error(result.error);
  }

  const media = (
    <div className="relative">
      <ProductImage
        src={product.image}
        hoverSrc={product.hoverImage}
        alt={product.title}
        priority={priority}
        imageClassName={soldOut ? "opacity-60 saturate-50" : undefined}
        sizes={
          layout === "list"
            ? "(max-width: 640px) 40vw, 220px"
            : "(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
        }
      />

      {/* Flag badges */}
      <div className="absolute left-3 top-3 z-10 flex flex-col items-start gap-1.5">
        {product.badge ? <Badge variant={badgeMap[product.badge].variant}>{badgeMap[product.badge].label}</Badge> : null}
        {discount ? <Badge variant="sale">−{discount}%</Badge> : null}
      </div>

      {/* Hover actions (desktop; always visible on touch via focus) */}
      <div className="absolute right-3 top-3 z-10 flex flex-col gap-2 opacity-100 transition-opacity duration-300 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
        <button
          type="button"
          aria-label={wishlisted ? `Remove ${product.title} from wishlist` : `Save ${product.title} to wishlist`}
          aria-pressed={wishlisted}
          aria-busy={heartPending}
          disabled={heartPending}
          onClick={() => onHeartClick(product.id, product.title)}
          className={cn(
            "flex size-9 items-center justify-center rounded-pill border-[1.5px] border-ink bg-paper transition-all hover:bg-ink hover:text-paper disabled:opacity-60",
            wishlisted && "bg-flame text-on-accent hover:bg-on-accent hover:text-flame",
          )}
        >
          <Heart className={cn("size-4", wishlisted && "fill-current")} aria-hidden />
        </button>
        <QuickViewDialog
          product={product}
          trigger={
            <button
              type="button"
              aria-label={`Quick view ${product.title}`}
              className="flex size-9 items-center justify-center rounded-pill border-[1.5px] border-ink bg-paper transition-all hover:bg-ink hover:text-paper"
            >
              <Eye className="size-4" aria-hidden />
            </button>
          }
        />
      </div>

      {/* Add-to-cart bar */}
      {!soldOut ? (
        <div className="absolute inset-x-3 bottom-3 z-10 translate-y-0 transition-all duration-300 md:translate-y-2 md:opacity-0 md:group-hover:translate-y-0 md:group-hover:opacity-100 md:group-focus-within:translate-y-0 md:group-focus-within:opacity-100">
          <ComingSoonDialog
            feature="Checkout opens at launch"
            description={`${product.title} will be purchasable at launch with secure Razorpay payments. Join the waitlist and we&apos;ll hold your size.`}
            trigger={
              <button
                type="button"
                className="flex h-10 w-full items-center justify-center gap-2 rounded-pill border-[1.5px] border-ink bg-ink text-[10px] font-semibold uppercase tracking-[0.16em] text-paper transition-colors hover:bg-flame hover:border-flame hover:text-on-accent"
              >
                <ShoppingBag className="size-3.5" aria-hidden />
                Add to cart — {formatPrice(product.pricePaise)}
              </button>
            }
          />
        </div>
      ) : null}
    </div>
  );

  const body = (
    <div className={cn("flex flex-col gap-1.5 px-1 pt-3", layout === "list" && "pt-0")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-smoke">{product.category}</p>
          <h3 className="mt-1 truncate font-display text-base font-bold leading-tight">{product.title}</h3>
        </div>
        {!soldOut ? (
          <Price amount={product.pricePaise} compareAt={product.compareAtPaise} className="shrink-0 pt-0.5" />
        ) : (
          <span className="font-mono text-xs text-smoke">Sold out</span>
        )}
      </div>
      {product.rating ? <Rating value={product.rating.value} count={product.rating.count} /> : null}
      {availabilityNote && !soldOut ? (
        <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-warning" role="status">{availabilityNote}</p>
      ) : null}
      {layout === "list" && product.blurb ? (
        <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-smoke">{product.blurb}</p>
      ) : null}
    </div>
  );

  const card = (
    <div className={cn("group", layout === "list" && "grid grid-cols-[7rem_1fr] items-start gap-4 sm:grid-cols-[13rem_1fr] sm:gap-6")}>
      {media}
      {body}
    </div>
  );

  if (href) {
    return (
      <Link href={href} className="group block focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-flame">
        {card}
      </Link>
    );
  }
  return card;
}
