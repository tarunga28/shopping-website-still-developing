import { apiOk, withErrorHandling } from "@/lib/api-response";
import { listStorefrontCategories } from "@/services/catalog.service";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async () => {
  const categories = await listStorefrontCategories();
  return apiOk(
    categories.map((category) => ({
      slug: category.slug,
      name: category.name,
      description: category.description,
      productCount: category.productCount,
    })),
  );
}, "catalog-categories");
