import "server-only";
import { and, asc, desc, eq, gte, ilike, lte, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { products, productVariants } from "@/db/schema";
import {
  clampPage,
  clampPageSize,
  isProductStatus,
  isProductType,
  popularityIsMeasured,
  quoteAuthoritativePrice,
  type CatalogSort,
  type PageSize,
} from "@/lib/catalog-rules";
import { NotFoundError } from "@/lib/errors";
import { escapeLike, sanitizeSearchQuery } from "@/lib/slug";

export interface CatalogListQuery {
  q?: string | null;
  category?: string | null;
  collection?: string | null;
  type?: string | null;
  minPricePaise?: number | null;
  maxPricePaise?: number | null;
  color?: string | null;
  size?: string | null;
  availability?: string | null;
  status?: string | null;
  tag?: string | null;
  sort?: string | null;
  page?: number | null;
  pageSize?: number | null;
  scope: "public" | "admin";
}

export interface CatalogListItem {
  id: string;
  slug: string;
  name: string;
  productType: string;
  status: string;
  pricePaise: number;
  compareAtPaise: number | null;
  currency: string;
  categoryName: string | null;
  imageUrl: string | null;
  imageAlt: string | null;
  variantCount: number;
  available: boolean;
  updatedAt: string;
}

export interface CatalogListPage {
  items: CatalogListItem[];
  page: number;
  pageSize: PageSize;
  total: number;
  sort: CatalogSort;
  popularityMeasured: false;
}

const SORTS = new Set<CatalogSort>(["newest", "oldest", "price-asc", "price-desc", "name", "popularity"]);

function sortKey(value: string | null | undefined): CatalogSort {
  if (value && SORTS.has(value as CatalogSort)) return value as CatalogSort;
  return "newest";
}

function orderBy(sort: CatalogSort) {
  switch (sort) {
    case "oldest":
      return [asc(products.publishedAt), asc(products.name)];
    case "price-asc":
      return [asc(products.basePrice), asc(products.name)];
    case "price-desc":
      return [desc(products.basePrice), asc(products.name)];
    case "name":
      return [asc(products.name)];
    case "popularity":
    case "newest":
    default:
      return [desc(products.publishedAt), desc(products.createdAt)];
  }
}

function filters(query: CatalogListQuery): SQL | undefined {
  const parts: SQL[] = [];
  if (query.scope === "public") {
    parts.push(eq(products.status, "ACTIVE"));
  } else if (query.status && isProductStatus(query.status)) {
    parts.push(eq(products.status, query.status));
  }
  if (query.type && isProductType(query.type)) parts.push(eq(products.productType, query.type));
  if (query.minPricePaise != null && Number.isInteger(query.minPricePaise)) {
    parts.push(gte(products.basePrice, query.minPricePaise));
  }
  if (query.maxPricePaise != null && Number.isInteger(query.maxPricePaise)) {
    parts.push(lte(products.basePrice, query.maxPricePaise));
  }

  const q = sanitizeSearchQuery(query.q);
  if (q.length >= 2) {
    const pattern = `%${escapeLike(q)}%`;
    const match = or(
      ilike(products.name, pattern),
      ilike(products.slug, pattern),
      sql`exists (
        select 1 from product_variants v
        where v.product_id = ${products.id} and v.sku ilike ${pattern}
      )`,
      sql`exists (
        select 1 from product_tags pt
        join tags t on t.id = pt.tag_id
        where pt.product_id = ${products.id} and (t.slug ilike ${pattern} or t.name ilike ${pattern})
      )`,
      sql`exists (
        select 1 from product_categories pc
        join categories c on c.id = pc.category_id
        where pc.product_id = ${products.id} and c.name ilike ${pattern}
      )`,
    );
    if (match) parts.push(match);
  }

  if (query.category) {
    parts.push(sql`exists (
      select 1 from product_categories pc
      join categories c on c.id = pc.category_id
      where pc.product_id = ${products.id}
        and c.slug = ${query.category}
        and c.is_active = true
    )`);
  }
  if (query.collection) {
    const schedule =
      query.scope === "public"
        ? sql`and col.status = 'ACTIVE'
            and (col.starts_at is null or col.starts_at <= now())
            and (col.ends_at is null or col.ends_at > now())`
        : sql``;
    parts.push(sql`exists (
      select 1 from product_collections pcl
      join collections col on col.id = pcl.collection_id
      where pcl.product_id = ${products.id}
        and col.slug = ${query.collection}
        ${schedule}
    )`);
  }
  if (query.tag) {
    parts.push(sql`exists (
      select 1 from product_tags pt
      join tags t on t.id = pt.tag_id
      where pt.product_id = ${products.id} and t.slug = ${query.tag}
    )`);
  }
  if (query.color) {
    parts.push(sql`exists (
      select 1 from product_variants v
      where v.product_id = ${products.id} and lower(v.color) = lower(${query.color})
    )`);
  }
  if (query.size) {
    parts.push(sql`exists (
      select 1 from product_variants v
      where v.product_id = ${products.id} and upper(v.size) = upper(${query.size})
    )`);
  }
  if (query.availability) {
    parts.push(sql`exists (
      select 1 from product_variants v
      where v.product_id = ${products.id} and v.availability = ${query.availability}
    )`);
  }
  return parts.length ? and(...parts) : undefined;
}

export function catalogQueryFromSearch(params: URLSearchParams, scope: "public" | "admin"): CatalogListQuery {
  const pageSize = Number(params.get("pageSize"));
  const page = Number(params.get("page"));
  const min = params.get("minPricePaise");
  const max = params.get("maxPricePaise");
  return {
    q: params.get("q"),
    category: params.get("category"),
    collection: params.get("collection"),
    type: params.get("type"),
    minPricePaise: min && /^\d+$/.test(min) ? Number(min) : null,
    maxPricePaise: max && /^\d+$/.test(max) ? Number(max) : null,
    color: params.get("color"),
    size: params.get("size"),
    availability: params.get("availability"),
    status: scope === "admin" ? params.get("status") : null,
    tag: params.get("tag"),
    sort: params.get("sort"),
    page: Number.isInteger(page) ? page : 1,
    pageSize: pageSize === 50 || pageSize === 100 ? pageSize : 20,
    scope,
  };
}

/** Paginated catalog read. Public scope never selects notes, cost, or supplier fields. */
export async function listCatalog(query: CatalogListQuery): Promise<CatalogListPage> {
  const page = clampPage(query.page);
  const pageSize = clampPageSize(query.pageSize);
  const sort = sortKey(query.sort);
  const where = filters(query);
  const offset = (page - 1) * pageSize;

  const [countRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(products)
    .where(where);

  const rows = await db
    .select({
      id: products.id,
      slug: products.slug,
      name: products.name,
      productType: products.productType,
      status: products.status,
      pricePaise: products.basePrice,
      compareAtPaise: products.compareAtPrice,
      currency: products.currency,
      updatedAt: products.updatedAt,
      categoryName: sql<string | null>`(
        select c.name from product_categories pc
        join categories c on c.id = pc.category_id
        where pc.product_id = ${products.id}
        order by pc.is_primary desc, c.name
        limit 1
      )`,
      imageUrl: sql<string | null>`(
        select i.url from images i
        where i.product_id = ${products.id} and i.type = 'PRODUCT'
        order by case when i.role = 'PRIMARY' then 0 when i.role = 'HOVER' then 2 else 1 end, i.sort_order
        limit 1
      )`,
      imageAlt: sql<string | null>`(
        select i.alt_text from images i
        where i.product_id = ${products.id} and i.type = 'PRODUCT'
        order by case when i.role = 'PRIMARY' then 0 else 1 end, i.sort_order
        limit 1
      )`,
      variantCount: sql<number>`(
        select count(*)::int from product_variants v where v.product_id = ${products.id}
      )`,
      available: sql<boolean>`exists (
        select 1 from product_variants v
        where v.product_id = ${products.id} and v.availability in ('IN_STOCK', 'LOW_STOCK')
      )`,
    })
    .from(products)
    .where(where)
    .orderBy(...orderBy(sort))
    .limit(pageSize)
    .offset(offset);

  return {
    items: rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      productType: row.productType,
      status: row.status,
      pricePaise: row.pricePaise,
      compareAtPaise: row.compareAtPaise,
      currency: row.currency,
      categoryName: row.categoryName,
      imageUrl: row.imageUrl,
      imageAlt: row.imageAlt,
      variantCount: Number(row.variantCount ?? 0),
      available: Boolean(row.available),
      updatedAt: row.updatedAt.toISOString(),
    })),
    page,
    pageSize,
    total: Number(countRow?.total ?? 0),
    sort,
    popularityMeasured: popularityIsMeasured(),
  };
}

export async function listPublicFacets(): Promise<{ colors: string[]; sizes: string[] }> {
  const [colorRows, sizeRows] = await Promise.all([
    db.execute<{ color: string }>(sql`
      select distinct v.color as color
      from product_variants v
      join products p on p.id = v.product_id
      where p.status = 'ACTIVE' and v.color is not null
      order by v.color
      limit 40
    `),
    db.execute<{ size: string }>(sql`
      select distinct v.size as size
      from product_variants v
      join products p on p.id = v.product_id
      where p.status = 'ACTIVE' and v.size is not null
      order by v.size
      limit 20
    `),
  ]);
  return {
    colors: colorRows.rows.map((row) => row.color).filter(Boolean),
    sizes: sizeRows.rows.map((row) => row.size).filter(Boolean),
  };
}

export async function quoteSku(sku: string, clientPricePaise?: number | null) {
  const [row] = await db
    .select({
      sku: productVariants.sku,
      pricePaise: productVariants.price,
      availability: productVariants.availability,
      status: products.status,
      slug: products.slug,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(productVariants.sku, sku))
    .limit(1);

  if (!row || row.status !== "ACTIVE") {
    throw new NotFoundError("That option is not available to purchase.");
  }
  if (row.availability === "OUT_OF_STOCK" || row.availability === "PREORDER") {
    throw new NotFoundError("That option is not available to purchase.");
  }
  return {
    sku: row.sku,
    slug: row.slug,
    availability: row.availability,
    ...quoteAuthoritativePrice({ serverPricePaise: row.pricePaise, clientPricePaise }),
  };
}
