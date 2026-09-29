import { apiOk, withErrorHandling } from "@/lib/api-response";
import { listActiveCollections } from "@/services/catalog.service";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async () => {
  const collections = await listActiveCollections();
  return apiOk(
    collections.map((collection) => ({
      slug: collection.slug,
      name: collection.name,
      description: collection.description,
      productCount: collection.productCount,
    })),
  );
}, "catalog-collections");
