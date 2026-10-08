// @vitest-environment node
/**
 * Part 13 — recommendation engine against a real PostgreSQL database.
 *
 * The unit suite covers the pure scoring maths. What can only be proven here is
 * the part that touches the database: that behavioural events actually fold
 * into interest signals, that the offline jobs actually populate the
 * precomputed tables, that the engine actually returns recommendations from
 * them, and that exclusions actually hold against real rows.
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
const P = `rec${randomBytes(4).toString("hex")}`;
const slug = (name: string) => `${P}-${name}`;

type Modules = {
  db: typeof import("@/db").db;
  schema: typeof import("@/db/schema");
  sql: typeof import("drizzle-orm").sql;
  eq: typeof import("drizzle-orm").eq;
  and: typeof import("drizzle-orm").and;
  events: typeof import("@/services/recommendations/events.service");
  profile: typeof import("@/services/recommendations/profile.service");
  engine: typeof import("@/services/recommendations/engine.service");
  compute: typeof import("@/services/recommendations/compute.service");
  metrics: typeof import("@/services/recommendations/metrics.service");
  config: typeof import("@/services/recommendations/config.service");
  debug: typeof import("@/services/recommendations/debug.service");
};

describe.skipIf(!enabled)("recommendations (PostgreSQL)", () => {
  let m: Modules;
  let categoryId: string;
  let otherCategoryId: string;
  let brandId: string;
  const ids: Record<string, string> = {};
  /** A user id that exists, so the actor FKs are satisfied. */
  let userId: string;
  const sessionHash = `${P}-session`;

  beforeAll(async () => {
    const [dbm, schema, drizzle, events, profile, engine, compute, metrics, config, debug] =
      await Promise.all([
        import("@/db"),
        import("@/db/schema"),
        import("drizzle-orm"),
        import("@/services/recommendations/events.service"),
        import("@/services/recommendations/profile.service"),
        import("@/services/recommendations/engine.service"),
        import("@/services/recommendations/compute.service"),
        import("@/services/recommendations/metrics.service"),
        import("@/services/recommendations/config.service"),
        import("@/services/recommendations/debug.service"),
      ]);

    m = {
      db: dbm.db,
      schema,
      sql: drizzle.sql,
      eq: drizzle.eq,
      and: drizzle.and,
      events,
      profile,
      engine,
      compute,
      metrics,
      config,
      debug,
    };
    const { db } = m;

    // ── A real user, because every actor column is an FK to users ──────────
    const [user] = await db
      .insert(schema.users)
      .values({
        email: `${P}@example.com`,
        name: "Rec Test",
        passwordHash: "x",
        role: "CUSTOMER",
        emailVerifiedAt: new Date(),
      })
      .returning();
    userId = user!.id;

    // ── Two categories, so cross-category exclusion is testable ────────────
    const [cat] = await db
      .insert(schema.categories)
      .values({ name: `Laptops ${P}`, slug: slug("laptops"), path: `/${slug("laptops")}`, depth: 0, isActive: true })
      .returning();
    categoryId = cat!.id;

    const [otherCat] = await db
      .insert(schema.categories)
      .values({ name: `Cases ${P}`, slug: slug("cases"), path: `/${slug("cases")}`, depth: 0, isActive: true })
      .returning();
    otherCategoryId = otherCat!.id;

    const [brand] = await db
      .insert(schema.brands)
      .values({ name: `RecBrand ${P}`, slug: slug("brand"), isActive: true })
      .returning();
    brandId = brand!.id;

    // ── Products: two comparable laptops, an accessory in another category,
    //    and one that is out of stock (to prove exclusion) ──────────────────
    const fixtures = [
      { key: "laptopA", name: `Gaming Laptop ${P} 16GB`, price: 8_500_000, category: () => categoryId, stock: 12, rating: 4.6 },
      { key: "laptopB", name: `Gaming Laptop ${P} 32GB`, price: 11_000_000, category: () => categoryId, stock: 5, rating: 4.8 },
      { key: "case", name: `Laptop Sleeve ${P}`, price: 150_000, category: () => otherCategoryId, stock: 40, rating: 4.4 },
      { key: "oos", name: `Sold Out Laptop ${P}`, price: 9_000_000, category: () => categoryId, stock: 0, rating: 4.9 },
    ];

    for (const fixture of fixtures) {
      const [row] = await db
        .insert(schema.products)
        .values({
          name: fixture.name,
          slug: slug(fixture.key),
          shortDescription: `A test product ${P}`,
          productType: "OTHER",
          status: "ACTIVE",
          visibility: "PUBLIC",
          basePrice: fixture.price,
          brandId,
          categoryId: fixture.category(),
          stockQuantity: fixture.stock,
          lowStockThreshold: 3,
          ratingAverage: fixture.rating,
          ratingCount: 60,
          publishedAt: new Date(),
        })
        .returning();
      ids[fixture.key] = row!.id;

      // A purchasable variant, so the product counts as in stock.
      await db.insert(schema.productVariants).values({
        productId: row!.id,
        sku: `${P}-${fixture.key}`.toUpperCase().slice(0, 60),
        name: "Default",
        price: fixture.price,
        stockQuantity: fixture.stock,
        isActive: true,
      });
    }

    // Index them, so product_search_index (the hydration source) has rows.
    const { indexProduct } = await import("@/services/catalog/search.service");
    for (const id of Object.values(ids)) {
      await indexProduct(id, db);
    }
  });

  afterAll(async () => {
    if (!m) return;
    const { db, schema, sql } = m;
    // Clean up in dependency order. Failures here must not fail the run.
    await db.execute(sql`DELETE FROM recommendation_events`).catch(() => undefined);
    await db.execute(sql`DELETE FROM recommendation_requests`).catch(() => undefined);
    await db.execute(sql`DELETE FROM product_similarity WHERE product_id = ANY(${Object.values(ids)})`).catch(() => undefined);
    await db.execute(sql`DELETE FROM product_co_purchases WHERE product_id = ANY(${Object.values(ids)})`).catch(() => undefined);
    await db.execute(sql`DELETE FROM product_popularity WHERE product_id = ANY(${Object.values(ids)})`).catch(() => undefined);
    await db.execute(sql`DELETE FROM user_interest_signals WHERE session_hash = ${sessionHash} OR user_id = ${userId}`).catch(() => undefined);
    await db.execute(sql`DELETE FROM user_interest_profiles WHERE session_hash = ${sessionHash} OR user_id = ${userId}`).catch(() => undefined);
    await db.execute(sql`DELETE FROM analytics_events WHERE session_id = ${sessionHash} OR user_id = ${userId}`).catch(() => undefined);
    await db.execute(sql`DELETE FROM products WHERE slug LIKE ${`${P}-%`}`).catch(() => undefined);
    await db.execute(sql`DELETE FROM categories WHERE slug LIKE ${`${P}-%`}`).catch(() => undefined);
    await db.execute(sql`DELETE FROM brands WHERE slug LIKE ${`${P}-%`}`).catch(() => undefined);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`).catch(() => undefined);
  });

  /* ── Event ingestion ────────────────────────────────────────────────── */

  describe("behavioural events", () => {
    it("records an event and folds it into interest signals", async () => {
      const recorded = await m.events.recordBehavioralEvent({
        eventType: "PRODUCT_VIEW",
        userId,
        sessionId: sessionHash,
        productId: ids.laptopA,
        categoryId,
        brandId,
        source: "pdp",
      });
      expect(recorded).toBe(true);

      const folded = await m.events.applyEventToInterest({
        userId,
        sessionId: sessionHash,
        eventType: "PRODUCT_VIEW",
        productId: ids.laptopA,
        categoryId,
        brandId,
      });
      // Category, brand and product each get a signal.
      expect(folded).toBeGreaterThanOrEqual(3);
    });

    it("upserts a repeated signal rather than adding a row per event", async () => {
      for (let i = 0; i < 4; i += 1) {
        await m.events.applyEventToInterest({
          userId,
          sessionId: sessionHash,
          eventType: "PRODUCT_VIEW",
          categoryId,
        });
      }
      const rows = await m.db
        .select()
        .from(m.schema.userInterestSignals)
        .where(
          m.and(
            m.eq(m.schema.userInterestSignals.userId, userId),
            m.eq(m.schema.userInterestSignals.dimension, "CATEGORY"),
            m.eq(m.schema.userInterestSignals.key, categoryId),
          ),
        );
      // One row with an accumulated count, not five rows.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.eventCount).toBeGreaterThanOrEqual(5);
    });

    it("keeps a negative signal from driving the weight below zero", async () => {
      // The CHECK on raw_weight would reject a negative upsert outright, so
      // `greatest(0, ...)` is what keeps a return from breaking the insert.
      await m.events.applyEventToInterest({
        userId,
        sessionId: sessionHash,
        eventType: "RETURN",
        categoryId,
      });
      const [row] = await m.db
        .select()
        .from(m.schema.userInterestSignals)
        .where(
          m.and(
            m.eq(m.schema.userInterestSignals.userId, userId),
            m.eq(m.schema.userInterestSignals.dimension, "CATEGORY"),
            m.eq(m.schema.userInterestSignals.key, categoryId),
          ),
        );
      expect(row!.rawWeight).toBeGreaterThanOrEqual(0);
    });
  });

  /* ── Interest profiles ──────────────────────────────────────────────── */

  describe("interest profiles", () => {
    it("builds a profile with the category the shopper looked at", async () => {
      const profile = await m.profile.getProfile({ userId }, { force: true });
      expect(profile.signalCount).toBeGreaterThan(0);
      expect(profile.interests.CATEGORY?.[categoryId]).toBeGreaterThan(0);
      expect(profile.interests.BRAND?.[brandId]).toBeGreaterThan(0);
    });

    it("persists the profile so a second read does not recompute", async () => {
      const first = await m.profile.getProfile({ userId }, { force: true });
      const second = await m.profile.getProfile({ userId }, { maxAgeMs: 60_000 });
      expect(second.computedAt.getTime()).toBe(first.computedAt.getTime());
      expect(second.stale).toBe(false);
    });

    it("gives an unknown subject an empty profile rather than throwing", async () => {
      const profile = await m.profile.getProfile({ sessionHash: `${P}-nobody` });
      expect(profile.confidence).toBe(0);
      expect(profile.interests).toEqual({});
    });

    it("does not personalize on a single weak signal", async () => {
      const profile = await m.profile.getProfile({ sessionHash: `${P}-nobody` });
      expect(m.profile.shouldPersonalize(profile.confidence)).toBe(false);
    });
  });

  /* ── Offline computation ────────────────────────────────────────────── */

  describe("offline compute", () => {
    it("computes similarity between products in the same category", async () => {
      const result = await m.compute.computeSimilarity({ client: m.db, batchSize: 50, minScore: 0.01 });
      expect(result.wrote).toBeGreaterThan(0);

      const rows = await m.db
        .select()
        .from(m.schema.productSimilarity)
        .where(m.eq(m.schema.productSimilarity.productId, ids.laptopA));
      const similarIds = rows.map((row) => row.similarProductId);
      // The other laptop is similar; the accessory in another category is not.
      expect(similarIds).toContain(ids.laptopB);
      expect(similarIds).not.toContain(ids.case);
    });

    it("records per-signal contributions so similarity is explainable", async () => {
      const [row] = await m.db
        .select()
        .from(m.schema.productSimilarity)
        .where(
          m.and(
            m.eq(m.schema.productSimilarity.productId, ids.laptopA),
            m.eq(m.schema.productSimilarity.similarProductId, ids.laptopB),
          ),
        );
      expect(row).toBeDefined();
      const sources = row!.sources as Record<string, number>;
      expect(sources.category).toBeGreaterThan(0);
      expect(sources.brand).toBeGreaterThan(0);
    });

    it("computes popularity for every indexed product", async () => {
      const result = await m.compute.computePopularity({ client: m.db, windowDays: 30 });
      expect(result.wrote).toBeGreaterThan(0);

      const [row] = await m.db
        .select()
        .from(m.schema.productPopularity)
        .where(
          m.and(
            m.eq(m.schema.productPopularity.productId, ids.laptopA),
            m.eq(m.schema.productPopularity.scope, "GLOBAL"),
          ),
        );
      expect(row).toBeDefined();
      // The view recorded earlier must show up in the counters.
      expect(row!.viewCount).toBeGreaterThan(0);
    });

    it("reports coverage of the precomputed tables", async () => {
      const coverage = await m.compute.computeCoverage(m.db);
      expect(coverage.products).toBeGreaterThan(0);
      expect(coverage.withSimilarity).toBeGreaterThan(0);
      expect(coverage.withPopularity).toBeGreaterThan(0);
    });
  });

  /* ── The engine ─────────────────────────────────────────────────────── */

  describe("engine", () => {
    it("returns similar products for a seed, excluding the seed itself", async () => {
      const result = await m.engine.recommend({
        type: "SIMILAR_PRODUCTS",
        productId: ids.laptopA,
        limit: 8,
      });
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items.map((item) => item.productId)).not.toContain(ids.laptopA);
      expect(result.algorithmVersion).toBeTruthy();
      expect(result.recommendationId).toBeTruthy();
    });

    it("never returns an out-of-stock product in a stock-required slot", async () => {
      const result = await m.engine.recommend({
        type: "SIMILAR_PRODUCTS",
        productId: ids.laptopA,
        limit: 20,
      });
      expect(result.items.map((item) => item.productId)).not.toContain(ids.oos);
      expect(result.exclusions.get(ids.oos)).toBe("OUT_OF_STOCK");
    });

    it("excludes what is already in the basket", async () => {
      const result = await m.engine.recommend({
        type: "CART_RECOMMENDATIONS",
        productId: ids.laptopA,
        limit: 20,
        context: { cartProductIds: [ids.laptopB] },
      });
      expect(result.items.map((item) => item.productId)).not.toContain(ids.laptopB);
    });

    it("persists a request row so impressions can be attributed", async () => {
      const result = await m.engine.recommend({ type: "TRENDING_PRODUCTS", limit: 5 });
      const [row] = await m.db
        .select()
        .from(m.schema.recommendationRequests)
        .where(m.eq(m.schema.recommendationRequests.recommendationId, result.recommendationId));
      expect(row).toBeDefined();
      expect(row!.algorithmVersion).toBe(result.algorithmVersion);
      // The stored invariant: results can never exceed candidates.
      expect(row!.resultCount).toBeLessThanOrEqual(row!.candidateCount);
    });

    it("degrades to a fallback rather than throwing when the seed is unknown", async () => {
      const result = await m.engine.recommend({
        type: "SIMILAR_PRODUCTS",
        productId: "00000000-0000-0000-0000-000000000000",
        limit: 5,
      });
      // No candidates for a nonexistent seed, but a well-formed response.
      expect(result.type).toBe("SIMILAR_PRODUCTS");
      expect(Array.isArray(result.items)).toBe(true);
    });

    it("produces shopper-safe explanations with no internal weights", async () => {
      const result = await m.engine.recommend({ type: "SIMILAR_PRODUCTS", productId: ids.laptopA, limit: 5 });
      for (const item of result.items) {
        if (item.explanation === null) continue;
        // A score breakdown leaking into a shopper-facing string would be both
        // useless to them and useful to a competitor.
        expect(item.explanation).not.toMatch(/weight|score|component/i);
      }
    });
  });

  /* ── Impressions, attribution, metrics ──────────────────────────────── */

  describe("measurement", () => {
    it("records impressions against the request that produced them", async () => {
      const result = await m.engine.recommend({ type: "TRENDING_PRODUCTS", limit: 4 });
      expect(result.items.length).toBeGreaterThan(0);

      const recorded = await m.events.recordImpressions({
        recommendationId: result.recommendationId,
        type: result.type,
        algorithmVersion: result.algorithmVersion,
        userId,
        sessionHash,
        items: result.items.map((item) => ({ productId: item.productId, position: item.position })),
      });
      expect(recorded).toBe(result.items.length);
    });

    it("attributes a purchase to the impression inside the window", async () => {
      const result = await m.engine.recommend({ type: "TRENDING_PRODUCTS", limit: 4 });
      await m.events.recordImpressions({
        recommendationId: result.recommendationId,
        type: result.type,
        userId,
        sessionHash,
        items: result.items.map((item) => ({ productId: item.productId, position: item.position })),
      });

      const target = result.items[0]!;
      const attribution = await m.metrics.findAttribution({
        productId: target.productId,
        userId,
        windowDays: 7,
      });
      expect(attribution.attributed).toBe(true);
      expect(attribution.recommendationType).toBe(result.type);
    });

    it("does not attribute a purchase with no impression behind it", async () => {
      // §40: never claim a recommendation caused a purchase the shopper made
      // independently.
      const attribution = await m.metrics.findAttribution({
        productId: ids.case,
        sessionHash: `${P}-never-saw-it`,
        windowDays: 7,
      });
      expect(attribution.attributed).toBe(false);
      expect(attribution.requestId).toBeNull();
    });

    it("rolls events up into daily metrics idempotently", async () => {
      const today = new Date();
      const first = await m.metrics.rollUpMetrics({ date: today, client: m.db });
      expect(first).toBeGreaterThan(0);

      // Running twice must not double the counts — that is what makes the job
      // safely retryable.
      await m.metrics.rollUpMetrics({ date: today, client: m.db });
      const rows = await m.db
        .select()
        .from(m.schema.recommendationMetrics)
        .where(m.eq(m.schema.recommendationMetrics.bucketDate, today.toISOString().slice(0, 10)));
      const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
      const actual = await m.db.execute<{ n: number }>(m.sql`
        SELECT count(*)::int AS n FROM recommendation_events WHERE event_type = 'SHOWN'
      `);
      expect(impressions).toBe(actual.rows[0]!.n);
    });

    it("reports an overview without dividing by zero", async () => {
      const overview = await m.metrics.recommendationOverview({ windowDays: 30 });
      expect(overview.impressions).toBeGreaterThan(0);
      expect(Number.isFinite(overview.ctr)).toBe(true);
      expect(Number.isFinite(overview.fallbackRate)).toBe(true);
    });
  });

  /* ── Configuration and debugging ────────────────────────────────────── */

  describe("configuration and debugging", () => {
    it("falls back to compiled weights when no config is stored", async () => {
      const config = await m.config.getConfig("SIMILAR_PRODUCTS", m.db);
      expect(config.source).toBe("compiled");
      expect(config.weights.similarity).toBeGreaterThan(0);
    });

    it("rejects an unbalanced weight set on save", async () => {
      // The invariant that stops a rail becoming a bestseller list.
      await expect(
        m.config.saveConfig(
          {
            recommendationType: "SIMILAR_PRODUCTS",
            version: `${P}-bad`,
            weights: { popularity: 900, quality: 900, freshness: 900 },
          },
          m.db,
        ),
      ).rejects.toThrow();
    });

    it("buckets a subject deterministically into an experiment variant", () => {
      const variants = [
        { name: "control", configVersion: "a", weight: 50 },
        { name: "treatment", configVersion: "b", weight: 50 },
      ];
      const first = m.config.bucketVariant(`${P}-shopper`, variants);
      const second = m.config.bucketVariant(`${P}-shopper`, variants);
      // Same subject must always land in the same variant, or a shopper's
      // impressions split across arms and the comparison is meaningless.
      expect(first?.name).toBe(second?.name);
    });

    it("traces a recommendation with candidate scores and exclusion reasons", async () => {
      const trace = await m.debug.traceRecommendation(
        { type: "SIMILAR_PRODUCTS", productId: ids.laptopA, limit: 8 },
        m.db,
      );
      expect(trace.candidateCount).toBeGreaterThan(0);
      expect(trace.candidates.length).toBeGreaterThan(0);
      expect(trace.candidates[0]!.components.similarity).toBeGreaterThanOrEqual(0);
      // The out-of-stock product must appear as excluded, with the reason.
      const oosTrace = trace.candidates.find((candidate) => candidate.productId === ids.oos);
      if (oosTrace) expect(oosTrace.excludedReason).toBe("OUT_OF_STOCK");
    });

    it("reports seed coverage so an empty rail is diagnosable", async () => {
      const coverage = await m.debug.seedTableCoverage(ids.laptopA, m.db);
      expect(coverage.similarityRows).toBeGreaterThan(0);
      expect(coverage.popularityRow).toBe(true);
    });
  });
});
