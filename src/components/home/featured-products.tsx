"use client";

import { useMemo } from "react";
import { Section, SectionHeader } from "@/components/layout/section";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProductCard } from "@/components/ui/product-card";
import { Badge } from "@/components/ui/badge";
import { EmptyProducts } from "@/components/ui/empty-state";
import { stableFlip } from "@/lib/utils";
import type { ProductSummary } from "@/types";

/**
 * Product showcase tabs — fed by the live catalog service.
 */
export function FeaturedProducts({ products }: { products: ProductSummary[] }) {
  const bestSellers = useMemo(
    () => [...products].sort((a, b) => (stableFlip(a.id) === stableFlip(b.id) ? 0 : stableFlip(a.id) ? -1 : 1)),
    [products],
  );

  if (products.length === 0) {
    return (
      <Section id="shop">
        <SectionHeader
          eyebrow="03 — The shop"
          title={<>Drops loading<span className="text-flame">.</span></>}
        />
        <EmptyProducts />
      </Section>
    );
  }

  return (
    <Section id="shop">
        <SectionHeader
          eyebrow="03 — The shop"
          title={
            <>
              Fresh drops,
              <br />
              hot off the press<span className="text-flame">.</span>
            </>
          }
          description="Every piece is printed to order — nothing here sits in a warehouse. Checkout opens at launch."
        />

      <Tabs defaultValue="new" className="w-full">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-4">
          <TabsList aria-label="Product collection filters">
            <TabsTrigger value="new">New arrivals</TabsTrigger>
            <TabsTrigger value="best">Best sellers</TabsTrigger>
          </TabsList>
          <Badge variant="soft">Checkout opens at launch</Badge>
        </div>

        <TabsContent value="new">
          <div className="grid grid-cols-2 gap-x-3 gap-y-8 sm:gap-x-5 lg:grid-cols-4">
            {products.map((product, index) => (
              <ProductCard key={product.id} product={product} priority={index < 4} />
            ))}
          </div>
        </TabsContent>

        <TabsContent value="best">
          <div className="grid grid-cols-2 gap-x-3 gap-y-8 sm:gap-x-5 lg:grid-cols-4">
            {bestSellers.map((product, index) => (
              <ProductCard key={product.id} product={product} priority={index < 4} />
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </Section>
  );
}
