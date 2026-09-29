import type { Metadata } from "next";
import { ListingPage, listingMetadata, type SearchParamsInput } from "@/components/catalog/listing-page";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParamsInput> };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { slug } = await params;
  return listingMetadata({ kind: "collection", rawSlug: slug, searchParams: await searchParams });
}

export default async function CollectionPage({ params, searchParams }: Props) {
  const { slug } = await params;
  return ListingPage({ kind: "collection", rawSlug: slug, searchParams: await searchParams });
}
