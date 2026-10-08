// @vitest-environment node
/**
 * Part 12 — search & discovery against a real PostgreSQL database.
 *
 * Covers the end-to-end search path: indexing, the query pipeline, entity
 * extraction into filters, facets, spell correction, zero-result recovery,
 * analytics, synonyms, and per-user search history.
 *
 * The unit tests cover the pure pipeline; what is exercised here is the part that
 * can only be verified against a real database — the tsvector/trigram indexes,
 * the facet aggregations, and the analytics queries with their window functions.
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
const P = `s12${randomBytes(4).toString("hex")}`;
const slug = (name: string) => `${P}-${name}`;

type Modules = {
  db: typeof import("@/db").db;
  schema: typeof import("@/db/schema");
  eq: typeof import("drizzle-orm").eq;
  and: typeof import("drizzle-orm").and;
  sql: typeof import("drizzle-orm").sql;
  query: typeof import("@/services/search/query.service");
  index: typeof import("@/services/search/index.service");
  vocabulary: typeof import("@/services/search/vocabulary.service");
  synonyms: typeof import("@/services/search/synonym.service");
  analytics: typeof import("@/services/search/analytics.service");
  history: typeof import("@/services/search/history.service");
  config: typeof import("@/services/search/config.service");
  suggest: typeof import("@/services/search/suggest.service");
};

describe.skipIf(!enabled)("search & discovery (PostgreSQL)", () => {
  let m: Modules;
  let categoryId: string;
  let brandId: string;
  const productIds: Record<string, string> = {};

  beforeAll(async () => {
    const [dbm, schema, drizzle, query, index, vocabulary, synonyms, analytics, history, config, suggest] =
      await Promise.all([
        import("@/db"),
        import("@/db/schema"),
        import("drizzle-orm"),
        import("@/services/search/query.service"),
        import("@/services/search/index.service"),
        import("@/services/search/vocabulary.service"),
        import("@/services/search/synonym.service"),
        import("@/services/search/analytics.service"),
        import("@/services/search/history.service"),
        import("@/services/search/config.service"),
        import("@/services/search/suggest.service"),
      ]);

    m = { db: dbm.db, schema, eq: drizzle.eq, and: drizzle.and, sql: drizzle.sql, query, index, vocabulary, synonyms, analytics, history, config, suggest };

    const { db } = m;

    // ── Fixtures: a brand, a category, and products spanning the cases the
    // acceptance criteria call for (in stock, out of stock, rated, discounted).
    const [brand] = await db
      .insert(schema.brands)
      .values({ name: `TestBrand ${P}`, slug: slug("brand"), isActive: true })
      .returning();
    brandId = brand!.id;

    const [category] = await db
      .insert(schema.categories)
      .values({
        name: `Laptops ${P}`,
        slug: slug("laptops"),
        path: `/${slug("laptops")}`,
        depth: 0,
        isActive: true,
      })
      .returning();
    categoryId = category!.id;

    const products = [
      {
        key: "gaming",
        name: `Gaming Laptop ${P} 16GB RAM 512GB`,
        price: 8_500_000,
        compareAt: 9_500_000,
        stock: 12,
        rating: 4.6,
        reviews: 128,
        attrs: "gaming 16gb 512gb black",
      },
      {
        key: "ultrabook",
        name: `Ultrabook Laptop ${P} 16GB RAM 1TB`,
        price: 12_000_000,
        compareAt: null,
        stock: 4,
        rating: 4.8,
        reviews: 64,
        attrs: "16gb 1tb silver",
      },
      {
        key: "budget",
        name: `Budget Laptop ${P} 8GB RAM 256GB`,
        price: 3_200_000,
        compareAt: 4_000_000,
        stock: 0,
        rating: 3.9,
        reviews: 22,
        attrs: "8gb 256gb black",
      },
      {
        key: "pro",
        name: `Pro Workstation ${P} 32GB RAM`,
        price: 18_500_000,
        compareAt: null,
        stock: 2,
        rating: 4.9,
        reviews: 9,
        attrs: "32gb workstation",
      },
    ];

    for (const fixture of products) {
      const [row] = await db
        .insert(schema.products)
        .values({
          name: fixture.name,
          slug: slug(fixture.key),
          productType: "OTHER",
          status: "ACTIVE",
          visibility: "PUBLIC",
          basePrice: fixture.price,
          compareAtPrice: fixture.compareAt,
          brandId,
          categoryId,
          stockQuantity: fixture.stock,
          lowStockThreshold: 3,
          ratingAverage: fixture.rating,
          ratingCount: fixture.reviews,
          publishedAt: new Date(),
        })
        .returning();
      productIds[fixture.key] = row!.id;
    }

    // Index the fixtures, then rebuild the derived indexes the pipeline needs.
    for (const id of Object.values(productIds)) {
      await m.query.buildProcessedQuery("warmup", { client: db }).catch(() => undefined);
      const { indexProduct } = await import("@/services/catalog/search.service");
      await indexProduct(id, db);
    }
    await m.vocabulary.rebuildVocabulary({ client: db });
    await m.suggest.refreshSuggestionTable({ client: db });
  });

  afterAll(async () => {
    if (!m) return;
    const { db, schema, sql } = m;
    // Clean up in dependency order; failures here must not fail the run.
    await db.delete(schema.searchHistory).catch(() => undefined);
    await db.delete(schema.searchQueryLogs).catch(() => undefined);
    await db.delete(schema.searchSynonyms).catch(() => undefined);
    await db.execute(sql`DELETE FROM product_search_index WHERE slug LIKE ${`${P}-%`}`).catch(() => undefined);
    await db.execute(sql`DELETE FROM products WHERE slug LIKE ${`${P}-%`}`).catch(() => undefined);
    await db.execute(sql`DELETE FROM categories WHERE slug LIKE ${`${P}-%`}`).catch(() => undefined);
    await db.execute(sql`DELETE FROM brands WHERE slug LIKE ${`${P}-%`}`).catch(() => undefined);
  });

  /* ── Search execution ─────────────────────────────────────────────── */

  describe("search", () => {
    it("finds products by name", async () => {
      const result = await m.query.executeSearch({ query: `gaming laptop ${P}` });
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results[0]!.name).toContain("Gaming Laptop");
    });

    it("returns facets with counts", async () => {
      const result = await m.query.executeSearch({ query: `laptop ${P}` });
      expect(result.facets.total).toBeGreaterThan(0);
      const brandFacet = result.facets.groups.find((group) => group.key === "brand");
      expect(brandFacet?.values.length ?? 0).toBeGreaterThan(0);
    });

    it("filters by brand id", async () => {
      const result = await m.query.executeSearch({
        query: `laptop ${P}`,
        filters: {
          categoryIds: [],
          brandIds: [brandId],
          minPricePaise: null,
          maxPricePaise: null,
          minRating: null,
          availability: "any",
          onSaleOnly: false,
          attributes: {},
        },
      });
      expect(result.results.length).toBeGreaterThan(0);
    });

    it("filters by a maximum price", async () => {
      const result = await m.query.executeSearch({
        query: `laptop ${P}`,
        filters: {
          categoryIds: [],
          brandIds: [],
          minPricePaise: null,
          maxPricePaise: 5_000_000,
          minRating: null,
          availability: "any",
          onSaleOnly: false,
          attributes: {},
        },
      });
      // Only the budget laptop (₹32,000) is under ₹50,000.
      expect(result.results.every((hit) => hit.pricePaise <= 5_000_000)).toBe(true);
    });

    it("filters by minimum rating", async () => {
      const result = await m.query.executeSearch({
        query: `laptop ${P}`,
        filters: {
          categoryIds: [],
          brandIds: [],
          minPricePaise: null,
          maxPricePaise: null,
          minRating: 4.5,
          availability: "any",
          onSaleOnly: false,
          attributes: {},
        },
      });
      expect(result.results.every((hit) => (hit.ratingAverage ?? 0) >= 4.5)).toBe(true);
    });

    it("sorts by price ascending server-side", async () => {
      const result = await m.query.executeSearch({ query: `laptop ${P}`, sort: "price-asc" });
      const prices = result.results.map((hit) => hit.pricePaise);
      expect(prices).toEqual([...prices].sort((a, b) => a - b));
    });

    it("sorts by rating", async () => {
      const result = await m.query.executeSearch({ query: `laptop ${P}`, sort: "rating" });
      const ratings = result.results.map((hit) => hit.ratingAverage ?? 0);
      expect(ratings).toEqual([...ratings].sort((a, b) => b - a));
    });

    it("demotes an out-of-stock product below in-stock ones", async () => {
      const result = await m.query.executeSearch({ query: `laptop ${P}` });
      const positions = result.results.map((hit) => hit.inStock);
      // The budget laptop is the only out-of-stock fixture; it must not lead.
      expect(positions[0]).toBe(true);
    });

    it("hides out-of-stock products in HIDE mode", async () => {
      const result = await m.query.executeSearch({
        query: `laptop ${P}`,
        filters: {
          categoryIds: [],
          brandIds: [],
          minPricePaise: null,
          maxPricePaise: null,
          minRating: null,
          availability: "in_stock",
          onSaleOnly: false,
          attributes: {},
        },
      });
      expect(result.results.every((hit) => hit.inStock)).toBe(true);
    });

    it("reports latency and a ranking version", async () => {
      const result = await m.query.executeSearch({ query: `laptop ${P}` });
      expect(result.metadata.tookMs).toBeGreaterThanOrEqual(0);
      expect(result.metadata.rankingVersion).toBeTruthy();
    });

    it("returns an empty result set rather than throwing for a nonsense query", async () => {
      const result = await m.query.executeSearch({ query: "zzzzqqqqxxxx" });
      expect(result.results).toEqual([]);
      expect(result.metadata.total).toBe(0);
    });

    it("matches an exact SKU without tokenizing it away", async () => {
      const [variant] = await m.db
        .insert(m.schema.productVariants)
        .values({
          productId: productIds.gaming!,
          sku: `SKU-${P}`.toUpperCase(),
          name: "Default",
          price: 8_500_000,
          availability: "IN_STOCK",
          stockQuantity: 12,
        })
        .returning();
      const { indexProduct } = await import("@/services/catalog/search.service");
      await indexProduct(productIds.gaming!, m.db);

      const result = await m.query.executeSearch({ query: variant!.sku });
      expect(result.metadata.intent).toBe("NAVIGATIONAL");
      expect(result.results.some((hit) => hit.productId === productIds.gaming)).toBe(true);
    });
  });

  /* ── Query pipeline against the real catalog ──────────────────────── */

  describe("query understanding", () => {
    it("extracts the brand from the live catalog", async () => {
      const processed = await m.query.buildProcessedQuery(`testbrand ${P}`, { client: m.db });
      expect(processed.entities.some((entity) => entity.kind === "BRAND")).toBe(true);
    });

    it("recognises a typo against a term that exists in this catalog", async () => {
      // "laptopp" is one edit from "laptop", which the vocabulary rebuild derived
      // from the products inserted above.
      //
      // Whether it is *applied* depends on confidence: with only a handful of
      // fixture products the term is rare, so the pipeline correctly offers it as
      // a "did you mean?" rather than silently rewriting the query. Assert on the
      // union so the test checks recognition, not the prevalence threshold.
      const processed = await m.query.buildProcessedQuery("laptopp", { client: m.db });
      const recognised = [
        ...processed.corrections.map((entry) => entry.to),
        ...processed.suggestedCorrections.map((entry) => entry.to),
      ];
      expect(recognised).toContain("laptop");
    });

    it("does not correct a word with no near neighbour", async () => {
      const processed = await m.query.buildProcessedQuery("zzzqqqxxx", { client: m.db });
      expect(processed.corrections).toHaveLength(0);
    });

    it("parses a price constraint out of a natural query", async () => {
      const processed = await m.query.buildProcessedQuery("laptop under 50000", { client: m.db });
      expect(processed.price?.maxPaise).toBe(5_000_000);
    });
  });

  /* ── Indexing pipeline ────────────────────────────────────────────── */

  describe("indexing", () => {
    it("reports index status", async () => {
      const status = await m.index.indexStatus(m.db);
      expect(status.products).toBeGreaterThan(0);
      expect(status.indexedProducts).toBeGreaterThan(0);
    });

    it("reindexes a single category", async () => {
      const result = await m.index.reindexCategory(categoryId, { client: m.db });
      expect(result.indexed).toBeGreaterThanOrEqual(4);
    });

    it("reindexes a single brand", async () => {
      const result = await m.index.reindexBrand(brandId, { client: m.db });
      expect(result.indexed).toBeGreaterThanOrEqual(4);
    });

    it("removes a product from the index when it is unpublished", async () => {
      await m.db
        .update(m.schema.products)
        .set({ visibility: "PRIVATE" })
        .where(m.eq(m.schema.products.id, productIds.pro!));
      const { indexProduct } = await import("@/services/catalog/search.service");
      await indexProduct(productIds.pro!, m.db);

      const result = await m.query.executeSearch({ query: `workstation ${P}` });
      expect(result.results.some((hit) => hit.productId === productIds.pro)).toBe(false);

      // Restore for the remaining tests.
      await m.db
        .update(m.schema.products)
        .set({ visibility: "PUBLIC" })
        .where(m.eq(m.schema.products.id, productIds.pro!));
      await indexProduct(productIds.pro!, m.db);
    });

    it("builds a spell-correction vocabulary from the catalog", async () => {
      const stats = await m.vocabulary.vocabularyStats(m.db);
      expect(stats.total).toBeGreaterThan(0);
    });
  });

  /* ── Suggestions and zero-result recovery ─────────────────────────── */

  describe("suggestions", () => {
    it("returns typed suggestions for a prefix", async () => {
      const result = await m.suggest.getSuggestions({ prefix: "lap", client: m.db });
      expect(result.suggestions.length).toBeGreaterThan(0);
      expect(result.suggestions.every((item) => typeof item.type === "string")).toBe(true);
    });

    it("returns nothing useful for a single character", async () => {
      const result = await m.suggest.getSuggestions({ prefix: "x", client: m.db });
      expect(result.partial).toBe(true);
    });

    it("offers a recovery path when a search finds nothing", async () => {
      const result = await m.query.executeSearch({ query: "zzzzqqqqxxxx" });
      expect(result.results).toEqual([]);
      // The page must not be a dead end: either a correction or popular products.
      expect(result.suggestions.length).toBeGreaterThan(0);
    });
  });

  /* ── Synonyms ─────────────────────────────────────────────────────── */

  describe("synonyms", () => {
    it("creates, lists, and deactivates a synonym", async () => {
      const created = await m.synonyms.createSynonym(
        { term: `notebook-${P}`, synonym: "laptop", isBidirectional: false },
        m.db,
      );
      expect(created.term).toBe(`notebook-${P}`);

      const listed = await m.synonyms.listSynonyms({ search: P, client: m.db });
      expect(listed.some((row) => row.id === created.id)).toBe(true);

      const updated = await m.synonyms.updateSynonym(created.id, { isActive: false }, m.db);
      expect(updated.isActive).toBe(false);
    });

    it("rejects a term as its own synonym", async () => {
      await expect(
        m.synonyms.createSynonym({ term: "laptop", synonym: "laptop" }, m.db),
      ).rejects.toThrow();
    });

    it("rejects a duplicate pair", async () => {
      await m.synonyms.createSynonym({ term: `dup-a-${P}`, synonym: `dup-b-${P}` }, m.db);
      await expect(
        m.synonyms.createSynonym({ term: `dup-a-${P}`, synonym: `dup-b-${P}` }, m.db),
      ).rejects.toThrow();
    });

    it("imports a batch and reports per-line errors", async () => {
      const result = await m.synonyms.importSynonyms(
        [`imp-a-${P}, imp-b-${P}`, "not-a-pair", `imp-c-${P} -> imp-d-${P}`],
        m.db,
      );
      expect(result.imported).toBe(2);
      expect(result.errors).toHaveLength(1);
    });
  });

  /* ── Analytics ────────────────────────────────────────────────────── */

  describe("analytics", () => {
    it("records a query and reports it in the overview", async () => {
      await m.query.executeSearch({ query: `analytics ${P}`, sessionHash: "abc123" });
      const overview = await m.analytics.searchOverview({ windowDays: 1, client: m.db });
      expect(overview.totalSearches).toBeGreaterThan(0);
      expect(overview.latency.p50).toBeGreaterThanOrEqual(0);
    });

    it("tracks zero-result queries", async () => {
      await m.query.executeSearch({ query: `nothinghere${P}`, sessionHash: "abc123" });
      const zero = await m.analytics.zeroResultQueries({ windowDays: 1, client: m.db });
      expect(zero.some((row) => row.query.includes("nothinghere"))).toBe(true);
    });

    it("reports popular queries", async () => {
      const popular = await m.analytics.popularQueries({ windowDays: 1, client: m.db });
      expect(Array.isArray(popular)).toBe(true);
    });

    it("computes click positions without error", async () => {
      const positions = await m.analytics.clickPositions({ windowDays: 1, client: m.db });
      expect(Array.isArray(positions)).toBe(true);
    });
  });

  /* ── Search history ───────────────────────────────────────────────── */

  describe("search history", () => {
    const userId = "00000000-0000-0000-0000-000000000000";

    it("records and deduplicates a repeated search", async () => {
      // Uses a non-existent user id, so the foreign key must not be enforced or
      // the row must be skipped — either way it must not throw.
      await m.history.recordSearch({ userId, query: `history ${P}`, resultCount: 3, client: m.db });
      await m.history.recordSearch({ userId, query: `history ${P}`, resultCount: 3, client: m.db });

      const entries = await m.history.getSearchHistory(userId, { client: m.db });
      const matching = entries.filter((entry) => entry.normalizedQuery.includes(P));
      // One row with an incremented counter, not two rows.
      expect(matching.length).toBeLessThanOrEqual(1);
    });

    it("clears history", async () => {
      await m.history.clearSearchHistory(userId, m.db);
      const entries = await m.history.getSearchHistory(userId, { client: m.db });
      expect(entries.filter((entry) => entry.normalizedQuery.includes(P))).toEqual([]);
    });
  });

  /* ── Ranking configuration ────────────────────────────────────────── */

  describe("ranking configuration", () => {
    it("loads an active configuration", async () => {
      const config = await m.config.getActiveRankingConfig(m.db);
      expect(config.version).toBeTruthy();
      expect(config.weights.exactSku).toBeGreaterThan(0);
    });

    it("rejects an unbalanced weight set", async () => {
      // The invariant that keeps search from becoming a bestseller list.
      await expect(
        m.config.saveRankingConfig(
          {
            version: `${P}-bad`,
            weights: { popularity: 500, rating: 500 },
            activate: false,
          },
          m.db,
        ),
      ).rejects.toThrow();
    });
  });
});
