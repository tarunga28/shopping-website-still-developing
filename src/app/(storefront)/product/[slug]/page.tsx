import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ShoppingBag } from "lucide-react";
import { ComingSoonDialog } from "@/components/layout/coming-soon-dialog";
import { JsonLd } from "@/components/storefront/json-ld";
import { WishlistButton } from "@/components/storefront/wishlist-button";
import { Badge } from "@/components/ui/badge";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { ErrorState } from "@/components/ui/error-state";
import { ImageGallery } from "@/components/ui/image-gallery";
import { Price } from "@/components/ui/price";
import { ProductCard } from "@/components/ui/product-card";
import { Rating } from "@/components/ui/rating";
import { storefrontContent } from "@/content/storefront";
import { plainText } from "@/lib/plain-text";
import { breadcrumbJsonLd, productJsonLd, productMetadata } from "@/lib/seo";
import { categoryPath, productPath } from "@/lib/storefront-paths";
import { resolveSlug } from "@/lib/storefront-route";
import { findProductSlugRedirect, getProductBySlug, listProductsByCategorySlug } from "@/services/catalog.service";
import { getSavedProductIds, loadSection } from "@/services/storefront.service";
import type { ProductSummary } from "@/types";
import type { ProductDetail } from "@/types/storefront";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug: raw } = await params;
  const slug = resolveSlug(raw, "/product");
  try {
    const product = await getProductBySlug(slug);
    if (!product) {
      const nextSlug = await findProductSlugRedirect(slug).catch(() => null);
      if (nextSlug) return productMetadata({ title: "Product", slug: nextSlug, description: "This product has a newer address." });
      return productMetadata({ title: "Product", slug, description: "This product is not published." });
    }
    return productMetadata({
      title: product.seoTitle || product.title,
      description: product.seoDescription || product.blurb || product.description,
      slug: product.slug,
      image: product.socialImage || product.images[0]?.src,
    });
  } catch {
    return productMetadata({ title: "Product", slug });
  }
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug: raw } = await params;
  const slug = resolveSlug(raw, "/product");

  const productResult = await loadSection("product", () => getProductBySlug(slug), null as ProductDetail | null);
  if (productResult.status === "error") {
    return (
      <Container className="py-16">
        <ErrorState kind="api" title="This product didn't load" description="Refresh to try again." />
      </Container>
    );
  }
  if (!productResult.data) {
    const nextSlug = await findProductSlugRedirect(slug).catch(() => null);
    if (nextSlug && nextSlug !== slug) redirect(productPath(nextSlug));
    notFound();
  }

  const product = productResult.data;
  const discontinued = product.catalogStatus === "DISCONTINUED";
  const [related, savedIds] = await Promise.all([
    product.categorySlug
      ? loadSection("related", () => listProductsByCategorySlug(product.categorySlug!), [] as ProductSummary[])
      : Promise.resolve({ data: [] as ProductSummary[], status: "empty" as const }),
    loadSection("product-saved", getSavedProductIds, [] as string[]),
  ]);
  const saved = new Set(savedIds.data);
  const more = related.data.filter((item) => item.slug !== product.slug).slice(0, 4);
  const description = plainText(product.description, 1200);

  return (
    <>
      <JsonLd
        data={[
          breadcrumbJsonLd([
            { name: "Home", path: "/" },
            { name: "Shop", path: "/shop" },
            ...(product.categorySlug
              ? [{ name: product.category, path: categoryPath(product.categorySlug) }]
              : []),
            { name: product.title, path: productPath(product.slug) },
          ]),
          productJsonLd({
            name: product.title,
            description: product.blurb || product.description,
            slug: product.slug,
            image: product.socialImage || product.images[0]?.src,
            pricePaise: product.pricePaise,
            sku: product.variants.find((variant) => variant.availability !== "sold_out")?.sku ?? product.variants[0]?.sku,
            availability: discontinued ? "discontinued" : product.availability,
            rating: product.rating,
          }),
        ]}
      />
      <Container className="py-8 md:py-12">
        <Breadcrumbs
          items={[
            { label: "Home", href: "/" },
            { label: "Shop", href: "/shop" },
            ...(product.categorySlug ? [{ label: product.category, href: categoryPath(product.categorySlug) }] : []),
            { label: product.title },
          ]}
        />

        <div className="mt-8 grid gap-10 lg:grid-cols-2 lg:gap-14">
          <ImageGallery images={product.images.map((image) => image.src)} alt={product.title} />
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-smoke">{product.category}</p>
            <h1 className="mt-2 font-display text-4xl font-extrabold uppercase leading-[0.95] sm:text-5xl">
              {product.title}
            </h1>
            {discontinued ? (
              <p className="mt-4 rounded-card border-[1.5px] border-ink bg-cream px-4 py-3 text-sm" role="status">
                This product is discontinued. It is not available for new purchases. Existing orders are unchanged.
              </p>
            ) : null}
            {product.rating ? (
              <Rating value={product.rating.value} count={product.rating.count} size="md" className="mt-4" />
            ) : (
              <p className="mt-4 text-sm text-smoke">No reviews yet.</p>
            )}
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Price amount={product.pricePaise} compareAt={product.compareAtPaise} size="lg" />
              {product.badge ? <Badge variant="soft">{product.badge.replaceAll("_", " ")}</Badge> : null}
              <Badge variant="outline">
                {product.availability === "in_stock"
                  ? "Available to print"
                  : product.availability === "low_stock"
                    ? "Low stock"
                    : product.availability === "sold_out"
                      ? "Unavailable"
                      : "Coming soon"}
              </Badge>
            </div>
            {product.blurb ? <p className="mt-5 max-w-prose text-base leading-relaxed text-smoke">{product.blurb}</p> : null}
            {description ? <p className="mt-3 max-w-prose whitespace-pre-line text-sm leading-relaxed text-smoke">{description}</p> : null}

            {product.variants.length > 0 ? (
              <div className="mt-6">
                <h2 className="font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">Options</h2>
                <ul className="mt-3 flex flex-wrap gap-2">
                  {product.variants.map((variant) => (
                    <li
                      key={variant.name}
                      className="rounded-pill border-[1.5px] border-clay px-3 py-2 text-xs"
                    >
                      <span className="font-semibold">{variant.name}</span>
                      <span className="ml-2 text-smoke">
                        {variant.availability === "sold_out" ? "Unavailable" : "Listed"}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-smoke">Selecting an option does not reserve it. Checkout is not open.</p>
              </div>
            ) : null}

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              {discontinued ? (
                <Button type="button" size="lg" className="w-full sm:w-auto" disabled>
                  Not available
                </Button>
              ) : (
                <ComingSoonDialog
                  feature={storefrontContent.cart.feature}
                  description={storefrontContent.cart.description}
                  trigger={
                    <Button type="button" size="lg" className="w-full sm:w-auto">
                      <ShoppingBag className="size-4" aria-hidden />
                      Add to cart
                    </Button>
                  }
                />
              )}
              <WishlistButton
                productId={product.id}
                productTitle={product.title}
                saved={saved.has(product.id)}
                label="Save"
              />
            </div>
            <p className="mt-4 text-xs leading-relaxed text-smoke">
              Printed after you order. Payments, shipping quotes and delivery dates are not available on this page.
            </p>
          </div>
        </div>

        {more.length > 0 ? (
          <section className="mt-16" aria-labelledby="related-heading">
            <div className="flex items-end justify-between gap-4">
              <h2 id="related-heading" className="font-display text-3xl font-extrabold uppercase">
                More in {product.category}
              </h2>
              {product.categorySlug ? (
                <Link href={categoryPath(product.categorySlug)} className="text-xs font-semibold uppercase tracking-[0.14em] underline decoration-flame underline-offset-4">
                  View category
                </Link>
              ) : null}
            </div>
            <ul className="mt-8 grid grid-cols-2 gap-x-3 gap-y-8 lg:grid-cols-4">
              {more.map((item) => (
                <li key={item.id}>
                  <ProductCard product={item} href={productPath(item.slug)} saved={saved.has(item.id)} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </Container>
    </>
  );
}
