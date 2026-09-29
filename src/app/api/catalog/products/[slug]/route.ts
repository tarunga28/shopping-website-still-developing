import { apiOk, withErrorHandling } from "@/lib/api-response";
import { NotFoundError } from "@/lib/errors";
import { parsePublicSlug } from "@/lib/slug";
import { findProductSlugRedirect, getProductBySlug } from "@/services/catalog.service";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async (_request: Request, context: { params: Promise<{ slug: string }> }) => {
  const { slug: raw } = await context.params;
  const parsed = parsePublicSlug(raw);
  if (!parsed.slug) throw new NotFoundError("This product is not published.");
  const product = await getProductBySlug(parsed.slug);
  if (!product) {
    const redirectTo = await findProductSlugRedirect(parsed.slug);
    if (redirectTo) return apiOk({ redirectTo });
    throw new NotFoundError("This product is not published.");
  }
  return apiOk({
    slug: product.slug,
    name: product.title,
    description: product.description,
    pricePaise: product.pricePaise,
    compareAtPaise: product.compareAtPaise ?? null,
    currency: "INR",
    availability: product.catalogStatus === "DISCONTINUED" ? "DISCONTINUED" : product.availability,
    purchasable: product.catalogStatus !== "DISCONTINUED" && product.availability !== "sold_out",
    images: product.images.map((image) => ({
      src: image.src,
      alt: image.alt,
      width: image.width,
      height: image.height,
    })),
    variants: product.variants.map((variant) => ({
      name: variant.name,
      sku: variant.sku,
      size: variant.size,
      color: variant.color,
      availability: variant.availability,
      pricePaise: variant.pricePaise,
    })),
  });
}, "catalog-product");
