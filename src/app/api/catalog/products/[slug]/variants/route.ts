import { apiOk, withErrorHandling } from "@/lib/api-response";
import { NotFoundError } from "@/lib/errors";
import { parsePublicSlug } from "@/lib/slug";
import { getProductBySlug } from "@/services/catalog.service";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async (_request: Request, context: { params: Promise<{ slug: string }> }) => {
  const { slug: raw } = await context.params;
  const parsed = parsePublicSlug(raw);
  if (!parsed.slug) throw new NotFoundError("This product is not published.");
  const product = await getProductBySlug(parsed.slug);
  if (!product || product.catalogStatus === "DISCONTINUED") {
    throw new NotFoundError("Variants are only listed for published products.");
  }
  return apiOk({
    slug: product.slug,
    variants: product.variants.map((variant) => ({
      name: variant.name,
      sku: variant.sku,
      size: variant.size,
      color: variant.color,
      availability: variant.availability,
      pricePaise: variant.pricePaise,
    })),
  });
}, "catalog-variants");
