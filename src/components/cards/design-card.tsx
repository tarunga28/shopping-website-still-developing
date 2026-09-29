"use client";

import { Badge } from "@/components/ui/badge";
import { ProductImage } from "@/components/ui/product-image";
import { Price } from "@/components/ui/price";

/**
 * Design card — for the future artwork/design library where one design
 * maps onto many products. Data contract only; no backend yet.
 */
export function DesignCard({
  design,
}: {
  design: {
    id: string;
    title: string;
    artist: string;
    image: string;
    productsCount: number;
    fromPricePaise: number;
    status?: "draft" | "live";
  };
}) {
  return (
    <article className="group space-y-3">
      <div className="relative">
        <ProductImage src={design.image} alt={design.title} ratio="1:1" />
        {design.status === "draft" ? (
          <Badge variant="soft" className="absolute left-3 top-3 z-10">
            Draft
          </Badge>
        ) : null}
      </div>
      <div className="flex items-start justify-between gap-3 px-1">
        <div className="min-w-0">
          <h3 className="truncate font-display text-base font-bold leading-tight">{design.title}</h3>
          <p className="mt-0.5 text-xs text-smoke">
            by {design.artist} · {design.productsCount} products
          </p>
        </div>
        <Price amount={design.fromPricePaise} size="sm" className="shrink-0 pt-0.5" />
      </div>
    </article>
  );
}
