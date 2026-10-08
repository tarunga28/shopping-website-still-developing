import "server-only";
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  categories,
  categorySlugHistory,
  collections,
  collectionSlugHistory,
  images,
  productCategories,
  productCollections,
  products,
  reviews,
} from "@/db/schema";
import {
  ancestorsOf,
  buildPublicCategories,
  childrenOf,
  descendantIds,
  findCategory,
  type CategoryRow,
  type PublicCategory,
} from "@/lib/catalog/category-tree";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE,
  MAX_PAGE_SIZE,
  type CatalogSortKey,
} from "@/lib/catalog/constants";
import {
  toPublicProductDTO,
  type PublicProductDTO,
  type PublicProductSource,
} from "@/lib/catalog/dto";
import { buildPaginationMeta, type PaginationMeta } from "@/lib/catalog/pagination";
import { EMPTY_FILTERS, sortSizes, type CatalogFilters } from "@/lib/catalog/params";
import { NotFoundError } from "@/lib/errors";
import { isSafeImageSrc } from "@/lib/safe-url";
import { escapeLike, sanitizeSearchQuery } from "@/lib/slug";
import type { CatalogProductType } from "@/lib/catalog-rules";
import { publicCollectionCondition, publicProductCondition, SAFE_PRODUCT_IMAGE_SQL } from "./visibility";

/**
 * Public catalog reads. All customer-facing product/category/collection
 * queries live here so visibility, pagination and DTO shaping are enforced in
 * exactly one place. Uncached — see `./cached.ts` for the cached entry points.
 *
 * Query budget per listing page is constant regardless of page size:
 *   1 count + 1 page query + 5 batched hydrations (images, categories,
 *   collections, variant aggregates, review aggregates). No per-product queries.
 */

/* ── Types ────────────────────────────────────────────────────────────── */

export interface CatalogQueryInput {
  /** Category ids to include (a category plus its public descendants). */
  categoryIds?: string[];
  collectionId?: string | null;
  filters?: Partial<CatalogFilters>;
  page?: number;
  pageSize?: number;
  /** Optional free-text search. Plain substring match until the dedicated search milestone. */
  search?: string | null;
}

export interface CatalogProductsResult {
  products: PublicProductDTO[];
  pagination: PaginationMeta;
  sort: CatalogSortKey;
}

export interface PublicCollection {
  id: string;
  slug: string;
  name: string;
  description: string;
  seoTitle: string | null;
  seoDescription: string | null;
  image: { url: string; alt: string } | null;
  productCount: number;
}

export interface FacetOption {
  value: string;
  label: string;
  count: number;
  swatch?: string | null;
}

export interface CatalogFacets {
  types: FacetOption[];
  sizes: FacetOption[];
  colors: FacetOption[];
  price: { minPaise: number; maxPaise: number } | null;
  availability: { available: number; total: number };
}

/* ── SQL helpers ──────────────────────────────────────────────────────── */

function list(values: string[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

function clampPageNumber(value: number | undefined): number {
  if (!value || !Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, MAX_PAGE);
}

function clampSize(value: number | undefined): number {
  if (!value || !Number.isInteger(value) || value < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(value, MAX_PAGE_SIZE);
}

interface ConditionOptions {
  /** Facets ignore the facet's own dimension so options do not collapse. */
  omit?: Array<"type" | "variant" | "price">;
}

function conditions(input: CatalogQueryInput, options: ConditionOptions = {}): SQL {
  const filters = { ...EMPTY_FILTERS, ...input.filters };
  const omit = new Set(options.omit ?? []);
  const parts: SQL[] = [publicProductCondition()];

  if (input.categoryIds && input.categoryIds.length > 0) {
    parts.push(sql`exists (
      select 1 from product_categories fpc
      where fpc.product_id = ${products.id} and fpc.category_id in (${list(input.categoryIds)})
    )`);
  }
  if (input.collectionId) {
    parts.push(sql`exists (
      select 1 from product_collections fpl
      where fpl.product_id = ${products.id} and fpl.collection_id = ${input.collectionId}
    )`);
  }
  if (filters.type && !omit.has("type")) parts.push(eq(products.productType, filters.type));
  if (!omit.has("price")) {
    if (filters.minPricePaise !== null) parts.push(gte(products.basePrice, filters.minPricePaise));
    if (filters.maxPricePaise !== null) parts.push(lte(products.basePrice, filters.maxPricePaise));
  }
  if (!omit.has("variant") && (filters.sizes.length || filters.colors.length || filters.availableOnly)) {
    // One variant must satisfy every selected variant-level filter together
    // (size M *and* black), not each filter on a different variant.
    const variant: SQL[] = [sql`fv.product_id = ${products.id}`, sql`fv.price > 0`];
    if (filters.sizes.length) variant.push(sql`upper(fv.size) in (${list(filters.sizes)})`);
    if (filters.colors.length) variant.push(sql`lower(fv.color) in (${list(filters.colors)})`);
    if (filters.availableOnly) variant.push(sql`fv.availability in ('IN_STOCK', 'LOW_STOCK')`);
    parts.push(sql`exists (select 1 from product_variants fv where ${sql.join(variant, sql` and `)})`);
  }

  const search = sanitizeSearchQuery(input.search);
  if (search.length >= 2) {
    const pattern = `%${escapeLike(search)}%`;
    const match = or(
      ilike(products.name, pattern),
      ilike(products.shortDescription, pattern),
      sql`exists (
        select 1 from product_categories spc
        join categories sc on sc.id = spc.category_id
        where spc.product_id = ${products.id} and sc.is_active = true and sc.name ilike ${pattern}
      )`,
    );
    if (match) parts.push(match);
  }

  return sql.join(parts.map((part) => sql`(${part})`), sql` and `);
}

function orderBy(sort: CatalogSortKey, collectionId: string | null | undefined) {
  const newest = [sql`${products.publishedAt} desc nulls last`, desc(products.createdAt), desc(products.id)];
  switch (sort) {
    case "newest":
      return newest;
    case "price-asc":
      return [asc(products.basePrice), asc(products.id)];
    case "price-desc":
      return [desc(products.basePrice), asc(products.id)];
    case "name":
      return [asc(sql`lower(${products.name})`), asc(products.id)];
    case "featured":
    default:
      // No "featured" flag exists in the data model yet. Featured = the
      // merchandised order: a collection's own display order, otherwise newest.
      return collectionId
        ? [
            sql`(select fo.display_order from product_collections fo where fo.product_id = ${products.id} and fo.collection_id = ${collectionId}) asc nulls last`,
            ...newest,
          ]
        : newest;
  }
}

/* ── Product listing ──────────────────────────────────────────────────── */

export interface ListRow {
  id: string;
  slug: string;
  name: string;
  shortDescription: string | null;
  productType: CatalogProductType;
  basePrice: number;
  compareAtPrice: number | null;
  currency: string;
  publishedAt: Date | null;
}

export const listColumns = {
  id: products.id,
  slug: products.slug,
  name: products.name,
  shortDescription: products.shortDescription,
  productType: products.productType,
  basePrice: products.basePrice,
  compareAtPrice: products.compareAtPrice,
  currency: products.currency,
  publishedAt: products.publishedAt,
};

/** Batch-load everything the card needs for a page of products. */
export async function hydratePublicProducts(rows: ListRow[]): Promise<PublicProductDTO[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const idList = list(ids);

  const [imageRows, categoryRows, collectionRows, variantRows, reviewRows, publicTree] = await Promise.all([
    db.execute<{ product_id: string; url: string; alt_text: string; role: string }>(sql`
      select product_id, url, alt_text, role from (
        select i.product_id, i.url, i.alt_text, i.role,
          row_number() over (
            partition by i.product_id
            order by case i.role when 'PRIMARY' then 0 when 'GALLERY' then 1 when 'HOVER' then 3 else 2 end,
                     i.sort_order, i.id
          ) as rn
        from images i
        where i.product_id in (${idList}) and i.type = 'PRODUCT' and ${SAFE_PRODUCT_IMAGE_SQL}
      ) ranked
      where rn <= 3
    `),
    db
      .select({
        productId: productCategories.productId,
        categoryId: categories.id,
        name: categories.name,
        slug: categories.slug,
        isPrimary: productCategories.isPrimary,
      })
      .from(productCategories)
      .innerJoin(categories, and(eq(categories.id, productCategories.categoryId), eq(categories.isActive, true)))
      .where(inArray(productCategories.productId, ids))
      .orderBy(desc(productCategories.isPrimary), asc(categories.displayOrder), asc(categories.name)),
    db
      .select({
        productId: productCollections.productId,
        name: collections.name,
        slug: collections.slug,
      })
      .from(productCollections)
      .innerJoin(collections, and(eq(collections.id, productCollections.collectionId), publicCollectionCondition()))
      .where(inArray(productCollections.productId, ids))
      .orderBy(asc(collections.displayOrder), asc(collections.name)),
    db.execute<{ product_id: string; variant_count: number; orderable_count: number; out_count: number }>(sql`
      select v.product_id,
        count(*)::int as variant_count,
        (count(*) filter (where v.availability in ('IN_STOCK', 'LOW_STOCK')))::int as orderable_count,
        (count(*) filter (where v.availability = 'OUT_OF_STOCK'))::int as out_count
      from product_variants v
      where v.product_id in (${idList}) and v.price > 0
      group by v.product_id
    `),
    db
      .select({
        productId: reviews.productId,
        average: sql<number>`round(avg(${reviews.rating})::numeric, 1)::float`,
        count: sql<number>`count(*)::int`,
      })
      .from(reviews)
      .where(and(eq(reviews.status, "APPROVED"), inArray(reviews.productId, ids)))
      .groupBy(reviews.productId),
    // Small taxonomy table; needed so a card never links to a category whose ancestor is hidden (404).
    queryPublicCategories(),
  ]);
  const publicCategoryIds = new Set(publicTree.map((category) => category.id));

  const imagesBy = new Map<string, { url: string; alt: string; role: string }[]>();
  for (const row of imageRows.rows) {
    const bucket = imagesBy.get(row.product_id) ?? [];
    bucket.push({ url: row.url, alt: row.alt_text, role: row.role });
    imagesBy.set(row.product_id, bucket);
  }
  const categoryBy = new Map<string, { name: string; slug: string }>();
  for (const row of categoryRows) {
    if (publicCategoryIds.has(row.categoryId) && !categoryBy.has(row.productId)) {
      categoryBy.set(row.productId, { name: row.name, slug: row.slug });
    }
  }
  const collectionBy = new Map<string, { name: string; slug: string }>();
  for (const row of collectionRows) if (!collectionBy.has(row.productId)) collectionBy.set(row.productId, row);
  const variantBy = new Map(
    variantRows.rows.map((row) => [
      row.product_id,
      {
        variantCount: Number(row.variant_count),
        orderableCount: Number(row.orderable_count),
        outOfStockCount: Number(row.out_count),
      },
    ]),
  );
  const reviewBy = new Map(reviewRows.map((row) => [row.productId, row]));

  const out: PublicProductDTO[] = [];
  for (const row of rows) {
    const pics = imagesBy.get(row.id) ?? [];
    const primary = pics[0];
    // The visibility rule guarantees an image; if it vanished between the two
    // queries we drop the product instead of rendering a card with no picture.
    if (!primary) continue;
    const hover = pics.slice(1).find((pic) => pic.role === "HOVER") ?? pics[1] ?? null;
    const review = reviewBy.get(row.id);
    const source: PublicProductSource = {
      id: row.id,
      slug: row.slug,
      name: row.name,
      shortDescription: row.shortDescription?.trim() || null,
      productType: row.productType,
      basePricePaise: row.basePrice,
      compareAtPricePaise: row.compareAtPrice,
      currency: row.currency,
      publishedAt: row.publishedAt,
      image: { url: primary.url, alt: primary.alt },
      hoverImage: hover ? { url: hover.url, alt: hover.alt } : null,
      variants: variantBy.get(row.id),
      category: categoryBy.get(row.id) ?? null,
      collection: collectionBy.get(row.id) ?? null,
      rating: review && Number(review.count) > 0 ? { average: Number(review.average), count: Number(review.count) } : null,
    };
    out.push(toPublicProductDTO(source));
  }
  return out;
}

export async function queryPublicProducts(input: CatalogQueryInput): Promise<CatalogProductsResult> {
  const filters = { ...EMPTY_FILTERS, ...input.filters };
  const page = clampPageNumber(input.page ?? filters.page);
  const pageSize = clampSize(input.pageSize);
  const where = conditions(input);

  const [countRows, rows] = await Promise.all([
    db.select({ total: sql<number>`count(*)::int` }).from(products).where(where),
    db
      .select(listColumns)
      .from(products)
      .where(where)
      .orderBy(...orderBy(filters.sort, input.collectionId))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
  ]);

  const dtos = await hydratePublicProducts(rows);
  return {
    products: dtos,
    pagination: buildPaginationMeta({ page, pageSize, total: Number(countRows[0]?.total ?? 0), count: dtos.length }),
    sort: filters.sort,
  };
}

/**
 * One publicly eligible product, by id.
 *
 * Returns the same projection as the listing rather than the raw row, so an API
 * that fetches a single product cannot leak cost price, supplier references,
 * admin notes or the search vector. Reuses the listing hydration on purpose:
 * a second hydration path is how the card and the detail page drift apart.
 *
 * Returns null when the product does not exist OR is not publicly visible —
 * callers cannot distinguish the two, which is deliberate: a 404 that reveals
 * "this exists but is hidden" leaks unpublished catalog state.
 */
export async function getProductByIdPublic(id: string): Promise<PublicProductDTO | null> {
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) return null;

  const rows = await db
    .select(listColumns)
    .from(products)
    .where(and(eq(products.id, parsed.data), publicProductCondition()))
    .limit(1);

  if (rows.length === 0) return null;
  const [product] = await hydratePublicProducts(rows);
  return product ?? null;
}

/**
 * One publicly eligible product, by slug.
 *
 * Same contract as `getProductByIdPublic`. Kept separate rather than overloaded
 * because the callers differ: the slug form backs SEO URLs and needs to return
 * null (not throw) so the route can 404 cleanly.
 */
export async function getProductBySlugPublic(slug: string): Promise<PublicProductDTO | null> {
  const clean = slug.trim().toLowerCase();
  if (!clean || clean.length > 200) return null;

  const rows = await db
    .select(listColumns)
    .from(products)
    .where(and(eq(products.slug, clean), publicProductCondition()))
    .limit(1);

  if (rows.length === 0) return null;
  const [product] = await hydratePublicProducts(rows);
  return product ?? null;
}

/** Number of publicly eligible products. */
export async function getProductCount(input: CatalogQueryInput = {}): Promise<number> {
  const [row] = await db.select({ total: sql<number>`count(*)::int` }).from(products).where(conditions(input));
  return Number(row?.total ?? 0);
}

/* ── Facets (product-type aware) ──────────────────────────────────────── */

export async function queryCatalogFacets(input: CatalogQueryInput): Promise<CatalogFacets> {
  const typeWhere = conditions(input, { omit: ["type", "variant", "price"] });
  const scopedWhere = conditions(input, { omit: ["variant", "price"] });

  const [typeRows, sizeRows, colorRows, priceRows, availabilityRows] = await Promise.all([
    db.execute<{ product_type: CatalogProductType; n: number }>(sql`
      select products.product_type, count(*)::int as n from products where ${typeWhere}
      group by products.product_type order by n desc, products.product_type
    `),
    db.execute<{ size: string; n: number }>(sql`
      select upper(v.size) as size, count(distinct products.id)::int as n
      from products join product_variants v on v.product_id = products.id
      where ${scopedWhere} and v.size is not null and btrim(v.size) <> '' and v.price > 0
      group by upper(v.size) limit 40
    `),
    db.execute<{ color: string; label: string; swatch: string | null; n: number }>(sql`
      select lower(v.color) as color, min(v.color) as label, max(v.color_code) as swatch,
             count(distinct products.id)::int as n
      from products join product_variants v on v.product_id = products.id
      where ${scopedWhere} and v.color is not null and btrim(v.color) <> '' and v.price > 0
      group by lower(v.color) order by lower(v.color) limit 60
    `),
    db.execute<{ min_price: number | null; max_price: number | null }>(sql`
      select min(products.base_price) as min_price, max(products.base_price) as max_price
      from products where ${scopedWhere}
    `),
    db.execute<{ total: number; available: number }>(sql`
      select count(*)::int as total,
        (count(*) filter (where exists (
          select 1 from product_variants av
          where av.product_id = products.id and av.price > 0 and av.availability in ('IN_STOCK', 'LOW_STOCK')
        )))::int as available
      from products where ${scopedWhere}
    `),
  ]);

  const swatch = (value: string | null) => (value && /^#[0-9a-f]{6}$/i.test(value) ? value : null);
  const sizeCounts = new Map(sizeRows.rows.map((row) => [row.size, Number(row.n)]));
  const price = priceRows.rows[0];

  return {
    types: typeRows.rows.map((row) => ({ value: row.product_type, label: row.product_type, count: Number(row.n) })),
    sizes: sortSizes([...sizeCounts.keys()]).map((size) => ({
      value: size,
      label: size,
      count: sizeCounts.get(size) ?? 0,
    })),
    colors: colorRows.rows.map((row) => ({
      value: row.color,
      label: row.label,
      count: Number(row.n),
      swatch: swatch(row.swatch),
    })),
    price:
      price && price.min_price !== null && price.max_price !== null
        ? { minPaise: Number(price.min_price), maxPaise: Number(price.max_price) }
        : null,
    availability: {
      total: Number(availabilityRows.rows[0]?.total ?? 0),
      available: Number(availabilityRows.rows[0]?.available ?? 0),
    },
  };
}

/* ── Categories ───────────────────────────────────────────────────────── */

/** All public categories (active, ancestors active). Taxonomy is small and bounded. */
export async function queryPublicCategories(): Promise<PublicCategory[]> {
  const [rows, imageRows] = await Promise.all([
    db
      .select({
        id: categories.id,
        parentId: categories.parentId,
        slug: categories.slug,
        name: categories.name,
        description: categories.description,
        seoTitle: categories.seoTitle,
        seoDescription: categories.seoDescription,
        displayOrder: categories.displayOrder,
        isActive: categories.isActive,
      })
      .from(categories)
      .limit(1000),
    db
      .select({ categoryId: images.categoryId, url: images.url, alt: images.altText })
      .from(images)
      .where(and(inArray(images.type, ["CATEGORY", "BANNER"]), sql`${images.categoryId} is not null`))
      .orderBy(asc(images.sortOrder))
      .limit(2000),
  ]);
  const imageBy = new Map<string, { url: string; alt: string }>();
  for (const image of imageRows) {
    if (image.categoryId && !imageBy.has(image.categoryId) && isSafeImageSrc(image.url)) {
      imageBy.set(image.categoryId, { url: image.url, alt: image.alt });
    }
  }
  const withImages: CategoryRow[] = rows.map((row) => ({ ...row, image: imageBy.get(row.id) ?? null }));
  return buildPublicCategories(withImages);
}

/**
 * Exact publicly-visible product counts per category, including descendants
 * (a product filed in two sub-categories counts once for the parent).
 */
export async function queryCategoryProductCounts(): Promise<Record<string, { count: number; minPaise: number | null }>> {
  const result = await db.execute<{ root_id: string; n: number; min_price: number | null }>(sql`
    with recursive tree(root_id, id, depth) as (
      select c.id, c.id, 0 from categories c where c.is_active = true
      union all
      select t.root_id, c.id, t.depth + 1
      from tree t join categories c on c.parent_id = t.id
      where c.is_active = true and t.depth < 5
    )
    select t.root_id, count(distinct pc.product_id)::int as n, min(products.base_price) as min_price
    from tree t
    join product_categories pc on pc.category_id = t.id
    join products on products.id = pc.product_id
    where ${publicProductCondition()}
    group by t.root_id
  `);
  return Object.fromEntries(
    result.rows.map((row) => [
      row.root_id,
      { count: Number(row.n), minPaise: row.min_price === null ? null : Number(row.min_price) },
    ]),
  );
}

export type CategoryResolution =
  | { kind: "found"; category: PublicCategory; ancestors: PublicCategory[]; children: PublicCategory[]; scopeIds: string[] }
  | { kind: "redirect"; slug: string }
  | { kind: "missing" };

export function resolveCategoryFromTree(tree: PublicCategory[], slug: string): CategoryResolution {
  const category = findCategory(tree, slug);
  if (!category) return { kind: "missing" };
  return {
    kind: "found",
    category,
    ancestors: ancestorsOf(tree, category.id),
    children: childrenOf(tree, category.id),
    scopeIds: descendantIds(tree, category.id),
  };
}

function isMissingTable(error: unknown): boolean {
  const text = `${error instanceof Error ? error.message : ""} ${
    typeof error === "object" && error && "cause" in error ? String((error as { cause?: unknown }).cause) : ""
  }`;
  return text.includes("42P01") || text.includes("slug_history");
}

/** A renamed category keeps redirecting from its old slug (only to a currently public category). */
export async function queryCategorySlugRedirect(tree: PublicCategory[], slug: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ categoryId: categorySlugHistory.categoryId })
      .from(categorySlugHistory)
      .where(eq(categorySlugHistory.slug, slug))
      .limit(1);
    const target = row ? tree.find((category) => category.id === row.categoryId) : undefined;
    return target ? target.slug : null;
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

/* ── Collections ──────────────────────────────────────────────────────── */

async function collectionImages(ids: string[]): Promise<Map<string, { url: string; alt: string }>> {
  const map = new Map<string, { url: string; alt: string }>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({ collectionId: images.collectionId, url: images.url, alt: images.altText, type: images.type })
    .from(images)
    .where(and(inArray(images.collectionId, ids), inArray(images.type, ["BANNER", "COLLECTION"])))
    .orderBy(asc(images.sortOrder));
  // Banner artwork wins over a plain collection image.
  for (const kind of ["BANNER", "COLLECTION"] as const) {
    for (const row of rows) {
      if (row.type === kind && row.collectionId && !map.has(row.collectionId) && isSafeImageSrc(row.url)) {
        map.set(row.collectionId, { url: row.url, alt: row.alt });
      }
    }
  }
  return map;
}

async function collectionCounts(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const result = await db.execute<{ collection_id: string; n: number }>(sql`
    select pcl.collection_id, count(distinct products.id)::int as n
    from product_collections pcl
    join products on products.id = pcl.product_id
    where pcl.collection_id in (${list(ids)}) and ${publicProductCondition()}
    group by pcl.collection_id
  `);
  return new Map(result.rows.map((row) => [row.collection_id, Number(row.n)]));
}

const collectionColumns = {
  id: collections.id,
  slug: collections.slug,
  name: collections.name,
  description: collections.description,
  seoTitle: collections.seoTitle,
  seoDescription: collections.seoDescription,
};

async function toPublicCollections(
  rows: { id: string; slug: string; name: string; description: string | null; seoTitle: string | null; seoDescription: string | null }[],
): Promise<PublicCollection[]> {
  const ids = rows.map((row) => row.id);
  const [imageBy, countBy] = await Promise.all([collectionImages(ids), collectionCounts(ids)]);
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description?.trim() || "",
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
    image: imageBy.get(row.id) ?? null,
    productCount: countBy.get(row.id) ?? 0,
  }));
}

export async function queryPublicCollections(): Promise<PublicCollection[]> {
  const rows = await db
    .select(collectionColumns)
    .from(collections)
    .where(publicCollectionCondition())
    .orderBy(asc(collections.displayOrder), asc(collections.name))
    .limit(200);
  return toPublicCollections(rows);
}

export async function queryPublicCollectionBySlug(slug: string): Promise<PublicCollection | null> {
  const rows = await db
    .select(collectionColumns)
    .from(collections)
    .where(and(eq(collections.slug, slug), publicCollectionCondition()))
    .limit(1);
  return (await toPublicCollections(rows))[0] ?? null;
}

export async function queryCollectionSlugRedirect(slug: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ slug: collections.slug, status: collections.status, startsAt: collections.startsAt, endsAt: collections.endsAt })
      .from(collectionSlugHistory)
      .innerJoin(collections, eq(collections.id, collectionSlugHistory.collectionId))
      .where(and(eq(collectionSlugHistory.slug, slug), publicCollectionCondition()))
      .limit(1);
    return row?.slug ?? null;
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

/* ── Convenience entry points (spec'd names) ──────────────────────────── */

/** Resolve slugs then list. Used by the public API and future search. */
export async function getCatalogProducts(input: {
  category?: string | null;
  collection?: string | null;
  filters?: Partial<CatalogFilters>;
  sort?: CatalogSortKey;
  page?: number;
  pageSize?: number;
  search?: string | null;
}): Promise<CatalogProductsResult> {
  let categoryIds: string[] | undefined;
  let collectionId: string | null = null;
  if (input.category) {
    const resolved = resolveCategoryFromTree(await queryPublicCategories(), input.category);
    if (resolved.kind !== "found") throw new NotFoundError("That category is not available.");
    categoryIds = resolved.scopeIds;
  }
  if (input.collection) {
    const collection = await queryPublicCollectionBySlug(input.collection);
    if (!collection) throw new NotFoundError("That collection is not available.");
    collectionId = collection.id;
  }
  return queryPublicProducts({
    categoryIds,
    collectionId,
    filters: { ...input.filters, ...(input.sort ? { sort: input.sort } : {}) },
    page: input.page,
    pageSize: input.pageSize,
    search: input.search,
  });
}

export const getPublishedProducts = getCatalogProducts;

export function getProductsByCategory(category: string, options: Omit<Parameters<typeof getCatalogProducts>[0], "category"> = {}) {
  return getCatalogProducts({ ...options, category });
}

export function getProductsByCollection(collection: string, options: Omit<Parameters<typeof getCatalogProducts>[0], "collection"> = {}) {
  return getCatalogProducts({ ...options, collection });
}

export function getNewArrivals(limit = 8) {
  return queryPublicProducts({ filters: { sort: "newest" }, pageSize: Math.min(limit, MAX_PAGE_SIZE) });
}

export function getFeaturedProducts(limit = 8) {
  return queryPublicProducts({ filters: { sort: "featured" }, pageSize: Math.min(limit, MAX_PAGE_SIZE) });
}

/** Lean, unpaginated-by-UI list for the sitemap. Slug + timestamp only. */
export async function querySitemapProducts(limit = 5000): Promise<{ slug: string; updatedAt: Date }[]> {
  return db
    .select({ slug: products.slug, updatedAt: products.updatedAt })
    .from(products)
    .where(publicProductCondition())
    .orderBy(desc(products.updatedAt), asc(products.id))
    .limit(Math.min(limit, 45_000));
}
