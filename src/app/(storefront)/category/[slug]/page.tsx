import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CatalogBrowser } from "@/components/catalog/catalog-browser";
import { CatalogIntro } from "@/components/storefront/catalog-intro";
import { JsonLd } from "@/components/storefront/json-ld";
import { Container } from "@/components/ui/container";
import { ErrorState } from "@/components/ui/error-state";
import { breadcrumbJsonLd, categoryMetadata } from "@/lib/seo";
import { resolveSlug } from "@/lib/storefront-route";
import { getCategoryBySlug } from "@/services/catalog.service";
import { listPublicFacets } from "@/services/catalog-query.service";
import { getSavedProductIds, loadSection } from "@/services/storefront.service";
import type { StorefrontCategory } from "@/types/storefront";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug: raw } = await params;
  const parsed = resolveSlug(raw, "/category");
  try {
    const category = await getCategoryBySlug(parsed);
    if (!category) return categoryMetadata({ title: "Category", slug: parsed, description: "This category is not published." });
    return categoryMetadata({
      title: category.seoTitle || category.name,
      description: category.seoDescription || category.description,
      slug: category.slug,
      image: category.image,
    });
  } catch {
    return categoryMetadata({ title: "Category", slug: parsed });
  }
}

export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug: raw } = await params;
  const slug = resolveSlug(raw, "/category");

  const categoryResult = await loadSection("category", () => getCategoryBySlug(slug), null as StorefrontCategory | null);
  if (categoryResult.status === "error") {
    return (
      <Container className="py-16">
        <ErrorState kind="api" title="This category didn't load" description="Refresh to try again. Other pages are unaffected." />
      </Container>
    );
  }
  if (!categoryResult.data) notFound();

  const category = categoryResult.data;
  const [paramsQuery, facets, savedIds] = await Promise.all([
    searchParams,
    listPublicFacets().catch(() => ({ colors: [], sizes: [] })),
    getSavedProductIds().catch(() => [] as string[]),
  ]);

  return (
    <>
      <JsonLd
        data={breadcrumbJsonLd([
          { name: "Home", path: "/" },
          { name: "Shop", path: "/shop" },
          { name: category.name, path: `/category/${category.slug}` },
        ])}
      />
      <CatalogIntro
        eyebrow="Category"
        title={category.name}
        description={category.description || undefined}
        crumbs={[
          { label: "Home", href: "/" },
          { label: "Shop", href: "/shop" },
          { label: category.name },
        ]}
      />
      <Container className="py-10 md:py-14">
        <CatalogBrowser
          pathname={`/category/${category.slug}`}
          searchParams={paramsQuery}
          locked={{ category: category.slug }}
          colors={facets.colors}
          sizes={facets.sizes}
          title={category.name}
          savedIds={savedIds}
        />
      </Container>
    </>
  );
}
