// @vitest-environment node
/**
 * Catalog browsing against a real PostgreSQL database.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database that has the
 * schema applied (`npm run db:push`). Every fixture uses a unique prefix and is
 * removed afterwards, so it is safe next to seed data.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const revalidateTag = vi.fn();
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  // Passthrough: every call reads the database, so assertions see live rows.
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  revalidateTag,
  revalidatePath,
}));

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const P = `it9${randomBytes(3).toString("hex")}`;
const slug = (name: string) => `${P}-${name}`;

type Services = {
  db: typeof import("@/db").db;
  pool: typeof import("@/db").pool;
  schema: typeof import("@/db/schema");
  pub: typeof import("@/services/catalog/public-catalog.service");
  listing: typeof import("@/services/catalog/listing.service");
  admin: typeof import("@/services/catalog-admin.service");
  facade: typeof import("@/services/catalog.service");
  drizzle: typeof import("drizzle-orm");
};

describe.skipIf(!enabled)("catalog browsing (PostgreSQL)", () => {
  let s: Services;
  const ids: Record<string, string> = {};
  const catIds: Record<string, string> = {};
  const colIds: Record<string, string> = {};

  beforeAll(async () => {
    const [dbModule, schema, pub, listing, admin, facade, drizzle] = await Promise.all([
      import("@/db"),
      import("@/db/schema"),
      import("@/services/catalog/public-catalog.service"),
      import("@/services/catalog/listing.service"),
      import("@/services/catalog-admin.service"),
      import("@/services/catalog.service"),
      import("drizzle-orm"),
    ]);
    s = { db: dbModule.db, pool: dbModule.pool, schema, pub, listing, admin, facade, drizzle };
    const { db } = s;
    const { categories, collections, products, productVariants, images, productCategories, productCollections, designs, productDesigns } = schema;

    const insertCategory = async (key: string, values: Partial<typeof categories.$inferInsert> = {}) => {
      const [row] = await db.insert(categories).values({ name: `${P} ${key}`, slug: slug(key), ...values }).returning({ id: categories.id });
      catIds[key] = row!.id;
    };
    await insertCategory("cat-a");
    await insertCategory("cat-child", { parentId: catIds["cat-a"] });
    await insertCategory("cat-empty");
    await insertCategory("cat-off", { isActive: false });
    await insertCategory("cat-off-child", { parentId: catIds["cat-off"] });

    const past = new Date(Date.now() - 86_400_000);
    const future = new Date(Date.now() + 86_400_000 * 30);
    const insertCollection = async (key: string, values: Partial<typeof collections.$inferInsert>) => {
      const [row] = await db.insert(collections).values({ name: `${P} ${key}`, slug: slug(key), ...values }).returning({ id: collections.id });
      colIds[key] = row!.id;
    };
    await insertCollection("col-live", { status: "ACTIVE" });
    await insertCollection("col-empty", { status: "ACTIVE" });
    await insertCollection("col-draft", { status: "DRAFT" });
    await insertCollection("col-archived", { status: "ARCHIVED" });
    await insertCollection("col-future", { status: "ACTIVE", startsAt: future });
    await insertCollection("col-ended", { status: "ACTIVE", endsAt: past });

    type Spec = {
      key: string;
      status?: "ACTIVE" | "DRAFT" | "ARCHIVED" | "DISCONTINUED";
      type?: "T_SHIRT" | "HOODIE" | "MUG";
      price?: number;
      compareAt?: number | null;
      name?: string;
      image?: boolean;
      variants?: { size: string | null; color: string | null; availability?: "IN_STOCK" | "OUT_OF_STOCK" | "PREORDER" }[];
      cats?: string[];
      cols?: [string, number][];
      publishedDaysAgo?: number;
      design?: "REJECTED" | "PUBLISHED" | "RESTRICTED";
    };
    const specs: Spec[] = [
      { key: "tee", type: "T_SHIRT", price: 50_000, name: "Bravo Tee", variants: [{ size: "S", color: "black" }, { size: "M", color: "black" }], cats: ["cat-child"], cols: [["col-live", 1]], publishedDaysAgo: 3 },
      { key: "hoodie", type: "HOODIE", price: 150_000, name: "Alpha Hoodie", compareAt: 200_000, variants: [{ size: "M", color: "red" }, { size: "L", color: "red" }], cats: ["cat-a"], cols: [["col-live", 0]], publishedDaysAgo: 60 },
      { key: "mug", type: "MUG", price: 30_000, name: "Charlie Mug", variants: [{ size: null, color: null, availability: "OUT_OF_STOCK" }], cats: ["cat-a"], publishedDaysAgo: 1 },
      { key: "draft", status: "DRAFT", cats: ["cat-a"], cols: [["col-live", 5]] },
      { key: "archived", status: "ARCHIVED", cats: ["cat-a"], cols: [["col-live", 6]] },
      { key: "discontinued", status: "DISCONTINUED", cats: ["cat-a"], cols: [["col-live", 7]] },
      { key: "noimage", image: false, cats: ["cat-a"] },
      { key: "novariant", variants: [], cats: ["cat-a"] },
      { key: "rejected", design: "REJECTED", cats: ["cat-a"] },
      { key: "restricted", design: "RESTRICTED", cats: ["cat-a"] },
      { key: "approved", design: "PUBLISHED", type: "MUG", price: 45_000, name: "Delta Approved Mug", cats: ["cat-a"], publishedDaysAgo: 2 },
      { key: "inhidden", cats: ["cat-off-child"] },
      { key: "collectionDraft", cols: [["col-draft", 0], ["col-archived", 0], ["col-future", 0], ["col-ended", 0]] },
    ];

    for (const spec of specs) {
      const [product] = await db
        .insert(products)
        .values({
          name: spec.name ?? `${P} ${spec.key}`,
          slug: slug(spec.key),
          description: "A fixture product for catalog tests.",
          productType: spec.type ?? "T_SHIRT",
          status: spec.status ?? "ACTIVE",
          basePrice: spec.price ?? 99_900,
          compareAtPrice: spec.compareAt ?? null,
          adminNotes: `SECRET-ADMIN-NOTE-${P}`,
          estimatedShippingPaise: 7_777,
          publishedAt: new Date(Date.now() - (spec.publishedDaysAgo ?? 10) * 86_400_000),
        })
        .returning({ id: products.id });
      ids[spec.key] = product!.id;
      if (spec.image !== false) {
        await db.insert(images).values({ type: "PRODUCT", role: "PRIMARY", url: `/images/products/${spec.key}.jpg`, altText: "", productId: product!.id, storageKey: `private/${P}/${spec.key}` });
      }
      const variants = spec.variants ?? [{ size: "M", color: "black" }];
      for (const [index, variant] of variants.entries()) {
        await db.insert(productVariants).values({
          productId: product!.id,
          sku: `${P}-${spec.key}-${index}`.toUpperCase(),
          name: `${variant.color ?? "Std"} / ${variant.size ?? "Std"}`,
          size: variant.size,
          color: variant.color,
          price: spec.price ?? 99_900,
          availability: variant.availability ?? "IN_STOCK",
        });
      }
      for (const key of spec.cats ?? []) await db.insert(productCategories).values({ productId: product!.id, categoryId: catIds[key]!, isPrimary: true });
      for (const [key, order] of spec.cols ?? []) await db.insert(productCollections).values({ productId: product!.id, collectionId: colIds[key]!, displayOrder: order });
      if (spec.design) {
        const [design] = await db
          .insert(designs)
          .values({
            name: `${P} design ${spec.key}`,
            slug: slug(`design-${spec.key}`),
            status: spec.design === "RESTRICTED" ? "PUBLISHED" : spec.design,
            copyrightStatus: spec.design === "RESTRICTED" ? "RESTRICTED" : "ORIGINAL",
          })
          .returning({ id: designs.id });
        await db.insert(productDesigns).values({ productId: product!.id, designId: design!.id });
      }
    }
  });

  afterAll(async () => {
    if (!s) return;
    const { db, schema, drizzle } = s;
    const { like } = drizzle;
    await db.delete(schema.productSlugHistory).where(like(schema.productSlugHistory.slug, `${P}%`)).catch(() => undefined);
    await db.delete(schema.categorySlugHistory).where(like(schema.categorySlugHistory.slug, `${P}%`));
    await db.delete(schema.collectionSlugHistory).where(like(schema.collectionSlugHistory.slug, `${P}%`));
    await db.delete(schema.products).where(like(schema.products.slug, `${P}%`));
    await db.delete(schema.designs).where(like(schema.designs.slug, `${P}%`));
    await db.delete(schema.categories).where(like(schema.categories.slug, `${P}%`));
    await db.delete(schema.collections).where(like(schema.collections.slug, `${P}%`));
    await s.pool.end();
  });

  const slugsOf = (result: { products: { slug: string }[] }) => result.products.map((product) => product.slug.replace(`${P}-`, ""));
  const list = (input: Parameters<Services["pub"]["getCatalogProducts"]>[0]) => s.pub.getCatalogProducts({ pageSize: 48, ...input });

  /* ── visibility ─────────────────────────────────────────────────────── */

  it("shows only eligible ACTIVE products in a category (and its public children)", async () => {
    const result = await list({ category: slug("cat-a") });
    expect(slugsOf(result).sort()).toEqual(["approved", "hoodie", "mug", "tee"]);
    expect(result.pagination.total).toBe(4);
  });

  it.each(["draft", "archived", "discontinued", "noimage", "novariant", "rejected", "restricted"])(
    "never lists the %s product anywhere",
    async (key) => {
      const all = await s.pub.queryPublicProducts({ pageSize: 48, filters: { sort: "newest" } });
      expect(all.products.map((product) => product.slug)).not.toContain(slug(key));
      expect(await s.facade.getProductBySlug(slug(key))).toBeNull();
    },
  );

  it("lists an ACTIVE product from a non-public category in the shop, without exposing that category", async () => {
    const all = await s.pub.queryPublicProducts({ pageSize: 48, filters: { sort: "newest" } });
    const product = all.products.find((entry) => entry.slug === slug("inhidden"));
    expect(product).toBeDefined();
    expect(product?.category).toBeNull();
  });

  it("serves product detail for ACTIVE products only", async () => {
    expect(await s.facade.getProductBySlug(slug("tee"))).not.toBeNull();
    expect(await s.facade.getProductBySlug(slug("discontinued"))).toBeNull();
  });

  it("keeps sitemap output to eligible products", async () => {
    const entries = await s.pub.querySitemapProducts(5000);
    const listed = entries.map((entry) => entry.slug);
    expect(listed).toContain(slug("tee"));
    expect(listed).not.toContain(slug("draft"));
    expect(listed).not.toContain(slug("archived"));
  });

  /* ── categories / collections ──────────────────────────────────────── */

  it("rejects unknown, inactive and descendants-of-inactive categories", async () => {
    await expect(list({ category: slug("missing") })).rejects.toThrow();
    await expect(list({ category: slug("cat-off") })).rejects.toThrow();
    await expect(list({ category: slug("cat-off-child") })).rejects.toThrow();
  });

  it("only resolves ACTIVE, in-schedule collections", async () => {
    expect((await list({ collection: slug("col-live") })).pagination.total).toBe(2);
    for (const key of ["col-draft", "col-archived", "col-future", "col-ended", "nope"]) {
      await expect(list({ collection: slug(key) })).rejects.toThrow();
    }
  });

  it("answers 404 for hidden collections through the page loader", async () => {
    for (const key of ["col-draft", "col-archived", "col-future", "col-ended"]) {
      expect(await s.listing.loadCatalogListing("collection", slug(key), "")).toEqual({ status: "not-found" });
    }
  });

  it("returns an empty (not an error) result for an empty category and collection", async () => {
    const category = await s.listing.loadCatalogListing("category", slug("cat-empty"), "");
    expect(category.status).toBe("ok");
    if (category.status === "ok") {
      expect(category.products).toEqual([]);
      expect(category.scopeIsEmpty).toBe(true);
      expect(category.pagination.total).toBe(0);
    }
    const collection = await s.listing.loadCatalogListing("collection", slug("col-empty"), "");
    expect(collection.status === "ok" && collection.scopeIsEmpty).toBe(true);
  });

  it("distinguishes 'filters match nothing' from 'category is empty'", async () => {
    const result = await s.listing.loadCatalogListing("category", slug("cat-a"), "minPrice=99999");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.products).toEqual([]);
      expect(result.scopeIsEmpty).toBe(false);
    }
  });

  it("builds breadcrumbs with the parent chain", async () => {
    const result = await s.listing.loadCatalogListing("category", slug("cat-child"), "");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.heading.crumbs.map((crumb) => crumb.label)).toEqual(["Home", "Shop", `${P} cat-a`, `${P} cat-child`]);
      expect(result.heading.jsonLdCrumbs.at(-1)?.path).toBe(`/category/${slug("cat-child")}`);
    }
  });

  /* ── pagination ─────────────────────────────────────────────────────── */

  it("paginates in the database with accurate counts", async () => {
    const page1 = await list({ category: slug("cat-a"), pageSize: 3, filters: { sort: "name" } });
    const page2 = await list({ category: slug("cat-a"), pageSize: 3, page: 2, filters: { sort: "name" } });
    expect(page1.pagination).toMatchObject({ total: 4, totalPages: 2, page: 1, pageSize: 3, from: 1, to: 3 });
    expect(page1.products).toHaveLength(3);
    expect(page2.products).toHaveLength(1);
    expect(page2.pagination).toMatchObject({ from: 4, to: 4 });
    expect(new Set([...slugsOf(page1), ...slugsOf(page2)]).size).toBe(4);
  });

  it("caps the page size", async () => {
    const result = await s.pub.queryPublicProducts({ pageSize: 100_000 });
    expect(result.pagination.pageSize).toBeLessThanOrEqual(48);
  });

  it("redirects an out-of-range page back into range instead of erroring", async () => {
    const result = await s.listing.loadCatalogListing("category", slug("cat-a"), "page=40");
    expect(result).toEqual({ status: "redirect", to: `/category/${slug("cat-a")}`, permanent: false });
  });

  it("treats a malformed page as page 1", async () => {
    const result = await s.listing.loadCatalogListing("category", slug("cat-a"), "page=abc");
    expect(result.status === "ok" && result.pagination.page).toBe(1);
  });

  /* ── sorting ────────────────────────────────────────────────────────── */

  it("sorts by price, name and newest deterministically", async () => {
    const scope = { category: slug("cat-a") };
    expect(slugsOf(await list({ ...scope, filters: { sort: "price-asc" } }))).toEqual(["mug", "approved", "tee", "hoodie"]);
    expect(slugsOf(await list({ ...scope, filters: { sort: "price-desc" } }))).toEqual(["hoodie", "tee", "approved", "mug"]);
    expect(slugsOf(await list({ ...scope, filters: { sort: "name" } }))).toEqual(["hoodie", "tee", "mug", "approved"]);
    expect(slugsOf(await list({ ...scope, filters: { sort: "newest" } }))).toEqual(["mug", "approved", "tee", "hoodie"]);
  });

  it("orders a collection by its curated display order when 'featured'", async () => {
    const result = await list({ collection: slug("col-live"), filters: { sort: "featured" } });
    expect(slugsOf(result)).toEqual(["hoodie", "tee"]);
  });

  /* ── filters ────────────────────────────────────────────────────────── */

  it("filters by product type", async () => {
    expect(slugsOf(await list({ category: slug("cat-a"), filters: { type: "MUG", sort: "name" } }))).toEqual(["mug", "approved"]);
  });

  it("filters by price range in paise", async () => {
    const result = await list({ category: slug("cat-a"), filters: { minPricePaise: 40_000, maxPricePaise: 100_000, sort: "price-asc" } });
    expect(slugsOf(result)).toEqual(["approved", "tee"]);
  });

  it("supports multi-value size and colour filters", async () => {
    expect(slugsOf(await list({ category: slug("cat-a"), filters: { sizes: ["S", "L"], sort: "name" } }))).toEqual(["hoodie", "tee"]);
    expect(slugsOf(await list({ category: slug("cat-a"), filters: { colors: ["red"] } }))).toEqual(["hoodie"]);
    expect(slugsOf(await list({ category: slug("cat-a"), filters: { colors: ["red", "black"], sort: "name" } }))).toEqual(["hoodie", "tee", "approved"]);
  });

  it("matches size and colour on the same variant", async () => {
    // Tee has S/black and M/black; hoodie has M/red and L/red. Nothing is S + red.
    expect((await list({ category: slug("cat-a"), filters: { sizes: ["S"], colors: ["red"] } })).pagination.total).toBe(0);
    expect(slugsOf(await list({ category: slug("cat-a"), filters: { sizes: ["M"], colors: ["red"] } }))).toEqual(["hoodie"]);
  });

  it("filters by availability without inventing stock", async () => {
    const all = await list({ category: slug("cat-a") });
    expect(all.products.find((product) => product.slug === slug("mug"))?.availability).toBe("UNAVAILABLE");
    const available = await list({ category: slug("cat-a"), filters: { availableOnly: true } });
    expect(slugsOf(available)).not.toContain("mug");
  });

  it("applies URL filters through the page loader and ignores hostile values", async () => {
    const result = await s.listing.loadCatalogListing(
      "category",
      slug("cat-a"),
      "sort=hack&size=INVALID&minPrice=hello&color=%3Cscript%3E&category=../../x&page=-1&type=nonsense",
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.pagination.total).toBe(4);
  });

  it("offers only facets that exist in the current listing", async () => {
    const facets = await s.pub.queryCatalogFacets({ categoryIds: [catIds["cat-a"]!, catIds["cat-child"]!] });
    expect(facets.types.map((type) => type.value).sort()).toEqual(["HOODIE", "MUG", "T_SHIRT"]);
    expect(facets.colors.map((color) => color.value).sort()).toEqual(["black", "red"]);
    expect(facets.sizes.map((size) => size.value).sort()).toEqual(["L", "M", "S"]);
  });

  /* ── DTO safety ─────────────────────────────────────────────────────── */

  it("never leaks internal fields, storage keys or costs", async () => {
    const result = await list({ category: slug("cat-a") });
    const json = JSON.stringify(result);
    for (const forbidden of ["SECRET-ADMIN-NOTE", "adminNotes", "estimatedShipping", "7777", "storageKey", `private/${P}`, "supplier", "status", "DRAFT"]) {
      expect(json).not.toContain(forbidden);
    }
    for (const product of result.products) {
      expect(Number.isInteger(product.price.amountPaise)).toBe(true);
      expect(product.image.alt.length).toBeGreaterThan(0);
    }
  });

  it("reports a discount only when compare-at is real", async () => {
    const result = await list({ category: slug("cat-a") });
    const bySlug = new Map(result.products.map((product) => [product.slug, product]));
    expect(bySlug.get(slug("hoodie"))?.price.discountPercent).toBe(25);
    expect(bySlug.get(slug("tee"))?.price.discountPercent).toBeNull();
    expect(bySlug.get(slug("tee"))?.rating).toBeNull();
  });

  /* ── redirects & slug history ──────────────────────────────────────── */

  it("redirects /shop?category=x to the clean category URL, keeping filters", async () => {
    const result = await s.listing.loadCatalogListing("shop", "", `category=${slug("cat-a")}&size=m`);
    expect(result).toEqual({ status: "redirect", to: `/category/${slug("cat-a")}?size=M`, permanent: true });
  });

  it("ignores an unknown ?category on /shop rather than failing", async () => {
    const result = await s.listing.loadCatalogListing("shop", "", "category=does-not-exist");
    expect(result.status).toBe("ok");
  });

  it("keeps old category and collection URLs working after a rename", async () => {
    const actor = { id: "00000000-0000-0000-0000-000000000000", role: "ADMIN" };
    await s.admin.updateCategory(actor, catIds["cat-empty"]!, { name: `${P} renamed`, slug: slug("cat-renamed"), displayOrder: 0 });
    expect(await s.listing.loadCatalogListing("category", slug("cat-empty"), "sort=newest")).toEqual({
      status: "redirect",
      to: `/category/${slug("cat-renamed")}?sort=newest`,
      permanent: true,
    });
    const renamed = await s.listing.loadCatalogListing("category", slug("cat-renamed"), "");
    expect(renamed.status).toBe("ok");
  });

  /* ── public API ─────────────────────────────────────────────────────── */

  it("GET /api/products validates input and returns { data, pagination }", async () => {
    const { GET } = await import("@/app/api/products/route");
    const url = `http://test.local/api/products?category=${slug("cat-a")}&sort=hack&minPrice=hello&size=INVALID&pageSize=2&page=2`;
    const response = await GET(new Request(url, { headers: { "x-forwarded-for": "203.0.113.7" } }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { slug: string }[]; pagination: Record<string, number> };
    expect(body.pagination).toMatchObject({ page: 2, pageSize: 2, total: 4, totalPages: 2 });
    expect(Object.keys(body.pagination).sort()).toEqual(["page", "pageSize", "total", "totalPages"]);
    expect(body.data).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain("SECRET-ADMIN-NOTE");
  });

  it("GET /api/products answers 404 for a hidden category and caps the page size", async () => {
    const { GET } = await import("@/app/api/products/route");
    const hidden = await GET(new Request(`http://test.local/api/products?category=${slug("cat-off")}`, { headers: { "x-forwarded-for": "203.0.113.8" } }));
    expect(hidden.status).toBe(404);
    const capped = await GET(new Request("http://test.local/api/products?pageSize=99999", { headers: { "x-forwarded-for": "203.0.113.9" } }));
    const body = (await capped.json()) as { pagination: { pageSize: number } };
    expect(body.pagination.pageSize).toBeLessThanOrEqual(48);
  });

  it("GET /api/collections and /api/categories list public entries only", async () => {
    const collectionsRoute = await import("@/app/api/collections/route");
    const categoriesRoute = await import("@/app/api/categories/route");
    const headers = { "x-forwarded-for": "203.0.113.10" };
    const collectionBody = (await (await collectionsRoute.GET(new Request("http://test.local/api/collections", { headers }))).json()) as { data: { slug: string }[] };
    const listedCollections = collectionBody.data.map((entry) => entry.slug);
    expect(listedCollections).toContain(slug("col-live"));
    for (const key of ["col-draft", "col-archived", "col-future", "col-ended"]) expect(listedCollections).not.toContain(slug(key));
    const categoryBody = (await (await categoriesRoute.GET(new Request("http://test.local/api/categories", { headers }))).json()) as { data: { slug: string }[] };
    const listedCategories = categoryBody.data.map((entry) => entry.slug);
    expect(listedCategories).toContain(slug("cat-a"));
    expect(listedCategories).not.toContain(slug("cat-off"));
    expect(listedCategories).not.toContain(slug("cat-off-child"));
  });

  /* ── freshness / invalidation ──────────────────────────────────────── */

  it("expires the public catalog cache after an admin write", async () => {
    revalidateTag.mockClear();
    const actor = { id: "00000000-0000-0000-0000-000000000000", role: "ADMIN" };
    await s.admin.updateCategory(actor, catIds["cat-a"]!, { name: `${P} cat-a`, slug: slug("cat-a"), displayOrder: 0 });
    expect(revalidateTag).toHaveBeenCalledWith("catalog", { expire: 0 });
  });

  it("drops a product from a category once it is removed or archived", async () => {
    const { db, schema, drizzle } = s;
    const { and, eq } = drizzle;
    await db.delete(schema.productCategories).where(and(eq(schema.productCategories.productId, ids["tee"]!), eq(schema.productCategories.categoryId, catIds["cat-child"]!)));
    expect(slugsOf(await list({ category: slug("cat-a") }))).not.toContain("tee");

    await db.update(schema.products).set({ status: "ARCHIVED" }).where(eq(schema.products.id, ids["hoodie"]!));
    expect(slugsOf(await list({ category: slug("cat-a") }))).not.toContain("hoodie");
    expect((await list({ category: slug("cat-a") })).pagination.total).toBe(2);
  });
});
