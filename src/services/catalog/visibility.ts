import { and, eq, sql, type SQL } from "drizzle-orm";
import { collections, products } from "@/db/schema";

/**
 * THE public-visibility rules. Every storefront read (lists, counts, facets,
 * detail page, sitemap, related products, API) applies these predicates in
 * SQL, so an ineligible product cannot reach a page, a cache entry or a
 * response — hiding it in React would not be enough.
 *
 * A product is publicly eligible only when ALL of these hold:
 *  - status = ACTIVE (DRAFT / ARCHIVED / DISCONTINUED are never public)
 *  - slug is URL-safe and well formed
 *  - a positive selling price and a non-empty name and description
 *  - at least one product image with a safe URL (https or same-site path)
 *  - at least one variant with a positive price (the purchasable unit)
 *  - no linked design that is REJECTED / ARCHIVED or copyright-RESTRICTED
 *
 * Products that reference no design (e.g. plain stock items) are unaffected
 * by the artwork rule.
 */

/** Same rule as `isSafeImageSrc`, expressed for SQL. `alias` is a trusted constant. */
function safeImageUrl(alias: string): SQL {
  const url = sql.raw(`${alias}.url`);
  return sql`(
    (${url} like '/%' and ${url} not like '//%' and position('://' in ${url}) = 0 and position(chr(92) in ${url}) = 0)
    or (${url} like 'https://%' and position(chr(92) in ${url}) = 0 and position(' ' in ${url}) = 0)
  )`;
}

export const SAFE_PRODUCT_IMAGE_SQL = safeImageUrl("i");

/** Product statuses whose detail page may be viewed. Kept in one place. */
export const PUBLIC_DETAIL_STATUSES = ["ACTIVE"] as const;

export function publicProductCondition(): SQL {
  return sql`(
    ${products.status} = 'ACTIVE'
    and ${products.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    and ${products.basePrice} > 0
    and length(btrim(${products.name})) > 0
    and (
      length(btrim(coalesce(${products.shortDescription}, ''))) > 0
      or length(btrim(coalesce(${products.description}, ''))) > 0
    )
    and exists (
      select 1 from images i
      where i.product_id = ${products.id} and i.type = 'PRODUCT' and ${SAFE_PRODUCT_IMAGE_SQL}
    )
    and exists (
      select 1 from product_variants pv
      where pv.product_id = ${products.id} and pv.price > 0
    )
    and ${artworkAllowedCondition()}
  )`;
}

/** No linked design that is REJECTED / ARCHIVED or copyright-RESTRICTED. */
function artworkAllowedCondition(): SQL {
  return sql`not exists (
      select 1 from product_designs pd
      join designs d on d.id = pd.design_id
      where pd.product_id = ${products.id}
        and (d.status in ('REJECTED', 'ARCHIVED') or d.copyright_status = 'RESTRICTED')
    )`;
}

/**
 * Detail-page identity for a directly requested URL. Deliberately looser than
 * `publicProductCondition` (which gates LISTINGS): an ACTIVE product that lost
 * its last image or variant after publishing still resolves, so the page can
 * say "currently unavailable" and offer similar products instead of a 404.
 * It is never listed, never purchasable, and marked noindex by the page.
 *
 * Still excluded everywhere: DRAFT / ARCHIVED / DISCONTINUED products, bad
 * slugs, non-positive prices and rejected / restricted artwork.
 */
export function pdpProductCondition(): SQL {
  return sql`(
    ${products.status} = 'ACTIVE'
    and ${products.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    and ${products.basePrice} > 0
    and length(btrim(${products.name})) > 0
    and ${artworkAllowedCondition()}
  )`;
}

/** A collection is public when ACTIVE and inside its optional schedule window. */
export function publicCollectionCondition(): SQL {
  return sql`(
    ${collections.status} = 'ACTIVE'
    and (${collections.startsAt} is null or ${collections.startsAt} <= now())
    and (${collections.endsAt} is null or ${collections.endsAt} > now())
  )`;
}

/** Detail-page identity check: the same visibility rules as listings. */
export function publicProductBySlug(slug: string): SQL {
  return and(eq(products.slug, slug), publicProductCondition()) as SQL;
}
