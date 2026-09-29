import type { Metadata } from "next";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { TrustIndicators } from "@/components/brand/trust-badges";
import { CatalogIntro } from "@/components/storefront/catalog-intro";
import { JsonLd } from "@/components/storefront/json-ld";
import { Container } from "@/components/ui/container";
import { catalogMetadata } from "@/lib/catalog/seo";
import { breadcrumbJsonLd } from "@/lib/seo";
import { parsePublicSlug } from "@/lib/slug";
import { loadCatalogListing, searchParamsToString, type ListingScope } from "@/services/catalog/listing.service";
import { getSavedProductIds } from "@/services/storefront.service";
import { CatalogListing } from "./catalog-listing";
import { CatalogLoadError } from "./catalog-states";

export type SearchParamsInput = Record<string, string | string[] | undefined>;

interface ListingRequest {
  kind: ListingScope["kind"];
  /** Raw route param (unused for /shop). */
  rawSlug?: string;
  searchParams: SearchParamsInput;
}

const BASE: Record<ListingScope["kind"], string> = { shop: "/shop", category: "/category", collection: "/collection" };

/** Validates the slug segment. Uppercase → permanent redirect to lowercase (query kept); junk → 404. */
function resolveSlugParam(request: ListingRequest, search: string): string {
  if (request.kind === "shop") return "";
  const parsed = parsePublicSlug(request.rawSlug ?? "");
  if (!parsed.slug) notFound();
  if (parsed.redirectToLower) permanentRedirect(`${BASE[request.kind]}/${parsed.slug}${search ? `?${search}` : ""}`);
  return parsed.slug;
}

export async function listingMetadata(request: ListingRequest): Promise<Metadata> {
  const search = searchParamsToString(request.searchParams);
  const parsedSlug = parsePublicSlug(request.rawSlug ?? "");
  if (request.kind !== "shop" && !parsedSlug.slug) return { title: "Not found", robots: { index: false, follow: false } };
  const listing = await loadCatalogListing(request.kind, parsedSlug.slug ?? "", search);
  if (listing.status === "ok") {
    return catalogMetadata({
      basePath: listing.basePath,
      title: listing.heading.seoTitle,
      description: listing.heading.seoDescription,
      image: listing.heading.image?.src,
      parsed: listing.parsed,
      page: listing.pagination.page,
      totalPages: listing.pagination.totalPages,
    });
  }
  // Not found / redirect / error: never indexable.
  return { title: request.kind === "shop" ? "Shop" : "Not found", robots: { index: false, follow: false } };
}

/**
 * NOTE: there is intentionally no `loading.tsx` above /shop, /category/[slug] or /collection/[slug].
 * A loading boundary makes Next flush a 200 before the page runs, so a missing category could no
 * longer answer 404 and a slug redirect would degrade to a meta-refresh. Correct status codes and
 * permanent redirects matter more for SEO here; in-page transitions use <ResultsRegion> instead.
 */
export async function ListingPage(request: ListingRequest) {
  const search = searchParamsToString(request.searchParams);
  const slug = resolveSlugParam(request, search);
  const listing = await loadCatalogListing(request.kind, slug, search);

  if (listing.status === "not-found") notFound();
  if (listing.status === "redirect") {
    if (listing.permanent) permanentRedirect(listing.to);
    redirect(listing.to);
  }
  if (listing.status === "error") {
    return (
      <Container className="py-16">
        <CatalogLoadError />
      </Container>
    );
  }

  const savedIds = await getSavedProductIds().catch(() => [] as string[]);
  const { heading } = listing;

  return (
    <>
      <JsonLd data={breadcrumbJsonLd(heading.jsonLdCrumbs)} />
      <CatalogIntro
        eyebrow={heading.eyebrow}
        title={heading.title}
        description={heading.description || undefined}
        crumbs={heading.crumbs}
        image={heading.image}
      />
      <Container className="py-10 md:py-14">
        <CatalogListing listing={listing} savedIds={savedIds} />
        {request.kind === "shop" ? <TrustIndicators variant="grid" className="mt-14" /> : null}
      </Container>
    </>
  );
}
