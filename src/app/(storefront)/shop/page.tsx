import type { Metadata } from "next";
import { ListingPage, listingMetadata, type SearchParamsInput } from "@/components/catalog/listing-page";

type Props = { searchParams: Promise<SearchParamsInput> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  return listingMetadata({ kind: "shop", searchParams: await searchParams });
}

export default async function ShopPage({ searchParams }: Props) {
  return ListingPage({ kind: "shop", searchParams: await searchParams });
}
