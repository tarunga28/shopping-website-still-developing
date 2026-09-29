import { apiOk, withErrorHandling } from "@/lib/api-response";
import { RateLimitError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { catalogQueryFromSearch, listCatalog } from "@/services/catalog-query.service";

export const dynamic = "force-dynamic";

const limiter = createRateLimiter({ limit: 60, windowMs: 60_000, namespace: "catalog-list" });

export const GET = withErrorHandling(async (request: Request) => {
  const { success } = limiter.check(clientIp(request));
  if (!success) throw new RateLimitError();
  const url = new URL(request.url);
  const page = await listCatalog(catalogQueryFromSearch(url.searchParams, "public"));
  return apiOk({
    items: page.items.map((item) => ({
      id: item.id,
      slug: item.slug,
      name: item.name,
      productType: item.productType,
      pricePaise: item.pricePaise,
      compareAtPaise: item.compareAtPaise,
      currency: item.currency,
      categoryName: item.categoryName,
      imageUrl: item.imageUrl,
      imageAlt: item.imageAlt,
      available: item.available,
    })),
    page: page.page,
    pageSize: page.pageSize,
    total: page.total,
    pagination: {
      page: page.page,
      pageSize: page.pageSize,
      total: page.total,
      totalPages: Math.max(1, Math.ceil(page.total / page.pageSize)),
    },
    sort: page.sort,
    popularityMeasured: page.popularityMeasured,
  });
}, "catalog-products");
