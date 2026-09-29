import "server-only";
import { inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { products } from "@/db/schema";
import type { PublicProductDTO } from "@/lib/catalog/dto";
import { hydratePublicProducts, listColumns } from "./public-catalog.service";
import { publicProductCondition } from "./visibility";

/** The page shows 4–8 related products; callers cannot ask for more. */
export const MAX_RELATED = 8;

/**
 * Related products, ranked in ONE query by real catalog relationships:
 *   shared collection (4) > shared category (3) > same product type (1)
 *   + one point per shared tag.
 * Ties break by newest then id, so results are stable. The product itself is
 * excluded, rows are unique by construction, and only publicly listable
 * products qualify. Products with no relationship at all (score 0) are not
 * shown — the section is hidden instead of padded with unrelated items.
 */
export async function getRelatedProducts(productId: string, limit = MAX_RELATED): Promise<PublicProductDTO[]> {
  const id = z.string().uuid().safeParse(productId);
  if (!id.success) return [];
  const take = Math.min(Math.max(Math.trunc(limit) || 0, 1), MAX_RELATED);

  const ranked = await db.execute<{ id: string }>(sql`
    with me as (select id, product_type from products where id = ${id.data}),
    scored as (
      select ${products.id} as id, ${products.publishedAt} as published_at,
        (case when exists (
          select 1 from product_collections pc
          join product_collections mine on mine.collection_id = pc.collection_id and mine.product_id = me.id
          join collections c on c.id = pc.collection_id
            and c.status = 'ACTIVE'
            and (c.starts_at is null or c.starts_at <= now())
            and (c.ends_at is null or c.ends_at > now())
          where pc.product_id = ${products.id}
        ) then 4 else 0 end)
        + (case when exists (
          select 1 from product_categories pcat
          join product_categories mine on mine.category_id = pcat.category_id and mine.product_id = me.id
          where pcat.product_id = ${products.id}
        ) then 3 else 0 end)
        + (case when ${products.productType} = me.product_type then 1 else 0 end)
        + (select count(*)::int from product_tags pt
           join product_tags mine on mine.tag_id = pt.tag_id and mine.product_id = me.id
           where pt.product_id = ${products.id}) as score
      from ${products}, me
      where ${products.id} <> me.id and ${publicProductCondition()}
    )
    select id from scored
    where score > 0
    order by score desc, published_at desc nulls last, id
    limit ${take}
  `);
  const ids = ranked.rows.map((row) => row.id);
  if (ids.length === 0) return [];

  const rows = await db.select(listColumns).from(products).where(inArray(products.id, ids));
  const order = new Map(ids.map((value, index) => [value, index]));
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return hydratePublicProducts(rows);
}
