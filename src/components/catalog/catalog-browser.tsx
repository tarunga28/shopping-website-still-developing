import Link from "next/link";
import { ProductCard } from "@/components/ui/product-card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { parseInrToPaise, PRODUCT_TYPES } from "@/lib/catalog-rules";
import { listCatalog, type CatalogListQuery } from "@/services/catalog-query.service";
import type { ProductSummary } from "@/types";

type Search = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function moneyParam(value: string): number | null {
  if (!value.trim()) return null;
  try {
    return parseInrToPaise(value);
  } catch {
    return null;
  }
}

export async function CatalogBrowser({
  pathname,
  searchParams,
  locked = {},
  categories = [],
  colors = [],
  sizes = [],
  title = "Published products",
  savedIds = [],
}: {
  pathname: string;
  searchParams: Search;
  locked?: Partial<Pick<CatalogListQuery, "category" | "collection" | "q">>;
  categories?: { slug: string; name: string }[];
  colors?: string[];
  sizes?: string[];
  title?: string;
  savedIds?: string[];
}) {
  const pageSizeRaw = Number(one(searchParams.pageSize));
  const page = Number(one(searchParams.page) || "1");
  const query: CatalogListQuery = {
    q: locked.q ?? one(searchParams.q),
    category: locked.category ?? one(searchParams.category),
    collection: locked.collection ?? one(searchParams.collection),
    type: one(searchParams.type),
    color: one(searchParams.color),
    size: one(searchParams.size),
    availability: one(searchParams.availability),
    tag: one(searchParams.tag),
    sort: one(searchParams.sort) || "newest",
    minPricePaise: moneyParam(one(searchParams.min)),
    maxPricePaise: moneyParam(one(searchParams.max)),
    page: Number.isInteger(page) ? page : 1,
    pageSize: pageSizeRaw === 50 || pageSizeRaw === 100 ? pageSizeRaw : 20,
    scope: "public",
  };

  let result;
  try {
    result = await listCatalog(query);
  } catch {
    return (
      <ErrorState
        kind="api"
        title="The catalogue didn't load"
        description="Refresh to try again. Nothing was changed."
      />
    );
  }

  const href = (patch: Record<string, string | null>) => {
    const params = new URLSearchParams();
    const current: Record<string, string> = {
      q: one(searchParams.q),
      category: locked.category ? "" : one(searchParams.category),
      type: one(searchParams.type),
      color: one(searchParams.color),
      size: one(searchParams.size),
      availability: one(searchParams.availability),
      tag: one(searchParams.tag),
      sort: one(searchParams.sort),
      min: one(searchParams.min),
      max: one(searchParams.max),
      pageSize: one(searchParams.pageSize),
      page: one(searchParams.page),
    };
    for (const [key, value] of Object.entries({ ...current, ...patch })) {
      if (value) params.set(key, value);
    }
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  const saved = new Set(savedIds);
  const cards: ProductSummary[] = result.items.map((item) => ({
    id: item.id,
    slug: item.slug,
    title: item.name,
    category: item.categoryName ?? "Inkline",
    pricePaise: item.pricePaise,
    compareAtPaise: item.compareAtPaise ?? undefined,
    image: item.imageUrl || "/images/art/mark.png",
    imageAlt: item.imageAlt || item.name,
    availability: item.available ? "in_stock" : "sold_out",
    badge: item.available ? undefined : "SOLD_OUT",
  }));
  const pageCount = Math.max(1, Math.ceil(result.total / result.pageSize));

  return (
    <div className="grid gap-8 lg:grid-cols-[16rem_1fr]">
      <FilterForm
        pathname={pathname}
        searchParams={searchParams}
        categories={locked.category ? [] : categories}
        colors={colors}
        sizes={sizes}
        lockedQuery={locked.q ?? undefined}
      />
      <div className="min-w-0">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-display text-2xl font-extrabold uppercase">{title}</h2>
            <p className="mt-1 text-sm text-smoke">
              {result.total} published {result.total === 1 ? "product" : "products"}
              {result.sort === "popularity" ? " · ordered by newest, because popularity is not measured yet" : null}
            </p>
          </div>
          <form action={pathname} className="flex items-center gap-2">
            {Object.entries(searchParams).map(([key, value]) =>
              key === "sort" || key === "page" || Array.isArray(value) || !value ? null : (
                <input key={key} type="hidden" name={key} value={value} />
              ),
            )}
            <label className="text-xs font-semibold uppercase tracking-[0.14em] text-smoke" htmlFor="catalog-sort">
              Sort
            </label>
            <select
              id="catalog-sort"
              name="sort"
              defaultValue={one(searchParams.sort) || "newest"}
              className="h-10 rounded-full border-[1.5px] border-clay bg-white px-3 text-sm"
            >
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="price-asc">Price: low to high</option>
              <option value="price-desc">Price: high to low</option>
              <option value="name">Name</option>
              <option value="popularity">Popularity (not measured)</option>
            </select>
            <button type="submit" className="h-10 rounded-full border-[1.5px] border-ink px-4 text-xs font-semibold uppercase tracking-[0.14em]">
              Apply
            </button>
          </form>
        </div>

        {cards.length === 0 ? (
          <EmptyState
            className="mt-8"
            title="No products match"
            description="Try another filter, or browse the full shop."
            action={{ label: "Clear filters", href: pathname }}
          />
        ) : (
          <ul className="mt-8 grid grid-cols-2 gap-x-3 gap-y-8 lg:grid-cols-3">
            {cards.map((product) => (
              <li key={product.id}>
                <ProductCard product={product} href={`/product/${product.slug}`} saved={saved.has(product.id)} />
              </li>
            ))}
          </ul>
        )}

        {pageCount > 1 ? (
          <nav aria-label="Pagination" className="mt-10 flex flex-wrap items-center gap-2">
            {result.page > 1 ? (
              <Link href={href({ page: String(result.page - 1) })} className="rounded-full border-[1.5px] border-ink px-4 py-2 text-xs font-semibold uppercase">
                Previous
              </Link>
            ) : null}
            <p className="text-sm text-smoke">
              Page {result.page} of {pageCount}
            </p>
            {result.page < pageCount ? (
              <Link href={href({ page: String(result.page + 1) })} className="rounded-full border-[1.5px] border-ink px-4 py-2 text-xs font-semibold uppercase">
                Next
              </Link>
            ) : null}
          </nav>
        ) : null}
      </div>
    </div>
  );
}

function FilterForm({
  pathname,
  searchParams,
  categories,
  colors,
  sizes,
  lockedQuery,
}: {
  pathname: string;
  searchParams: Search;
  categories: { slug: string; name: string }[];
  colors: string[];
  sizes: string[];
  lockedQuery?: string;
}) {
  const fields = (
    <div className="grid gap-3">
      {lockedQuery ? null : (
        <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke">
          Search
          <input name="q" defaultValue={one(searchParams.q)} className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm font-normal normal-case tracking-normal text-ink" />
        </label>
      )}
      <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke">
        Type
        <select name="type" defaultValue={one(searchParams.type)} className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm font-normal normal-case tracking-normal">
          <option value="">Any</option>
          {PRODUCT_TYPES.map((type) => (
            <option key={type} value={type}>
              {type.replaceAll("_", " ")}
            </option>
          ))}
        </select>
      </label>
      {categories.length > 0 ? (
        <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke">
          Category
          <select name="category" defaultValue={one(searchParams.category)} className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm font-normal normal-case tracking-normal">
            <option value="">Any</option>
            {categories.map((category) => (
              <option key={category.slug} value={category.slug}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {colors.length > 0 ? (
        <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke">
          Color
          <select name="color" defaultValue={one(searchParams.color)} className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm font-normal normal-case tracking-normal">
            <option value="">Any</option>
            {colors.map((color) => (
              <option key={color} value={color}>
                {color}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {sizes.length > 0 ? (
        <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke">
          Size
          <select name="size" defaultValue={one(searchParams.size)} className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm font-normal normal-case tracking-normal">
            <option value="">Any</option>
            {sizes.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke">
        Availability
        <select name="availability" defaultValue={one(searchParams.availability)} className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm font-normal normal-case tracking-normal">
          <option value="">Any</option>
          <option value="IN_STOCK">Available to print</option>
          <option value="LOW_STOCK">Low stock</option>
          <option value="OUT_OF_STOCK">Unavailable</option>
          <option value="PREORDER">Coming soon</option>
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke">
          Min ₹
          <input name="min" inputMode="decimal" defaultValue={one(searchParams.min)} className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm font-normal normal-case tracking-normal" />
        </label>
        <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke">
          Max ₹
          <input name="max" inputMode="decimal" defaultValue={one(searchParams.max)} className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm font-normal normal-case tracking-normal" />
        </label>
      </div>
      <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke">
        Per page
        <select name="pageSize" defaultValue={one(searchParams.pageSize) || "20"} className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm font-normal normal-case tracking-normal">
          <option value="20">20</option>
          <option value="50">50</option>
          <option value="100">100</option>
        </select>
      </label>
      <button type="submit" className="h-10 rounded-full bg-ink text-xs font-semibold uppercase tracking-[0.14em] text-paper">
        Filter
      </button>
    </div>
  );

  return (
    <>
      <details className="rounded-card border-[1.5px] border-clay p-4 lg:hidden">
        <summary className="cursor-pointer text-sm font-semibold">Filters</summary>
        <form action={pathname} className="mt-4">
          {fields}
        </form>
      </details>
      <form action={pathname} className="hidden lg:block">
        {fields}
      </form>
    </>
  );
}
