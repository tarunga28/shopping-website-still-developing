"use client";

import { Heart, ShoppingBag, Truck, ShieldCheck, Leaf } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger, DialogDescription } from "@/components/ui/dialog";
import { Price } from "@/components/ui/price";
import { ProductImage } from "@/components/ui/product-image";
import { QuantitySelector } from "@/components/ui/quantity-selector";
import { Rating } from "@/components/ui/rating";
import { ComingSoonDialog } from "@/components/layout/coming-soon-dialog";
import { notify } from "@/lib/toast";
import type { ProductSummary } from "@/types";

/**
 * Quick view — real working preview of the sample catalogue item.
 * Selection + quantity logic is local UI state; purchase actions defer
 * to the commerce milestone's flows.
 */
export function QuickViewDialog({ product, trigger }: { product: ProductSummary; trigger: ReactNode }) {
  const [quantity, setQuantity] = useState(1);
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-2xl gap-0 overflow-hidden p-0">
        <div className="grid max-h-[80vh] grid-cols-1 overflow-y-auto sm:grid-cols-2 sm:overflow-visible">
          <div className="relative bg-sand p-4">
            <ProductImage
              src={product.image}
              alt={product.title}
              ratio="4:5"
              sizes="(max-width: 640px) 90vw, 320px"
              priority
              className="mx-auto max-w-xs sm:max-w-none"
            />
          </div>

          <div className="flex flex-col gap-4 p-6 sm:max-h-[80vh] sm:overflow-y-auto">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-smoke">{product.category}</p>
              <DialogTitle className="mt-2 text-2xl">{product.title}</DialogTitle>
              {product.rating ? <Rating value={product.rating.value} count={product.rating.count} size="md" className="mt-2" /> : null}
            </div>

            {product.blurb ? (
              <DialogDescription className="text-sm leading-relaxed">{product.blurb}</DialogDescription>
            ) : null}

            <div className="flex items-center gap-3">
              <Price amount={product.pricePaise} compareAt={product.compareAtPaise} size="lg" />
              {product.compareAtPaise && product.compareAtPaise > product.pricePaise ? (
                <Badge variant="sale">Launch price</Badge>
              ) : null}
            </div>

            <div className="flex items-center gap-3">
              <p id="qv-qty-label" className="text-[11px] font-semibold uppercase tracking-[0.14em] text-smoke">
                Qty
              </p>
              <QuantitySelector value={quantity} onValueChange={setQuantity} />
            </div>

            <div className="mt-1 flex flex-col gap-2.5">
              <ComingSoonDialog
                feature="Checkout opens at launch"
                description="Secure Razorpay checkout (UPI, cards, netbanking) goes live at launch. Join the waitlist and this piece is yours first."
                trigger={
                  <Button variant="primary" size="lg" className="w-full">
                    <ShoppingBag className="size-4" aria-hidden />
                    Add to cart
                  </Button>
                }
              />
              <Button
                variant="outline"
                size="md"
                className="w-full"
                onClick={() => notify.info("Wishlist saves at launch", "Sign in then to keep your favorites")}
              >
                <Heart className="size-4" aria-hidden />
                Save to wishlist
              </Button>
            </div>

            <ul className="mt-2 space-y-2 border-t border-clay pt-4 text-xs text-smoke">
              <li className="flex items-center gap-2">
                <Truck className="size-3.5 shrink-0 text-flame" aria-hidden />
                Printed to order · ships across India
              </li>
              <li className="flex items-center gap-2">
                <ShieldCheck className="size-3.5 shrink-0 text-flame" aria-hidden />
                Premium blanks, quality-checked piece by piece
              </li>
              <li className="flex items-center gap-2">
                <Leaf className="size-3.5 shrink-0 text-flame" aria-hidden />
                Made on demand — zero overstock
              </li>
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
