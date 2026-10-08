// @vitest-environment node
/**
 * Part 11 — product intelligence engine against a real PostgreSQL database.
 *
 * Covers the category tree (materialized paths, moves, cycles), the inventory
 * ledger (transactional, idempotent, no negative stock), the flexible attribute
 * engine (combo uniqueness enforced by the database) and search (full-text,
 * prefix, trigram typo recovery, synonyms).
 *
 * Skipped unless TEST_DATABASE_URL points at a disposable database — see
 * `npm run test:db`, which boots one automatically.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const P = `pi${randomBytes(4).toString("hex")}`;
const slug = (name: string) => `${P}-${name}`;

type Modules = {
  db: typeof import("@/db").db;
  schema: typeof import("@/db/schema");
  eq: typeof import("drizzle-orm").eq;
  and: typeof import("drizzle-orm").and;
  sql: typeof import("drizzle-orm").sql;
  category: typeof import("@/services/catalog/category.service");
  inventory: typeof import("@/services/catalog/inventory.service");
  search: typeof import("@/services/catalog/search.service");
  variant: typeof import("@/services/catalog/variant.service");
};

describe.skipIf(!enabled)("product intelligence (PostgreSQL)", () => {
  let m: Modules;
  const catIds: Record<string, string> = {};
  const catPaths = new Map<string, string>();

  beforeAll(async () => {
    const [dbm, schema, drizzle, category, inventory, search, variant] = await Promise.all([
      import("@/db"),
      import("@/db/schema"),
      import("drizzle-orm"),
      import("@/services/catalog/category.service"),
      import("@/services/catalog/inventory.service"),
      import("@/services/catalog/search.service"),
      import("@/services/catalog/variant.service"),
    ]);
    m = {
      db: dbm.db,
      schema,
      eq: drizzle.eq,
      and: drizzle.and,
      sql: drizzle.sql,
      category,
      inventory,
      search,
      variant,
    };

    // The migration seeds `size` and `color`; add `storage` to prove a new axis
    // needs no schema change.
    await m.variant.upsertAttributeDefinition({
      code: "storage",
      name: "Storage",
      isVariantAxis: true,
      displayOrder: 2,
      options: [
        { slug: "128gb", label: "128GB", sortOrder: 0 },
        { slug: "256gb", label: "256GB", sortOrder: 1 },
      ],
    });
  });

  afterAll(async () => {
    const { categories } = m.schema;
    // Cascade removes every product, variant, ledger row and index row.
    for (const id of Object.values(catIds)) {
      await m.db.delete(categories).where(m.eq(categories.id, id)).catch(() => undefined);
    }
  });

  /** Insert a category the way the admin service does, with a materialized path. */
  async function makeCategory(key: string, parentKey?: string) {
    const { categories } = m.schema;
    const categorySlug = slug(key);
    const parentPath = parentKey ? catPaths.get(parentKey) : undefined;
    const path = parentPath ? `${parentPath}/${categorySlug}` : categorySlug;
    catPaths.set(key, path);
    const [row] = await m.db
      .insert(categories)
      .values({
        name: `${P} ${key}`,
        slug: categorySlug,
        path,
        depth: parentKey ? (catPaths.get(parentKey)?.split("/").length ?? 1) : 0,
        parentId: parentKey ? catIds[parentKey] : null,
        ancestorIds: parentKey ? `${catIds[parentKey] ?? ""}` : "",
      })
      .returning({ id: categories.id, path: categories.path, depth: categories.depth });
    catIds[key] = row!.id;
    return row!;
  }

  async function makeProduct(input: {
    key: string;
    name: string;
    categoryId: string;
    status?: "DRAFT" | "ACTIVE";
    basePrice?: number;
    description?: string;
    visibility?: "PUBLIC" | "UNLISTED" | "PRIVATE";
  }) {
    const { products } = m.schema;
    const [row] = await m.db
      .insert(products)
      .values({
        name: input.name,
        slug: slug(input.key),
        productType: "OTHER",
        status: input.status ?? "ACTIVE",
        visibility: input.visibility ?? "PUBLIC",
        basePrice: input.basePrice ?? 100_000,
        categoryId: input.categoryId,
        description: input.description ?? null,
        publishedAt: input.status === "DRAFT" ? null : new Date(),
      })
      .returning({ id: products.id, slug: products.slug });
    return row!;
  }

  /**
   * Created through the variant service, not a raw insert: opening stock is
   * recorded as a STOCK_IN ledger entry, which is what makes the replay check
   * below meaningful.
   */
  async function makeVariant(productId: string, key: string, sku: string, stock = 10) {
    const result = await m.variant.createVariant({ id: null }, productId, {
      sku,
      name: key,
      price: 100_000,
      stockQuantity: stock,
      assignments: [{ code: "size", valueKey: key.toLowerCase(), valueLabel: key }],
    });
    return result.id;
  }

  /* ── Category tree ─────────────────────────────────────────────────── */

  describe("category tree", () => {
    let created: { electronics: { path: string; depth: number }; mobiles: { path: string; depth: number }; smartphones: { path: string; depth: number } };

    beforeAll(async () => {
      // Built once: categories are unique by slug, so re-creating them per test
      // would collide on the second run.
      const electronics = await makeCategory("electronics");
      const mobiles = await makeCategory("mobiles", "electronics");
      const smartphones = await makeCategory("smartphones", "mobiles");
      await makeCategory("featurephones", "mobiles");
      created = { electronics, mobiles, smartphones };
    });

    it("builds a materialized path for nested categories", () => {
      expect(created.electronics.path).toBe(slug("electronics"));
      expect(created.electronics.depth).toBe(0);
      expect(created.mobiles.path).toBe(`${slug("electronics")}/${slug("mobiles")}`);
      expect(created.mobiles.depth).toBe(1);
      expect(created.smartphones.path).toBe(`${slug("electronics")}/${slug("mobiles")}/${slug("smartphones")}`);
      expect(created.smartphones.depth).toBe(2);
    });

    it("resolves a whole subtree with one path prefix scan", async () => {
      const ids = await m.category.categorySubtreeIds(catIds.electronics);
      expect(ids).toHaveLength(4);
      expect(ids).toContain(catIds.smartphones);
      expect(ids).toContain(catIds.featurephones);
    });

    it("looks a nested category up by its storefront path", async () => {
      const found = await m.category.findByPath(catPaths.get("smartphones")!);
      expect(found?.id).toBe(catIds.smartphones);
    });

    it("rewrites every descendant path when a parent moves", async () => {
      const { categories } = m.schema;
      await makeCategory("home");
      await makeCategory("appliances", "home");
      await makeCategory("kitchen", "appliances");

      // Move "appliances" (and its child "kitchen") under "electronics".
      await m.db.transaction(async (tx) => {
        await m.category.relocateCategory(tx, catIds.appliances, { parentId: catIds.electronics });
      });

      const appliances = await m.db
        .select({ path: categories.path, depth: categories.depth })
        .from(categories)
        .where(m.eq(categories.id, catIds.appliances));
      const kitchen = await m.db
        .select({ path: categories.path, depth: categories.depth })
        .from(categories)
        .where(m.eq(categories.id, catIds.kitchen));

      expect(appliances[0]!.path).toBe(`${slug("electronics")}/${slug("appliances")}`);
      expect(appliances[0]!.depth).toBe(1);
      expect(kitchen[0]!.path).toBe(`${slug("electronics")}/${slug("appliances")}/${slug("kitchen")}`);
      expect(kitchen[0]!.depth).toBe(2);

      // The moved subtree is now reachable from its new ancestor.
      const underElectronics = await m.category.categorySubtreeIds(catIds.electronics);
      expect(underElectronics).toContain(catIds.kitchen);
    });

    it("refuses to move a category inside its own descendant", async () => {
      await expect(
        m.db.transaction(async (tx) => m.category.relocateCategory(tx, catIds.electronics, { parentId: catIds.kitchen })),
      ).rejects.toThrow(/cannot be moved inside itself/);
    });

    it("refuses to make a category its own parent", async () => {
      await expect(
        m.db.transaction(async (tx) => m.category.relocateCategory(tx, catIds.home, { parentId: catIds.home })),
      ).rejects.toThrow(/cannot be moved inside itself/);
    });

    it("reorders siblings and rejects mixing parents", async () => {
      await makeCategory("reorder-a");
      await makeCategory("reorder-b");
      const result = await m.category.reorderSiblings([catIds["reorder-b"], catIds["reorder-a"]]);
      expect(result.updated).toBe(2);

      const { categories } = m.schema;
      const [a] = await m.db
        .select({ displayOrder: categories.displayOrder })
        .from(categories)
        .where(m.eq(categories.id, catIds["reorder-a"]));
      const [b] = await m.db
        .select({ displayOrder: categories.displayOrder })
        .from(categories)
        .where(m.eq(categories.id, catIds["reorder-b"]));
      expect(b!.displayOrder).toBeLessThan(a!.displayOrder);

      // "kitchen" and "reorder-a" have different parents.
      await expect(m.category.reorderSiblings([catIds.kitchen, catIds["reorder-a"]])).rejects.toThrow(
        /same parent/,
      );
    });
  });

  /* ── Inventory ledger ──────────────────────────────────────────────── */

  describe("inventory ledger", () => {
    let productId: string;
    let variantId: string;

    beforeAll(async () => {
      await makeCategory("inventory-cat");
      const product = await makeProduct({ key: "stocked", name: `${P} Stocked Tee`, categoryId: catIds["inventory-cat"] });
      productId = product.id;
      variantId = await makeVariant(productId, "M", `${P}-M`, 10);
    });

    it("records STOCK_IN and writes previous/changed/new", async () => {
      const result = await m.inventory.adjustInventory(
        { id: null },
        { productId, variantId, operation: "STOCK_IN", quantity: 5, referenceType: "PURCHASE_ORDER", referenceId: `${P}-po1` },
      );
      expect(result.previousQuantity).toBe(10);
      expect(result.quantityChanged).toBe(5);
      expect(result.newQuantity).toBe(15);
      expect(result.idempotentReplay).toBe(false);
    });

    it("deducts on SALE and derives LOW_STOCK from the threshold", async () => {
      await m.inventory.adjustInventory(
        { id: null },
        { productId, variantId, operation: "SALE", quantity: 12, referenceType: "ORDER", referenceId: `${P}-o1` },
      );
      const [stock] = await m.inventory.getProductStock(productId);
      expect(stock!.stockQuantity).toBe(3);
      // Default low-stock threshold is 5, so 3 units is LOW_STOCK.
      expect(stock!.availability).toBe("LOW_STOCK");
      expect(stock!.isLowStock).toBe(true);
    });

    it("refuses to oversell below zero", async () => {
      await expect(
        m.inventory.adjustInventory(
          { id: null },
          { productId, variantId, operation: "SALE", quantity: 100, referenceType: "ORDER", referenceId: `${P}-o2` },
        ),
      ).rejects.toThrow(/would take stock to/);

      // Nothing was written.
      const [stock] = await m.inventory.getProductStock(productId);
      expect(stock!.stockQuantity).toBe(3);
    });

    it("replaying the same reference is a no-op", async () => {
      const first = await m.inventory.adjustInventory(
        { id: null },
        { productId, variantId, operation: "SALE", quantity: 1, referenceType: "ORDER", referenceId: `${P}-dup` },
      );
      expect(first.idempotentReplay).toBe(false);
      expect(first.newQuantity).toBe(2);

      const replay = await m.inventory.adjustInventory(
        { id: null },
        { productId, variantId, operation: "SALE", quantity: 1, referenceType: "ORDER", referenceId: `${P}-dup` },
      );
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.quantityChanged).toBe(0);

      const [stock] = await m.inventory.getProductStock(productId);
      expect(stock!.stockQuantity).toBe(2);
    });

    it("rejects a negative magnitude for a fixed-direction operation", async () => {
      await expect(
        m.inventory.adjustInventory(
          { id: null },
          { productId, variantId, operation: "SALE", quantity: -5, referenceType: "ORDER", referenceId: `${P}-neg` },
        ),
      ).rejects.toThrow(/must be positive/);
    });

    it("reserves against stock and cannot over-reserve", async () => {
      const reserved = await m.inventory.adjustInventory(
        { id: null },
        { productId, variantId, operation: "RESERVED", quantity: 1, referenceType: "ORDER", referenceId: `${P}-r1` },
      );
      expect(reserved.reservedQuantity).toBe(1);

      await expect(
        m.inventory.adjustInventory(
          { id: null },
          { productId, variantId, operation: "RESERVED", quantity: 50, referenceType: "ORDER", referenceId: `${P}-r2` },
        ),
      ).rejects.toThrow(/unreserved unit/);
    });

    it("rolls the product total up from its variants", async () => {
      const second = await makeVariant(productId, "L", `${P}-L`, 7);
      await m.inventory.adjustInventory(
        { id: null },
        { productId, variantId: second, operation: "STOCK_IN", quantity: 1, referenceType: "MANUAL" },
      );
      const { products } = m.schema;
      const [row] = await m.db
        .select({ stockQuantity: products.stockQuantity })
        .from(products)
        .where(m.eq(products.id, productId));
      expect(row!.stockQuantity).toBe(10); // 2 (M) + 8 (L)
    });

    it("keeps the ledger replayable: derived balance equals stored balance", async () => {
      const { productVariants } = m.schema;
      const variants = await m.db
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(m.eq(productVariants.productId, productId));
      const result = await m.inventory.verifyInventoryIntegrity(variants.map((v) => v.id));
      expect(result.checked).toBe(variants.length);
      expect(result.mismatches).toEqual([]);
    });

    it("returns paginated movement history newest-first", async () => {
      const { entries, total } = await m.inventory.getInventoryLedger({ variantId });
      expect(total).toBeGreaterThan(3);
      const times = entries.map((entry) => entry.createdAt.getTime());
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });
  });

  /* ── Attribute engine ──────────────────────────────────────────────── */

  describe("flexible attributes", () => {
    it("enforces variant combination uniqueness in the database", async () => {
      const { productVariants } = m.schema;
      await makeCategory("attr-cat");
      const product = await makeProduct({ key: "phone", name: `${P} Phone`, categoryId: catIds["attr-cat"] });

      await m.db.insert(productVariants).values({
        productId: product.id,
        sku: `${P}-256-BLACK`,
        name: "256GB / Black",
        price: 89_900_00,
        comboHash: "color:black|storage:256gb",
      });

      const attempt = m.db
        .insert(productVariants)
        .values({
          productId: product.id,
          sku: `${P}-256-BLACK-2`,
          name: "256GB / Black duplicate",
          price: 89_900_00,
          comboHash: "color:black|storage:256gb",
        })
        .then(() => null)
        .catch((error: unknown) => error);
      const error = (await attempt) as { cause?: { code?: string; constraint?: string } };
      expect(error).not.toBeNull();
      expect(error.cause?.code).toBe("23505");
      expect(error.cause?.constraint).toBe("product_variants_attribute_combo_key");

      const surviving = await m.db
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(m.eq(productVariants.productId, product.id));
      expect(surviving).toHaveLength(1);
    });

    it("allows the same combination on a different product", async () => {
      const { productVariants } = m.schema;
      const other = await makeProduct({ key: "phone2", name: `${P} Phone 2`, categoryId: catIds["attr-cat"] });
      const [row] = await m.db
        .insert(productVariants)
        .values({
          productId: other.id,
          sku: `${P}-OTHER-256-BLACK`,
          name: "256GB / Black",
          price: 79_900_00,
          comboHash: "color:black|storage:256gb",
        })
        .returning({ id: productVariants.id });
      expect(row.id).toBeTruthy();
    });
  });

  /* ── Search ────────────────────────────────────────────────────────── */

  describe("search", () => {
    beforeAll(async () => {
      const { searchSynonyms } = m.schema;
      await makeCategory("search-cat");
      await makeProduct({
        key: "iphone17",
        name: `${P} Apple iPhone 17 Pro Max 256GB`,
        categoryId: catIds["search-cat"],
        basePrice: 134_900_00,
        description: "Titanium frame with the A19 Pro chip and a 6.9 inch display.",
      });
      await makeProduct({
        key: "iphonecase",
        name: `${P} Silicone Case for iPhone 17`,
        categoryId: catIds["search-cat"],
        basePrice: 1_499_00,
        description: "Grippy silicone cover.",
      });
      await makeProduct({
        key: "teeshirt",
        name: `${P} Classic Cotton T-Shirt`,
        categoryId: catIds["search-cat"],
        basePrice: 999_00,
        description: "Everyday organic cotton tee.",
      });
      await makeProduct({
        key: "draftitem",
        name: `${P} Hidden Draft Product`,
        categoryId: catIds["search-cat"],
        status: "DRAFT",
      });
      await makeProduct({
        key: "unlisted",
        name: `${P} Unlisted Product`,
        categoryId: catIds["search-cat"],
        visibility: "UNLISTED",
      });

      await m.db.insert(searchSynonyms).values({ term: "tee", synonym: "t-shirt" });
      await m.search.reindexAll({ batchSize: 50 });
    });

    it("indexes only publicly listed products", async () => {
      const { productSearchIndex } = m.schema;
      const rows = await m.db
        .select({ name: productSearchIndex.name, isSearchable: productSearchIndex.isSearchable })
        .from(productSearchIndex)
        .where(m.sql`${productSearchIndex.name} LIKE ${`${P}%`}`);
      const byName = new Map(rows.map((row) => [row.name, row.isSearchable]));

      expect(byName.get(`${P} Apple iPhone 17 Pro Max 256GB`)).toBe(true);
      expect(byName.get(`${P} Hidden Draft Product`)).toBe(false);
      expect(byName.get(`${P} Unlisted Product`)).toBe(false);
    });

    it("finds a product by a word in its name", async () => {
      const result = await m.search.searchProducts("iPhone");
      const names = result.hits.map((hit) => hit.name);
      expect(names.some((name) => name.includes("iPhone 17 Pro Max"))).toBe(true);
      expect(result.hits.every((hit) => hit.name.startsWith(P))).toBe(true);
    });

    it("matches on prefix, so a partially typed word still hits", async () => {
      // "ipho" is genuinely ambiguous here: both the phone and its case contain
      // "iPhone", so the assertion is that both are found, not which comes first.
      const result = await m.search.searchProducts("ipho");
      expect(result.hits.length).toBeGreaterThanOrEqual(2);
      const names = result.hits.map((hit) => hit.name);
      expect(names.some((name) => name.includes("iPhone 17 Pro Max"))).toBe(true);
      expect(names.some((name) => name.includes("Silicone Case"))).toBe(true);
      // Every hit really does contain the typed prefix.
      expect(names.every((name) => name.toLowerCase().includes("ipho"))).toBe(true);
    });

    it("recovers from a typo via the trigram index", async () => {
      const result = await m.search.searchProducts("silicone");
      expect(result.hits.some((hit) => hit.name.includes("Silicone Case"))).toBe(true);

      // "silikone" matches nothing lexically; word_similarity finds the case.
      const typo = await m.search.searchProducts("silikone");
      expect(typo.hits.some((hit) => hit.name.includes("Silicone Case"))).toBe(true);
      expect(typo.hits.every((hit) => hit.matchedBy !== "fulltext")).toBe(true);
    });

    it("expands curated synonyms", async () => {
      const synonyms = await m.search.getSynonymMap();
      expect(synonyms.get("tee")).toContain("t-shirt");
      expect(synonyms.get("t-shirt")).toContain("tee");

      const result = await m.search.searchProducts("tee");
      // "t-shirt" tokenizes to "t" + "shirt", and those are what get matched.
      expect(result.expandedTerms).toEqual(expect.arrayContaining(["tee", "t", "shirt"]));
      expect(m.search.buildPrefixQuery("tee", synonyms)).toBe("(tee:* | t | shirt)");
      expect(result.hits.some((hit) => hit.name.includes("T-Shirt"))).toBe(true);
    });

    it("never returns a draft or unlisted product", async () => {
      for (const query of ["Hidden Draft", "Unlisted Product", "draft", "unlisted"]) {
        const result = await m.search.searchProducts(query);
        expect(result.hits.every((hit) => !hit.name.includes("Hidden Draft"))).toBe(true);
        expect(result.hits.every((hit) => !hit.name.includes("Unlisted Product"))).toBe(true);
      }
    });

    it("filters by price range", async () => {
      const cheap = await m.search.searchProducts("iPhone", { filters: { maxPricePaise: 500_000 } });
      expect(cheap.hits.every((hit) => hit.pricePaise <= 500_000)).toBe(true);
      expect(cheap.hits.some((hit) => hit.name.includes("Case"))).toBe(true);
    });

    it("ranks the closer name match above a looser one", async () => {
      const result = await m.search.searchProducts("iPhone 17 Pro Max 256GB");
      expect(result.hits[0]!.name).toContain("iPhone 17 Pro Max");
    });

    it("paginates and reports an accurate total", async () => {
      const first = await m.search.searchProducts("iPhone", { page: 1, pageSize: 12 });
      expect(first.pagination.page).toBe(1);
      expect(first.pagination.total).toBe(first.hits.length);
      expect(first.pagination.totalPages).toBe(1);
    });

    it("ignores a query that is too short to search", async () => {
      const result = await m.search.searchProducts("i");
      expect(result.hits).toEqual([]);
      expect(result.pagination.total).toBe(0);
    });

    it("logs queries and surfaces zero-result terms", async () => {
      await m.search.logSearchQuery({ query: `${P} definitely-not-a-real-thing`, resultCount: 0 });
      await m.search.logSearchQuery({ query: `${P} iphone`, resultCount: 2 });
      const zeros = await m.search.getZeroResultQueries({ limit: 50 });
      // Logged queries are normalized (tokenized, deduped, sorted), so the
      // hyphenated phrase is stored as its separate words.
      expect(zeros.some((row) => row.query.includes("definitely") && row.query.includes("real"))).toBe(true);
    });

    it("rebuilds suggestions from the real catalog", async () => {
      const counts = await m.search.refreshSuggestions({ limitPerKind: 200 });
      expect(counts.products).toBeGreaterThan(0);

      const suggestions = await m.search.getSuggestions(`${P} Apple iPh`);
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.some((suggestion) => suggestion.kind === "PRODUCT")).toBe(true);
    });

    it("returns related products from the same category", async () => {
      const { productSearchIndex } = m.schema;
      const [phone] = await m.db
        .select({ productId: productSearchIndex.productId })
        .from(productSearchIndex)
        .where(m.eq(productSearchIndex.name, `${P} Apple iPhone 17 Pro Max 256GB`));
      const related = await m.search.getRelatedProducts(phone!.productId, { limit: 4 });
      expect(related.length).toBeGreaterThan(0);
      expect(related.every((row) => row.productId !== phone!.productId)).toBe(true);
    });
  });
});
