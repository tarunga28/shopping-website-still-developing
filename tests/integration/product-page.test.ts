// @vitest-environment node
/**
 * Product detail page (PDP) against a real PostgreSQL database.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database with the
 * schema applied. Every fixture carries a unique prefix and is removed after.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }),
}));

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const P = `pp${randomBytes(3).toString("hex")}`;
const slug = (name: string) => `${P}-${name}`;
const ACTOR = { id: "00000000-0000-0000-0000-000000000000", role: "ADMIN" };
const SECRET_NOTE = `SECRET-ADMIN-NOTE-${P}`;
const SECRET_KEY = `private/${P}/secret-print-file`;

type Mods = {
  db: typeof import("@/db").db;
  pool: typeof import("@/db").pool;
  schema: typeof import("@/db/schema");
  page: typeof import("@/services/catalog/product-page.service");
  purchasable: typeof import("@/services/catalog/purchasable.service");
  related: typeof import("@/services/catalog/related.service");
  reviewsSvc: typeof import("@/services/catalog/product-reviews.service");
  query: typeof import("@/services/catalog-query.service");
  admin: typeof import("@/services/catalog-admin.service");
  facade: typeof import("@/services/catalog.service");
  cartAction: typeof import("@/server/actions/cart-actions");
  drizzle: typeof import("drizzle-orm");
};

describe.skipIf(!enabled)("product detail page (PostgreSQL)", () => {
  let m: Mods;
  const ids: Record<string, string> = {};
  const variantIds: Record<string, string> = {};
  const catIds: Record<string, string> = {};
  const userIds: string[] = [];

  type VariantSpec = { key: string; size: string | null; color: string | null; availability?: "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK" | "PREORDER"; price?: number; compareAt?: number | null; colorCode?: string | null };
  type Spec = {
    key: string;
    type?: "T_SHIRT" | "HOODIE" | "MUG" | "CUSTOM";
    status?: "ACTIVE" | "DRAFT" | "ARCHIVED" | "DISCONTINUED";
    price?: number;
    compareAt?: number | null;
    variants?: VariantSpec[];
    image?: boolean;
    cats?: string[];
    cols?: string[];
    tags?: string[];
    days?: number;
    details?: unknown;
  };

  const colId: Record<string, string> = {};

  beforeAll(async () => {
    const [dbm, schema, page, purchasable, related, reviewsSvc, query, admin, facade, cartAction, drizzle] = await Promise.all([
      import("@/db"),
      import("@/db/schema"),
      import("@/services/catalog/product-page.service"),
      import("@/services/catalog/purchasable.service"),
      import("@/services/catalog/related.service"),
      import("@/services/catalog/product-reviews.service"),
      import("@/services/catalog-query.service"),
      import("@/services/catalog-admin.service"),
      import("@/services/catalog.service"),
      import("@/server/actions/cart-actions"),
      import("drizzle-orm"),
    ]);
    m = { db: dbm.db, pool: dbm.pool, schema, page, purchasable, related, reviewsSvc, query, admin, facade, cartAction, drizzle };
    const { db } = m;
    const { categories, collections, colors, products, productVariants, images, productCategories, productCollections, tags, productTags } = schema;

    // `path` is the materialized slug chain; fixtures build it the same way the
    // category service does so the tree columns stay consistent.
    const catPaths = new Map<string, string>();
    const cat = async (key: string, values: Partial<typeof categories.$inferInsert> = {}) => {
      const parentPath = values.parentId ? catPaths.get(values.parentId) : undefined;
      const categorySlug = (values.slug as string | undefined) ?? slug(key);
      const path = parentPath ? `${parentPath}/${categorySlug}` : categorySlug;
      catPaths.set(key, path);
      const [row] = await db
        .insert(categories)
        .values({ name: `${P} ${key}`, slug: categorySlug, path, ...values })
        .returning({ id: categories.id });
      catIds[key] = row!.id;
    };
    await cat("apparel");
    await cat("hoodies", { parentId: catIds.apparel });
    await cat("other");
    await cat("off", { isActive: false });

    const [colLive] = await db.insert(collections).values({ name: `${P} col`, slug: slug("col"), status: "ACTIVE" }).returning({ id: collections.id });
    const [colDraft] = await db.insert(collections).values({ name: `${P} coldraft`, slug: slug("coldraft"), status: "DRAFT" }).returning({ id: collections.id });
    const [colOnly] = await db.insert(collections).values({ name: `${P} colonly`, slug: slug("colonly"), status: "ACTIVE" }).returning({ id: collections.id });
    const collectionIds: Record<string, string> = { col: colLive!.id, coldraft: colDraft!.id, colonly: colOnly!.id };

    const [tagA] = await db.insert(tags).values({ name: `${P}-tag-a`, slug: slug("tag-a") }).returning({ id: tags.id });
    const tagIds: Record<string, string> = { "tag-a": tagA!.id };

    for (const [key, hex] of [["teal", "#008080"], ["sand", "#d2b48c"]] as const) {
      const [row] = await db.insert(colors).values({ name: `${P}${key}`, slug: slug(`c-${key}`), hex, displayOrder: key === "teal" ? 1 : 2 }).returning({ id: colors.id });
      colId[key] = row!.id;
    }

    const teal = `${P}teal`;
    const sand = `${P}sand`;
    const specs: Spec[] = [
      {
        key: "main",
        type: "HOODIE",
        price: 149_900,
        compareAt: 199_900,
        cats: ["hoodies"],
        cols: ["col", "coldraft"],
        tags: ["tag-a"],
        days: 5,
        details: { features: ["Brushed fleece"], materials: "80% cotton", care: ["Wash cold"], specs: [{ label: "Weight", value: "320 gsm" }] },
        variants: [
          { key: "teal-s", size: "S", color: teal },
          { key: "teal-m", size: "M", color: teal },
          { key: "teal-l", size: "L", color: teal, availability: "OUT_OF_STOCK" },
          { key: "sand-m", size: "M", color: sand, price: 159_900 },
          { key: "sand-xl", size: "XL", color: sand, availability: "PREORDER" },
        ],
      },
      { key: "sibling-col", type: "T_SHIRT", cats: ["other"], cols: ["col"], days: 4 }, // shares collection only
      { key: "sibling-cat", type: "T_SHIRT", cats: ["hoodies"], days: 3 }, // shares category only
      { key: "sibling-type", type: "HOODIE", cats: ["other"], days: 2 }, // shares type only
      { key: "sibling-tag", type: "MUG", cats: ["other"], tags: ["tag-a"], days: 1 }, // shares tag only
      { key: "unrelated", type: "MUG", cats: ["other"], days: 1 },
      { key: "draft", status: "DRAFT", type: "HOODIE", cats: ["hoodies"], cols: ["col"] },
      { key: "archived", status: "ARCHIVED", type: "HOODIE", cats: ["hoodies"] },
      { key: "discontinued", status: "DISCONTINUED", type: "HOODIE", cats: ["hoodies"] },
      { key: "noimage", image: false, type: "HOODIE", cats: ["hoodies"] },
      { key: "novariant", variants: [], type: "HOODIE", cats: ["hoodies"] },
      { key: "alloos", variants: [{ key: "only", size: "M", color: teal, availability: "OUT_OF_STOCK" }], type: "HOODIE" },
      { key: "single", type: "MUG", variants: [{ key: "std", size: null, color: null }] },
      { key: "collection-only", cols: ["colonly"] },
      { key: "hidden-cat", cats: ["off"] },
      { key: "chart", type: "CUSTOM" },
      { key: "other-a", type: "MUG", cats: ["other"] },
      { key: "other-b", type: "MUG", cats: ["other"] },
    ];
    // Plenty of siblings to exercise the 8-item cap.
    for (let i = 0; i < 11; i += 1) specs.push({ key: `many-${i}`, type: "HOODIE", cats: ["hoodies"], days: 20 + i });

    for (const spec of specs) {
      const [product] = await db
        .insert(products)
        .values({
          name: `${P} ${spec.key}`,
          slug: slug(spec.key),
          description: "A fixture product for PDP tests.",
          productType: spec.type ?? "T_SHIRT",
          status: spec.status ?? "ACTIVE",
          basePrice: spec.price ?? 99_900,
          compareAtPrice: spec.compareAt ?? null,
          adminNotes: SECRET_NOTE,
          estimatedShippingPaise: 7_777,
          details: spec.details ?? null,
          publishedAt: new Date(Date.now() - (spec.days ?? 10) * 86_400_000),
        })
        .returning({ id: products.id });
      ids[spec.key] = product!.id;
      if (spec.image !== false) {
        await db.insert(images).values({ type: "PRODUCT", role: "PRIMARY", url: `/images/products/${spec.key}.jpg`, altText: "", productId: product!.id, storageKey: SECRET_KEY, sortOrder: 0 });
      }
      for (const v of spec.variants ?? [{ key: "std", size: "M", color: teal }]) {
        const [row] = await db
          .insert(productVariants)
          .values({
            productId: product!.id,
            sku: `${P}-${spec.key}-${v.key}`.toUpperCase(),
            name: `${v.color ?? "Std"} / ${v.size ?? "Std"}`,
            size: v.size,
            color: v.color,
            colorCode: v.colorCode ?? null,
            price: v.price ?? spec.price ?? 99_900,
            compareAtPrice: v.compareAt ?? null,
            availability: v.availability ?? "IN_STOCK",
          })
          .returning({ id: productVariants.id });
        variantIds[`${spec.key}:${v.key}`] = row!.id;
      }
      for (const key of spec.cats ?? []) await db.insert(productCategories).values({ productId: product!.id, categoryId: catIds[key]!, isPrimary: true });
      for (const key of spec.cols ?? []) await db.insert(productCollections).values({ productId: product!.id, collectionId: collectionIds[key]! });
      for (const key of spec.tags ?? []) await db.insert(productTags).values({ productId: product!.id, tagId: tagIds[key]! });
    }

    // Main product: extra gallery image, a colour-specific photo, a social crop.
    await db.insert(images).values([
      { type: "PRODUCT", role: "GALLERY", url: "/images/products/main-2.jpg", altText: "", productId: ids.main!, storageKey: SECRET_KEY, sortOrder: 1 },
      { type: "PRODUCT", role: "GALLERY", url: "/images/products/main-sand.jpg", altText: "Hoodie in sand", productId: ids.main!, variantId: variantIds["main:sand-m"]!, storageKey: SECRET_KEY, sortOrder: 2 },
      { type: "PRODUCT", role: "SOCIAL", url: "/images/products/main-social.jpg", altText: "", productId: ids.main!, storageKey: SECRET_KEY, sortOrder: 3 },
    ]);

    // Users + reviews for the main product.
    for (const [name, suffix] of [["Asha Verma", "a"], ["Ravi Kumar", "b"], ["Meera Nair", "c"]] as const) {
      const [user] = await db.insert(schema.users).values({ name, email: `${P}-${suffix}@example.test` }).returning({ id: schema.users.id });
      userIds.push(user!.id);
    }
    await db.insert(schema.reviews).values([
      { userId: userIds[0]!, productId: ids.main!, rating: 5, title: "Great <b>hoodie</b>", content: "Warm and soft.", status: "APPROVED", verifiedPurchase: true },
      { userId: userIds[1]!, productId: ids.main!, rating: 4, content: "Good.", status: "APPROVED" },
      { userId: userIds[2]!, productId: ids.main!, rating: 1, content: "PENDING-REVIEW-TEXT", status: "PENDING" },
    ]);
    await db.insert(schema.reviews).values({ userId: userIds[2]!, productId: ids["sibling-cat"]!, rating: 2, content: "REJECTED-REVIEW-TEXT", status: "REJECTED" });

    // Designs: one published (shown), one rejected on another product (hides it).
    const [good] = await db.insert(schema.designs).values({ name: `${P} Ember Art`, slug: slug("d-good"), status: "PUBLISHED", copyrightStatus: "ORIGINAL" }).returning({ id: schema.designs.id });
    const [draftDesign] = await db.insert(schema.designs).values({ name: `${P} Unreleased Art`, slug: slug("d-draft"), status: "DRAFT", copyrightStatus: "ORIGINAL" }).returning({ id: schema.designs.id });
    const [bad] = await db.insert(schema.designs).values({ name: `${P} Rejected`, slug: slug("d-bad"), status: "REJECTED", copyrightStatus: "ORIGINAL" }).returning({ id: schema.designs.id });
    await db.insert(schema.productDesigns).values([
      { productId: ids.main!, designId: good!.id, placement: "FRONT", printFileKey: SECRET_KEY },
      { productId: ids.main!, designId: good!.id, placement: "BACK", printFileKey: SECRET_KEY },
      { productId: ids.main!, designId: draftDesign!.id, placement: "FRONT", printFileKey: SECRET_KEY },
      { productId: ids["sibling-type"]!, designId: bad!.id, placement: "FRONT" },
    ]);
  });

  afterAll(async () => {
    if (!m) return;
    const { db, schema, drizzle, pool } = m;
    const { like, inArray } = drizzle;
    await db.delete(schema.reviews).where(inArray(schema.reviews.userId, userIds)).catch(() => undefined);
    await db.delete(schema.users).where(like(schema.users.email, `${P}-%`));
    await db.delete(schema.sizeCharts).where(like(schema.sizeCharts.title, `${P}%`));
    await db.delete(schema.productSlugHistory).where(like(schema.productSlugHistory.slug, `${P}%`)).catch(() => undefined);
    await db.delete(schema.products).where(like(schema.products.slug, `${P}%`));
    await db.delete(schema.designs).where(like(schema.designs.slug, `${P}%`));
    await db.delete(schema.categories).where(like(schema.categories.slug, `${P}%`));
    await db.delete(schema.collections).where(like(schema.collections.slug, `${P}%`));
    await db.delete(schema.tags).where(like(schema.tags.slug, `${P}%`));
    await db.delete(schema.colors).where(like(schema.colors.slug, `${P}%`));
    await pool.end();
  });

  const load = (key: string) => m.page.getProductPage(slug(key));
  const vid = (key: string) => variantIds[key]!;

  /* ── lookup, visibility ─────────────────────────────────────────────── */

  it("loads a valid product with real variants, options and content", async () => {
    const product = await load("main");
    expect(product).not.toBeNull();
    expect(product!.name).toBe(`${P} main`);
    expect(product!.variants).toHaveLength(5);
    expect(product!.colors.map((c) => c.label)).toEqual([`${P}teal`, `${P}sand`]);
    expect(product!.sizes.map((s) => s.label)).toEqual(["S", "M", "L", "XL"]);
    expect(product!.details.features).toEqual(["Brushed fleece"]);
    expect(product!.details.specs).toEqual([{ label: "Weight", value: "320 gsm" }]);
    expect(product!.purchasable).toBe(true);
  });

  it.each(["draft", "archived", "discontinued"])("does not expose a %s product", async (key) => {
    expect(await load(key)).toBeNull();
    expect(await m.page.getProductPage("does-not-exist-" + P)).toBeNull();
  });

  it("rejects malformed slugs without touching the database with them", async () => {
    for (const bad of ["../etc/passwd", "a b", "UPPER", "x'; DROP TABLE products;--", "", "-x-"]) {
      expect(await m.page.getProductPage(bad)).toBeNull();
    }
  });

  it("a rejected design hides the product entirely", async () => {
    expect(await load("sibling-type")).toBeNull();
  });

  it("reflects a price change immediately (₹1,499 → ₹1,599) — no stale product", async () => {
    const { db, schema, drizzle } = m;
    const before = await load("single");
    expect(before!.variants[0]!.price.amountPaise).toBe(99_900);
    await db.update(schema.productVariants).set({ price: 159_900 }).where(drizzle.eq(schema.productVariants.id, vid("single:std")));
    await db.update(schema.products).set({ basePrice: 159_900 }).where(drizzle.eq(schema.products.id, ids.single!));
    const after = await load("single");
    expect(after!.price.amountPaise).toBe(159_900);
    expect(after!.variants[0]!.price.amountPaise).toBe(159_900);
    await db.update(schema.productVariants).set({ price: 99_900 }).where(drizzle.eq(schema.productVariants.id, vid("single:std")));
    await db.update(schema.products).set({ basePrice: 99_900 }).where(drizzle.eq(schema.products.id, ids.single!));
  });

  it("stops serving a product the moment it is archived", async () => {
    const { db, schema, drizzle } = m;
    expect(await load("collection-only")).not.toBeNull();
    await db.update(schema.products).set({ status: "ARCHIVED" }).where(drizzle.eq(schema.products.id, ids["collection-only"]!));
    expect(await load("collection-only")).toBeNull();
    await db.update(schema.products).set({ status: "ACTIVE" }).where(drizzle.eq(schema.products.id, ids["collection-only"]!));
  });

  /* ── DTO security ───────────────────────────────────────────────────── */

  it("never exposes supplier cost, notes, storage keys, print files or design ids", async () => {
    const product = await load("main");
    const json = JSON.stringify(product);
    for (const leak of [SECRET_NOTE, SECRET_KEY, "7777", "storageKey", "printFileKey", "supplier", "adminNotes", "estimatedShipping"]) {
      expect(json).not.toContain(leak);
    }
    const apiView = await m.facade.getProductBySlug(slug("main"));
    const apiJson = JSON.stringify(apiView);
    for (const leak of [SECRET_NOTE, SECRET_KEY, "7777", "printFileKey"]) expect(apiJson).not.toContain(leak);
  });

  it("shows only PUBLISHED designs, with name and placement label only", async () => {
    const product = await load("main");
    expect(product!.designs).toEqual([{ name: `${P} Ember Art`, placements: ["Front", "Back"] }]);
    expect(JSON.stringify(product)).not.toContain("Unreleased Art");
  });

  /* ── images ─────────────────────────────────────────────────────────── */

  it("orders images, excludes the social crop, gives unique alt text and maps variant photos to a colour", async () => {
    const product = await load("main");
    expect(product!.images.map((i) => i.url)).toEqual(["/images/products/main.jpg", "/images/products/main-2.jpg", "/images/products/main-sand.jpg"]);
    expect(new Set(product!.images.map((i) => i.alt)).size).toBe(3);
    expect(product!.images[2]!.colorKey).toBe(`${P}sand`);
    expect(product!.images[0]!.colorKey).toBeNull();
    expect(product!.seo.image).toBe("/images/products/main-social.jpg");
  });

  it("survives a deleted image: falls back to no images but keeps the page", async () => {
    const { db, schema, drizzle } = m;
    await db.delete(schema.images).where(drizzle.eq(schema.images.productId, ids.noimage!));
    const product = await load("noimage");
    expect(product).not.toBeNull();
    expect(product!.images).toEqual([]);
    expect(product!.purchasable).toBe(true);
    expect(product!.seo.image).toBeNull();
  });

  /* ── variants, availability, colours ────────────────────────────────── */

  it("reports availability per variant without inventing stock", async () => {
    const product = await load("main");
    const states = Object.fromEntries(product!.variants.map((v) => [v.sku.replace(`${P}-MAIN-`.toUpperCase(), ""), v.state]));
    expect(states).toEqual({ "TEAL-S": "AVAILABLE", "TEAL-M": "AVAILABLE", "TEAL-L": "OUT_OF_STOCK", "SAND-M": "AVAILABLE", "SAND-XL": "UNAVAILABLE" });
    expect(JSON.stringify(product)).not.toMatch(/stock(Count|Level|Quantity)|"quantity"/i);
  });

  it("gets colour hex from the colour system, never from the client", async () => {
    const product = await load("main");
    expect(product!.colors.map((c) => c.hex)).toEqual(["#008080", "#d2b48c"]);
  });

  it("shows stored compare-at and discount only when they exist", async () => {
    const product = await load("main");
    expect(product!.price).toEqual({ amountPaise: 149_900, compareAtPaise: 199_900, discountPercent: 25 });
    expect((await load("sibling-cat"))!.price.discountPercent).toBeNull();
  });

  it("handles a product with no variants: visible, but nothing to buy", async () => {
    const product = await load("novariant");
    expect(product).not.toBeNull();
    expect(product!.variants).toEqual([]);
    expect(product!.purchasable).toBe(false);
  });

  it("marks a product with only out-of-stock variants as not purchasable", async () => {
    expect((await load("alloos"))!.purchasable).toBe(false);
  });

  it("handles a single-variant product with no options", async () => {
    const product = await load("single");
    expect(product!.colors).toEqual([]);
    expect(product!.sizes).toEqual([]);
    expect(product!.variants).toHaveLength(1);
  });

  it("includes real approved-review data only", async () => {
    const product = await load("main");
    expect(product!.rating).toEqual({ average: 4.5, count: 2 });
    expect((await load("sibling-cat"))!.rating).toBeNull();
    expect((await load("unrelated"))!.rating).toBeNull();
  });

  /* ── breadcrumbs ────────────────────────────────────────────────────── */

  it("builds the category trail from the primary category, parents first", async () => {
    const product = await load("main");
    expect(product!.categoryTrail.map((c) => c.slug)).toEqual([slug("apparel"), slug("hoodies")]);
    expect(product!.collection?.slug).toBe(slug("col"));
  });

  it("omits non-public categories and draft collections from the trail", async () => {
    const hidden = await load("hidden-cat");
    expect(hidden!.categoryTrail).toEqual([]);
    const main = await load("main");
    expect(JSON.stringify(main)).not.toContain("coldraft");
  });

  it("falls back to a collection when the product has no public category", async () => {
    const product = await load("collection-only");
    expect(product!.categoryTrail).toEqual([]);
    expect(product!.collection?.slug).toBe(slug("colonly"));
  });

  /* ── reviews ────────────────────────────────────────────────────────── */

  it("lists approved reviews with first names only, sanitised text and a distribution", async () => {
    const data = await m.reviewsSvc.getProductReviews(ids.main!);
    expect(data.count).toBe(2);
    expect(data.average).toBe(4.5);
    expect(data.distribution).toEqual([0, 0, 0, 1, 1]);
    expect(data.reviews.map((r) => r.authorName).sort()).toEqual(["Asha", "Ravi"]);
    const json = JSON.stringify(data);
    expect(json).not.toContain("PENDING-REVIEW-TEXT");
    expect(json).not.toContain("@example.test");
    expect(json).not.toContain("Verma");
    expect(data.reviews.find((r) => r.authorName === "Asha")).toMatchObject({ title: "Great hoodie", verifiedPurchase: true });
    expect(data.reviews.find((r) => r.authorName === "Ravi")?.verifiedPurchase).toBe(false);
  });

  it("returns an honest empty result when there are no (approved) reviews", async () => {
    const empty = await m.reviewsSvc.getProductReviews(ids["sibling-cat"]!);
    expect(empty).toEqual({ count: 0, average: null, distribution: [0, 0, 0, 0, 0], reviews: [] });
  });

  /* ── size charts ────────────────────────────────────────────────────── */

  it("has no size chart unless a real one exists for the product type", async () => {
    expect((await load("chart"))!.sizeChart).toBeNull();
  });

  it("shows the active chart for its product type only, validated", async () => {
    await m.admin.saveSizeChart(ACTOR, "CUSTOM", {
      title: `${P} Custom sizes`,
      unit: "cm",
      columns: ["Size", "Width"],
      rows: [["A4", "21"], ["A3", "29.7"]],
      notes: "<b>Flat</b> measurements",
    });
    const product = await load("chart");
    expect(product!.sizeChart).toMatchObject({ title: `${P} Custom sizes`, unit: "cm", notes: "Flat measurements" });
    expect(product!.sizeChart!.rows).toHaveLength(2);
    expect((await load("main"))!.sizeChart).toBeNull(); // different product type
    // Saving again replaces rather than duplicates.
    await m.admin.saveSizeChart(ACTOR, "CUSTOM", { title: `${P} Custom sizes v2`, unit: "in", columns: ["Size", "Width"], rows: [["A4", "8.3"]] });
    expect((await load("chart"))!.sizeChart!.title).toBe(`${P} Custom sizes v2`);
    const { db, schema, drizzle } = m;
    const active = await db.select().from(schema.sizeCharts).where(drizzle.and(drizzle.eq(schema.sizeCharts.productType, "CUSTOM"), drizzle.eq(schema.sizeCharts.isActive, true)));
    expect(active).toHaveLength(1);
  });

  it("rejects an invalid size chart", async () => {
    await expect(m.admin.saveSizeChart(ACTOR, "CUSTOM", { title: "x", unit: "cm", columns: ["Size", "W"], rows: [["S"]] })).rejects.toThrow();
  });

  it("only editors can save a size chart", async () => {
    await expect(m.admin.saveSizeChart({ id: ACTOR.id, role: "CUSTOMER" }, "CUSTOM", {})).rejects.toThrow();
  });

  /* ── getPurchasableVariant (IDOR, price, availability) ──────────────── */

  it("returns server-side price and trusted data for a valid product+variant pair", async () => {
    const result = await m.purchasable.getPurchasableVariant({ productId: ids.main, variantId: vid("main:teal-m"), quantity: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.item).toMatchObject({
      productId: ids.main,
      variantId: vid("main:teal-m"),
      unitPricePaise: 149_900,
      quantity: 3,
      lineTotalPaise: 449_700,
      currency: "INR",
      imageUrl: "/images/products/main.jpg",
    });
    expect(Object.keys(result.item).sort()).toEqual(
      ["color", "compareAtPaise", "currency", "imageUrl", "lineTotalPaise", "productId", "productName", "productSlug", "quantity", "size", "sku", "unitPricePaise", "variantId", "variantName"],
    );
    expect(JSON.stringify(result)).not.toContain(SECRET_KEY);
  });

  it("ignores any client-supplied price, total, discount or supplier cost", async () => {
    const result = await m.purchasable.getPurchasableVariant({
      productId: ids.main,
      variantId: vid("main:teal-m"),
      quantity: 1,
      price: 1,
      unitPricePaise: 1,
      total: 1,
      discount: 99,
      supplierCost: 1,
    });
    expect(result.ok && result.item.unitPricePaise).toBe(149_900);
    expect(result.ok && result.item.lineTotalPaise).toBe(149_900);
  });

  it("rejects Product A with Variant B (IDOR) and never 'fixes' the pair", async () => {
    const crossed = await m.purchasable.getPurchasableVariant({ productId: ids["sibling-cat"], variantId: vid("main:teal-m"), quantity: 1 });
    expect(crossed).toEqual({ ok: false, reason: "NOT_FOUND" });
    const reversed = await m.purchasable.getPurchasableVariant({ productId: ids.main, variantId: vid("sibling-cat:std"), quantity: 1 });
    expect(reversed).toEqual({ ok: false, reason: "NOT_FOUND" });
  });

  it.each([
    ["out of stock", "main:teal-l", "UNAVAILABLE"],
    ["pre-order (not orderable yet)", "main:sand-xl", "UNAVAILABLE"],
  ])("rejects a %s variant server-side even if the page showed it", async (_label, key, reason) => {
    const productId = ids[key.split(":")[0]!];
    expect(await m.purchasable.getPurchasableVariant({ productId, variantId: vid(key), quantity: 1 })).toEqual({ ok: false, reason });
  });

  it("rejects a variant that was disabled after the page loaded (stale client)", async () => {
    const { db, schema, drizzle } = m;
    const input = { productId: ids.main, variantId: vid("main:teal-s"), quantity: 1 };
    expect((await m.purchasable.getPurchasableVariant(input)).ok).toBe(true);
    await db.update(schema.productVariants).set({ availability: "OUT_OF_STOCK" }).where(drizzle.eq(schema.productVariants.id, vid("main:teal-s")));
    expect(await m.purchasable.getPurchasableVariant(input)).toEqual({ ok: false, reason: "UNAVAILABLE" });
    await db.update(schema.productVariants).set({ availability: "IN_STOCK" }).where(drizzle.eq(schema.productVariants.id, vid("main:teal-s")));
  });

  it.each(["draft", "archived", "discontinued"])("does not let a %s product be purchased", async (key) => {
    const result = await m.purchasable.getPurchasableVariant({ productId: ids[key], variantId: vid(`${key}:std`), quantity: 1 });
    expect(result).toEqual({ ok: false, reason: "NOT_FOUND" });
  });

  it("uses the current server price after a price change", async () => {
    const { db, schema, drizzle } = m;
    await db.update(schema.productVariants).set({ price: 159_900 }).where(drizzle.eq(schema.productVariants.id, vid("sibling-col:std")));
    const result = await m.purchasable.getPurchasableVariant({ productId: ids["sibling-col"], variantId: vid("sibling-col:std"), quantity: 1 });
    expect(result.ok && result.item.unitPricePaise).toBe(159_900);
    await db.update(schema.productVariants).set({ price: 99_900 }).where(drizzle.eq(schema.productVariants.id, vid("sibling-col:std")));
  });

  it("validates ids and quantity", async () => {
    const base = { productId: ids.main, variantId: vid("main:teal-m") };
    expect(await m.purchasable.getPurchasableVariant({ ...base, productId: "not-a-uuid" })).toEqual({ ok: false, reason: "INVALID_INPUT" });
    expect(await m.purchasable.getPurchasableVariant({ ...base, variantId: "' OR 1=1 --" })).toEqual({ ok: false, reason: "INVALID_INPUT" });
    expect(await m.purchasable.getPurchasableVariant(null)).toEqual({ ok: false, reason: "INVALID_INPUT" });
    for (const quantity of [0, -1, 1.5, 999_999_999, Number.NaN, "2", 11]) {
      expect(await m.purchasable.getPurchasableVariant({ ...base, quantity })).toEqual({ ok: false, reason: "INVALID_QUANTITY" });
    }
    const defaulted = await m.purchasable.getPurchasableVariant(base);
    expect(defaulted.ok && defaulted.item.quantity).toBe(1);
    expect((await m.purchasable.getPurchasableVariant({ ...base, quantity: 10 })).ok).toBe(true);
  });

  it("the cart server action answers with trusted data and ignores extra fields", async () => {
    const ok = await m.cartAction.validateCartLineAction({ productId: ids.main, variantId: vid("main:teal-m"), quantity: 2, price: 1, total: 1, supplierCost: 1 });
    expect(ok.ok && ok.item.lineTotalPaise).toBe(299_800);
    const crossed = await m.cartAction.validateCartLineAction({ productId: ids["sibling-cat"], variantId: vid("main:teal-m"), quantity: 1 });
    expect(crossed).toMatchObject({ ok: false, reason: "NOT_FOUND" });
    expect(await m.cartAction.validateCartLineAction("garbage")).toMatchObject({ ok: false, reason: "INVALID_INPUT" });
    const big = await m.cartAction.validateCartLineAction({ productId: ids.main, variantId: vid("main:teal-m"), quantity: 999_999_999 });
    expect(big).toMatchObject({ ok: false, reason: "INVALID_QUANTITY" });
  });

  it("quoteSku uses the same visibility rules and ignores a client price", async () => {
    const quote = await m.query.quoteSku(`${P}-main-teal-m`.toUpperCase(), 1);
    expect(quote.sku).toBe(`${P}-main-teal-m`.toUpperCase());
    expect(JSON.stringify(quote)).toContain("149900");
    await expect(m.query.quoteSku(`${P}-archived-std`.toUpperCase())).rejects.toThrow();
    await expect(m.query.quoteSku(`${P}-main-teal-l`.toUpperCase())).rejects.toThrow();
    await expect(m.query.quoteSku("NO-SUCH-SKU")).rejects.toThrow();
  });

  /* ── related products ───────────────────────────────────────────────── */

  it("ranks by collection first, then by combined category/type overlap — never including the product itself", async () => {
    const related = await m.related.getRelatedProducts(ids.main!, 50);
    const order = related.map((p) => p.slug.replace(`${P}-`, ""));
    expect(order).not.toContain("main");
    expect(order[0]).toBe("sibling-col"); // shared collection outranks everything
    // Category + type siblings (11 of them) fill the rest; category-only and tag-only siblings rank below and are cut by the cap.
    expect(order.slice(1).every((key) => key.startsWith("many-"))).toBe(true);
    expect(order).toHaveLength(8);
  });

  it("caps at 8, has no duplicates and only lists publicly visible products", async () => {
    const related = await m.related.getRelatedProducts(ids.main!, 50);
    expect(related).toHaveLength(8);
    const slugs = related.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const hidden of ["draft", "archived", "discontinued", "noimage", "novariant", "sibling-type", "alloos"]) {
      expect(slugs).not.toContain(slug(hidden));
    }
    expect((await m.related.getRelatedProducts(ids.main!, 3))).toHaveLength(3);
  });

  it("does not loop: related of a related product is well-formed and excludes itself", async () => {
    const first = await m.related.getRelatedProducts(ids.main!, 8);
    const hop = first[0]!;
    const back = await m.related.getRelatedProducts(hop.id, 8);
    expect(back.map((p) => p.id)).not.toContain(hop.id);
    expect(new Set(back.map((p) => p.id)).size).toBe(back.length);
  });

  it("surfaces a tag-only sibling but hides products with no relationship", async () => {
    const related = await m.related.getRelatedProducts(ids["sibling-tag"]!, 8);
    const slugs = related.map((p) => p.slug.replace(`${P}-`, ""));
    expect(slugs).toContain("main");
    expect(slugs).toContain("unrelated"); // same product type (MUG)
    expect(slugs).not.toContain("collection-only");
  });

  it("returns an empty list (section hidden) when nothing relates, and for bad input", async () => {
    expect(await m.related.getRelatedProducts("not-a-uuid")).toEqual([]);
    expect(await m.related.getRelatedProducts("00000000-0000-4000-8000-000000000000")).toEqual([]);
    expect(await m.related.getRelatedProducts(ids["collection-only"]!, 8).then((r) => r.filter((p) => p.slug === slug("collection-only")))).toEqual([]);
  });

  it("returns card-safe DTOs without internal fields", async () => {
    const related = await m.related.getRelatedProducts(ids.main!, 4);
    const json = JSON.stringify(related);
    expect(json).not.toContain(SECRET_NOTE);
    expect(json).not.toContain(SECRET_KEY);
    expect(json).not.toContain("7777");
  });

  /* ── redirects ──────────────────────────────────────────────────────── */

  it("resolves a renamed product's old slug", async () => {
    const { db, schema } = m;
    await db.insert(schema.productSlugHistory).values({ productId: ids["sibling-col"]!, slug: slug("old-name") });
    expect(await m.facade.findProductSlugRedirect(slug("old-name"))).toBe(slug("sibling-col"));
    expect(await load("old-name")).toBeNull(); // the old address itself is not a product
  });

  /* ── admin: storefront details ──────────────────────────────────────── */

  it("stores product details, clears them when empty, and leaves them alone when omitted", async () => {
    const created = await m.admin.createProduct(ACTOR, {
      name: `${P} Admin Made`,
      slug: slug("admin-made"),
      description: "Made in admin.",
      productType: "T_SHIRT",
      categoryIds: [],
      collectionIds: [],
      tags: [],
      basePrice: "999",
      currency: "INR",
      supplierMappingRequired: false,
      placement: "FRONT",
      details: { features: ["One"], materials: "Cotton", fit: null, care: [], printDetails: null, specs: [] },
    } as never);
    const { db, schema, drizzle } = m;
    const read = async () => (await db.select({ d: schema.products.details }).from(schema.products).where(drizzle.eq(schema.products.id, created.id)))[0]!.d;
    expect(m.page).toBeDefined();
    expect(await read()).toMatchObject({ features: ["One"], materials: "Cotton" });

    const base = { name: `${P} Admin Made`, slug: slug("admin-made"), description: "Made in admin.", productType: "T_SHIRT", categoryIds: [], collectionIds: [], tags: [], basePrice: "999", currency: "INR", supplierMappingRequired: false, placement: "FRONT" } as never;
    await m.admin.updateProduct(ACTOR, created.id, base);
    expect(await read()).toMatchObject({ features: ["One"] }); // omitted → untouched

    const copy = await m.admin.duplicateProduct(ACTOR, created.id);
    const copied = (await db.select({ d: schema.products.details }).from(schema.products).where(drizzle.eq(schema.products.id, copy.id)))[0]!.d;
    expect(copied).toMatchObject({ features: ["One"] });

    await m.admin.updateProduct(ACTOR, created.id, { ...(base as object), details: { features: [], materials: null, fit: null, care: [], printDetails: null, specs: [] } } as never);
    expect(await read()).toBeNull();
  });

  it("returns untrusted stored JSON safely on the page (malformed details never break it)", async () => {
    const { db, schema, drizzle } = m;
    await db.update(schema.products).set({ details: { features: "nope", materials: "<script>alert(1)</script>Cotton", care: [1, 2], specs: "x" } }).where(drizzle.eq(schema.products.id, ids["sibling-col"]!));
    const product = await load("sibling-col");
    expect(product!.details.features).toEqual([]);
    expect(product!.details.materials).not.toContain("<");
    expect(product!.details.care).toEqual([]);
  });

  it("the duplicate of a product keeps a variant photo attached to the copy's own variant", async () => {
    const copy = await m.admin.duplicateProduct(ACTOR, ids.main!);
    const { db, schema, drizzle } = m;
    const copyVariants = await db.select({ id: schema.productVariants.id }).from(schema.productVariants).where(drizzle.eq(schema.productVariants.productId, copy.id));
    const copyImages = await db.select({ v: schema.images.variantId }).from(schema.images).where(drizzle.eq(schema.images.productId, copy.id));
    const bound = copyImages.map((row) => row.v).filter(Boolean);
    expect(bound).toHaveLength(1);
    expect(copyVariants.map((row) => row.id)).toContain(bound[0]);
    expect(Object.values(variantIds)).not.toContain(bound[0]);
  });
});
