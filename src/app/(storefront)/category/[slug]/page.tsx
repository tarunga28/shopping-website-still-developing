import type { Metadata } from "next";
import { ListingPage, listingMetadata, type SearchParamsInput } from "@/components/catalog/listing-page";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParamsInput> };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { slug } = await params;
  return listingMetadata({ kind: "category", rawSlug: slug, searchParams: await searchParams });
}

export default async function CategoryPage({ params, searchParams }: Props) {
  const { slug } = await params;
  return ListingPage({ kind: "category", rawSlug: slug, searchParams: await searchParams });
}
