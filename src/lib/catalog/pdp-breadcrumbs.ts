import { categoryPath, collectionPath, productPath } from "@/lib/storefront-paths";
import type { PdpProductDTO } from "./pdp-dto";

export interface ProductCrumb {
  label: string;
  path: string;
}

/**
 * One deterministic trail per product (never depends on how the customer
 * arrived): the primary category chain, else its collection, else Shop.
 *   Home › Shop › Parent › Category › Product
 *   Home › Collections › Collection › Product
 */
export function buildProductBreadcrumbs(
  product: Pick<PdpProductDTO, "name" | "slug" | "categoryTrail" | "collection">,
): ProductCrumb[] {
  const base: ProductCrumb[] = [{ label: "Home", path: "/" }];
  if (product.categoryTrail.length > 0) {
    base.push({ label: "Shop", path: "/shop" });
    for (const category of product.categoryTrail) base.push({ label: category.name, path: categoryPath(category.slug) });
  } else if (product.collection) {
    base.push({ label: "Collections", path: "/collections" });
    base.push({ label: product.collection.name, path: collectionPath(product.collection.slug) });
  } else {
    base.push({ label: "Shop", path: "/shop" });
  }
  base.push({ label: product.name, path: productPath(product.slug) });
  return base;
}

/** Where "Browse Similar Products" leads when this product cannot be ordered. */
export function similarProductsHref(product: Pick<PdpProductDTO, "categoryTrail" | "collection">): string {
  const category = product.categoryTrail[product.categoryTrail.length - 1];
  if (category) return categoryPath(category.slug);
  if (product.collection) return collectionPath(product.collection.slug);
  return "/shop";
}
