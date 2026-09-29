import { ProductCard } from "@/components/ui/product-card";
import { toProductSummary } from "@/lib/catalog/dto";
import { logger } from "@/lib/logger";
import { productPath } from "@/lib/storefront-paths";
import { getRelatedProducts } from "@/services/catalog/related.service";
import { getSavedProductIds } from "@/services/storefront.service";

/** 4–8 related products, or nothing. A failure here never takes the page down. */
export async function RelatedProducts({ productId }: { productId: string }) {
  let items;
  try {
    items = await getRelatedProducts(productId);
  } catch (error) {
    logger.error("related products failed", { error: error instanceof Error ? error.message : "unknown" });
    return null;
  }
  if (items.length === 0) return null;
  const saved = new Set(await getSavedProductIds().catch(() => [] as string[]));

  return (
    <section aria-labelledby="related-heading">
      <h2 id="related-heading" className="font-display text-3xl font-extrabold uppercase">
        You may also like
      </h2>
      <ul className="mt-8 grid grid-cols-2 gap-x-3 gap-y-8 sm:gap-x-5 lg:grid-cols-4">
        {items.map((item) => (
          <li key={item.id} className="min-w-0">
            <ProductCard product={toProductSummary(item)} href={productPath(item.slug)} saved={saved.has(item.id)} />
          </li>
        ))}
      </ul>
    </section>
  );
}
