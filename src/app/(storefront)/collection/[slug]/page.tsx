import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CatalogBrowser } from "@/components/catalog/catalog-browser";
import { CatalogIntro } from "@/components/storefront/catalog-intro";
import { JsonLd } from "@/components/storefront/json-ld";
import { Container } from "@/components/ui/container";
import { ErrorState } from "@/components/ui/error-state";
import { breadcrumbJsonLd, collectionMetadata } from "@/lib/seo";
import { resolveSlug } from "@/lib/storefront-route";
import { getCollectionBySlug } from "@/services/catalog.service";
import { listPublicFacets } from "@/services/catalog-query.service";
import { getSavedProductIds, loadSection } from "@/services/storefront.service";
import type { StorefrontCollection } from "@/types/storefront";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug: raw } = await params;
  const parsed = resolveSlug(raw, "/collection");
  try {
    const collection = await getCollectionBySlug(parsed);
    if (!collection) {
      return collectionMetadata({ title: "Collection", slug: parsed, description: "This collection is not published." });
    }
    return collectionMetadata({
      title: collection.seoTitle || collection.name,
      description: collection.seoDescription || collection.description,
      slug: collection.slug,
      image: collection.image,
    });
  } catch {
    return collectionMetadata({ title: "Collection", slug: parsed });
  }
}

export default async function CollectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug: raw } = await params;
  const slug = resolveSlug(raw, "/collection");

  const collectionResult = await loadSection(
    "collection",
    () => getCollectionBySlug(slug),
    null as StorefrontCollection | null,
  );
  if (collectionResult.status === "error") {
    return (
      <Container className="py-16">
        <ErrorState kind="api" title="This collection didn't load" description="Refresh to try again." />
      </Container>
    );
  }
  if (!collectionResult.data) notFound();

  const collection = collectionResult.data;
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
          { name: collection.name, path: `/collection/${collection.slug}` },
        ])}
      />
      <CatalogIntro
        eyebrow="Collection"
        title={collection.name}
        description={collection.description || undefined}
        crumbs={[
          { label: "Home", href: "/" },
          { label: "Shop", href: "/shop" },
          { label: collection.name },
        ]}
      />
      <Container className="py-10 md:py-14">
        <CatalogBrowser
          pathname={`/collection/${collection.slug}`}
          searchParams={paramsQuery}
          locked={{ collection: collection.slug }}
          colors={facets.colors}
          sizes={facets.sizes}
          title={collection.name}
          savedIds={savedIds}
        />
      </Container>
    </>
  );
}
