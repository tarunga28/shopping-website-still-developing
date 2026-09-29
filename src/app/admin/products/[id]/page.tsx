import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminShell } from "@/components/layouts/admin-shell";
import { ProductForm } from "@/components/admin/product-form";
import { ImageRow, ImageUpload, PublishBar, SupplierForm, VariantForm, VariantRow } from "@/components/admin/product-tools";
import { ErrorState } from "@/components/ui/error-state";
import { estimateGrossMargin, paiseToInrInput } from "@/lib/catalog-rules";
import { formatPrice } from "@/lib/format";
import { requireCatalogEditor } from "@/server/auth/catalog-access";
import { getAdminProduct, listEditorOptions, sizesForProduct } from "@/services/catalog-admin.service";
import { NotFoundError } from "@/lib/errors";

export const dynamic = "force-dynamic";

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  await requireCatalogEditor();
  const { id } = await params;
  const loaded = await Promise.all([getAdminProduct(id), listEditorOptions()]).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    return "error" as const;
  });
  if (loaded === "error") {
    return (
      <AdminShell>
        <ErrorState kind="api" title="This product didn't load" description="Apply the catalog migration if this is a fresh database, then refresh." />
      </AdminShell>
    );
  }
  if (!loaded) notFound();
  const [detail, options] = loaded;
  const margin = estimateGrossMargin({
      sellingPaise: detail.product.basePrice,
      supplierCostPaise: detail.supplierCostPaise,
      shippingPaise: detail.product.estimatedShippingPaise,
      paymentFeePaise: detail.product.estimatedPaymentFeePaise,
      discountPaise: 0,
    });
    const sizes = sizesForProduct(detail.product.productType, options.sizes);
    return (
      <AdminShell>
        <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-smoke">{detail.product.status}</p>
            <h1 className="font-display text-3xl font-extrabold uppercase">{detail.product.name}</h1>
          </div>
          <Link href={`/admin/products/${id}/preview`} className="text-xs font-semibold uppercase tracking-[0.14em] underline decoration-flame underline-offset-4">
            Staff preview
          </Link>
        </header>
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <ProductForm
            options={{
              categories: options.categories.map((category) => ({ id: category.id, name: category.name, isActive: category.isActive })),
              collections: options.collections.map((collection) => ({ id: collection.id, name: collection.name })),
              designs: options.designs,
              sizes: options.sizes,
            }}
            values={{
              id: detail.product.id,
              name: detail.product.name,
              slug: detail.product.slug,
              shortDescription: detail.product.shortDescription ?? "",
              description: detail.product.description ?? "",
              productType: detail.product.productType,
              categoryIds: detail.categoryIds,
              primaryCategoryId: detail.primaryCategoryId ?? "",
              collectionIds: detail.collectionIds,
              tags: detail.tags.join(", "),
              basePrice: paiseToInrInput(detail.product.basePrice),
              compareAt: detail.product.compareAtPrice == null ? "" : paiseToInrInput(detail.product.compareAtPrice),
              seoTitle: detail.product.seoTitle ?? "",
              seoDescription: detail.product.seoDescription ?? "",
              adminNotes: detail.product.adminNotes ?? "",
              estimatedShipping: detail.product.estimatedShippingPaise == null ? "" : paiseToInrInput(detail.product.estimatedShippingPaise),
              estimatedPaymentFee: detail.product.estimatedPaymentFeePaise == null ? "" : paiseToInrInput(detail.product.estimatedPaymentFeePaise),
              supplierMappingRequired: detail.product.supplierMappingRequired,
              designId: detail.designId ?? "",
              placement: detail.placement,
            }}
          />
          <div className="grid content-start gap-4">
            <PublishBar id={detail.product.id} blockers={detail.blockers} status={detail.product.status} />
            <section className="rounded-card border-[1.5px] border-clay p-4 text-sm">
              <h2 className="font-display text-lg font-bold uppercase">Estimate</h2>
              <p className="mt-2 text-smoke">Selling price {formatPrice(detail.product.basePrice)}.</p>
              <p className="mt-1">
                {margin.complete && margin.estimatedGrossMarginPaise != null
                  ? `Estimated gross margin ${formatPrice(margin.estimatedGrossMarginPaise)}. Not profit.`
                  : "Estimated gross margin is incomplete until supplier cost, shipping and payment fee are all known."}
              </p>
              {detail.referenced ? <p className="mt-2 text-xs text-smoke">Orders or reviews reference this product. It cannot be deleted.</p> : null}
            </section>
            <ImageUpload productId={detail.product.id} />
            <ul className="grid gap-3">
              {detail.images.length === 0 ? <li className="text-sm text-smoke">No image yet. The product cannot be published without one.</li> : null}
              {detail.images.map((image) => (
                <li key={image.id} className="overflow-hidden rounded-card border border-clay">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={image.url} alt={image.altText || detail.product.name} className="aspect-[4/5] w-full object-cover" />
                  <div className="flex items-center justify-between gap-2 p-2 text-xs">
                    <span>{image.role} · {image.width ?? "?"}×{image.height ?? "?"}</span>
                    <ImageRow imageId={image.id} productId={detail.product.id} alt={image.altText} orderedIds={detail.images.map((item) => item.id)} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <section className="mt-8">
          <h2 className="font-display text-2xl font-extrabold uppercase">Variants</h2>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div>
              {detail.variants.length === 0 ? <p className="text-sm text-smoke">No variants yet.</p> : null}
              {detail.variants.map((variant) => (
                <VariantRow
                  key={variant.id}
                  variantId={variant.id}
                  productId={detail.product.id}
                  label={`${variant.sku} · ${variant.name} · ${formatPrice(variant.price)} · ${variant.availability}`}
                  colors={options.colors.map((color) => ({ name: color.name }))}
                  sizes={sizes}
                  values={{
                    sku: variant.sku,
                    name: variant.name,
                    size: variant.size ?? "",
                    color: variant.color ?? "",
                    price: paiseToInrInput(variant.price),
                    compareAt: variant.compareAtPrice == null ? "" : paiseToInrInput(variant.compareAtPrice),
                    availability: variant.availability,
                    weightGrams: variant.weightGrams == null ? "" : String(variant.weightGrams),
                  }}
                />
              ))}
            </div>
            <VariantForm productId={detail.product.id} colors={options.colors.map((color) => ({ name: color.name, hex: color.hex }))} sizes={sizes} />
            <SupplierForm
              productId={detail.product.id}
              variants={detail.variants.map((variant) => ({ id: variant.id, sku: variant.sku }))}
            />
          </div>
        </section>
      </AdminShell>
    );
}
