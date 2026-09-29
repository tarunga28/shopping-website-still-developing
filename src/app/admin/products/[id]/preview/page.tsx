import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminShell } from "@/components/layouts/admin-shell";
import { Price } from "@/components/ui/price";
import { requireCatalogEditor } from "@/server/auth/catalog-access";
import { getAdminProduct } from "@/services/catalog-admin.service";
import { NotFoundError } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Unpublished preview",
  robots: { index: false, follow: false },
};

export default async function ProductPreviewPage({ params }: { params: Promise<{ id: string }> }) {
  await requireCatalogEditor();
  const { id } = await params;
  const detail = await getAdminProduct(id).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!detail) notFound();
  const unpublished = detail.product.status !== "ACTIVE";
  return (
      <AdminShell>
        <p className="rounded-card border-[1.5px] border-ink bg-cream px-4 py-3 text-sm" role="status">
          {unpublished
            ? `Staff preview. Status is ${detail.product.status}. This page is not indexed and is not a public product URL.`
            : "Staff preview of a published product. The public page is separate."}
        </p>
        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <div className="grid gap-3">
            {detail.images.length === 0 ? <p className="text-sm text-smoke">Missing image.</p> : null}
            {detail.images.map((image) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={image.id} src={image.url} alt={image.altText || detail.product.name} className="w-full rounded-card border border-clay object-cover" />
            ))}
          </div>
          <div>
            <h1 className="font-display text-4xl font-extrabold uppercase">{detail.product.name}</h1>
            <Price amount={detail.product.basePrice} compareAt={detail.product.compareAtPrice ?? undefined} size="lg" className="mt-4" />
            {detail.product.shortDescription ? <p className="mt-4 text-sm text-smoke">{detail.product.shortDescription}</p> : null}
            {detail.product.description ? <p className="mt-3 whitespace-pre-line text-sm text-smoke">{detail.product.description}</p> : null}
            <ul className="mt-6 flex flex-wrap gap-2">
              {detail.variants.map((variant) => (
                <li key={variant.id} className="rounded-full border border-clay px-3 py-2 text-xs">
                  {variant.name} · {variant.availability.replaceAll("_", " ")}
                </li>
              ))}
            </ul>
            {detail.product.status === "ACTIVE" ? (
              <Link href={`/product/${detail.product.slug}`} className="mt-6 inline-block text-xs font-semibold uppercase tracking-[0.14em] underline decoration-flame">
                Open public page
              </Link>
            ) : null}
          </div>
        </div>
      </AdminShell>
    );
}
