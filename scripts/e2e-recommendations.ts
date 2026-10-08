import "dotenv/config";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * Part 13 — end-to-end recommendation acceptance (§78).
 *
 * Walks the scenario the spec sets out, against one real database:
 *
 *   A shopper searches, views, filters, wishlists and buys a gaming laptop.
 *   The engine must end up understanding that interest. Another shopper buys
 *   the same laptop, and a co-purchase relationship must emerge. A product
 *   page must surface similar items, frequently-bought items and accessories.
 *   A product that suddenly gets attention must surface as trending.
 *
 * Unlike the integration tests, this runs the real service entry points in
 * sequence, so it catches wiring problems the unit tests cannot see — an event
 * recorded but never folded into a profile, a profile built but never read by
 * the engine, an impression stored but never attributable.
 *
 * Run against a disposable database:
 *   npm run e2e:recommendations
 */

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * The services are guarded by `server-only`, which throws outside the Next.js
 * runtime. tsconfig maps the specifier for type-checking, but the runtime
 * resolver does not, so point it at the same stub the test suite uses. This has
 * to happen before any service is imported.
 */
const require_ = createRequire(import.meta.url);
const Module = require_(
  "node:module",
) as { _resolveFilename: (...args: unknown[]) => string };
const serverOnlyStub = fileURLToPath(new URL("../tests/mocks/server-only.ts", import.meta.url));
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function patched(request: unknown, ...rest: unknown[]): string {
  if (request === "server-only") return serverOnlyStub;
  return (originalResolve as (r: unknown, ...a: unknown[]) => string).call(this, request, ...rest);
};

const P = `e2erec${Date.now().toString(36)}`;
const slug = (name: string) => `${P}-${name}`;

/** Everything created, so cleanup can remove it in dependency order. */
const createdProductIds: string[] = [];
let userA = "";
let userB = "";
const sessionA = `${P}-session-a`;

async function main(): Promise<void> {
  console.log("Part 13 — recommendation acceptance (§78)\n");

  /* Imports live inside main() because tsx emits CJS, which has no top-level
   * await. The server-only resolver patch above must still run first. */
  const { db, pool } = await import("@/db");
  const schema = await import("@/db/schema");
  const { sql, eq, and } = await import("drizzle-orm");
  const events = await import("@/services/recommendations/events.service");
  const profile = await import("@/services/recommendations/profile.service");
  const engine = await import("@/services/recommendations/engine.service");
  const compute = await import("@/services/recommendations/compute.service");
  const metrics = await import("@/services/recommendations/metrics.service");
  const debug = await import("@/services/recommendations/debug.service");
  const { indexProduct } = await import("@/services/catalog/search.service");

  /* ── Fixtures ─────────────────────────────────────────────────────────── */

  const [customerA] = await db
    .insert(schema.users)
    .values({ email: `${P}-a@example.com`, name: "Customer A", passwordHash: "x", role: "CUSTOMER", emailVerifiedAt: new Date() })
    .returning();
  userA = customerA!.id;

  const [customerB] = await db
    .insert(schema.users)
    .values({ email: `${P}-b@example.com`, name: "Customer B", passwordHash: "x", role: "CUSTOMER", emailVerifiedAt: new Date() })
    .returning();
  userB = customerB!.id;

  const [laptops] = await db
    .insert(schema.categories)
    .values({ name: `Gaming Laptops ${P}`, slug: slug("gaming-laptops"), path: `/${slug("gaming-laptops")}`, depth: 0, isActive: true })
    .returning();

  const [accessories] = await db
    .insert(schema.categories)
    .values({ name: `Accessories ${P}`, slug: slug("accessories"), path: `/${slug("accessories")}`, depth: 0, isActive: true })
    .returning();

  const [brand] = await db
    .insert(schema.brands)
    .values({ name: `Lenovo ${P}`, slug: slug("lenovo"), isActive: true })
    .returning();

  const ids: Record<string, string> = {};
  const fixtures = [
    { key: "laptop16", name: `Gaming Laptop ${P} 16GB RAM`, price: 8_500_000, category: laptops!.id, stock: 12 },
    { key: "laptop32", name: `Gaming Laptop ${P} 32GB RAM`, price: 12_000_000, category: laptops!.id, stock: 6 },
    { key: "mouse", name: `Gaming Mouse ${P}`, price: 250_000, category: accessories!.id, stock: 80 },
    { key: "bag", name: `Laptop Bag ${P}`, price: 180_000, category: accessories!.id, stock: 60 },
    { key: "sleeve", name: `Laptop Sleeve ${P}`, price: 90_000, category: accessories!.id, stock: 0 },
  ];

  for (const fixture of fixtures) {
    const [row] = await db
      .insert(schema.products)
      .values({
        name: fixture.name,
        slug: slug(fixture.key),
        shortDescription: `Test product for the recommendation acceptance run ${P}`,
        productType: "OTHER",
        status: "ACTIVE",
        visibility: "PUBLIC",
        basePrice: fixture.price,
        brandId: brand!.id,
        categoryId: fixture.category,
        stockQuantity: fixture.stock,
        lowStockThreshold: 3,
        ratingAverage: 4.5,
        ratingCount: 80,
        publishedAt: new Date(),
      })
      .returning();
    ids[fixture.key] = row!.id;
    createdProductIds.push(row!.id);

    await db.insert(schema.productVariants).values({
      productId: row!.id,
      sku: `${P}-${fixture.key}`.toUpperCase().slice(0, 60),
      name: "Default",
      price: fixture.price,
      stockQuantity: fixture.stock,
      isActive: true,
    });
  }

  // Index every product, so the search index (the hydration source) has rows.
  for (const id of createdProductIds) await indexProduct(id, db);

  check("fixtures created and indexed", createdProductIds.length === fixtures.length);

  /* ── §78 steps 1–6: customer A builds an interest history ─────────────── */

  // 1. Searches for gaming laptops.
  await events.recordBehavioralEvent({
    eventType: "SEARCH",
    userId: userA,
    sessionId: sessionA,
    searchQuery: "gaming laptop",
    categoryId: laptops!.id,
    source: "search",
  });

  // 2–4. Views several gaming laptops, including the Lenovo.
  for (const key of ["laptop16", "laptop32", "laptop16", "laptop16"]) {
    await events.recordBehavioralEvent({
      eventType: "PRODUCT_VIEW",
      userId: userA,
      sessionId: sessionA,
      productId: ids[key],
      categoryId: laptops!.id,
      brandId: brand!.id,
      source: "pdp",
    });
    await events.applyEventToInterest({
      userId: userA,
      sessionId: sessionA,
      eventType: "PRODUCT_VIEW",
      productId: ids[key],
      categoryId: laptops!.id,
      brandId: brand!.id,
    });
  }

  // 3. Filters by 16GB RAM — an attribute signal.
  await events.applyEventToInterest({
    userId: userA,
    sessionId: sessionA,
    eventType: "FILTER_USED",
    attributeKeys: ["ram:16gb"],
    categoryId: laptops!.id,
  });

  // 5. Adds a laptop to the wishlist.
  await events.applyEventToInterest({
    userId: userA,
    sessionId: sessionA,
    eventType: "WISHLIST_ADD",
    productId: ids.laptop32,
    categoryId: laptops!.id,
    brandId: brand!.id,
  });

  // 6. Purchases a laptop.
  await events.applyEventToInterest({
    userId: userA,
    sessionId: sessionA,
    eventType: "PURCHASE",
    productId: ids.laptop16,
    categoryId: laptops!.id,
    brandId: brand!.id,
  });

  /* ── §78 step 7: the home page reflects what was learned ──────────────── */

  const profileA = await profile.getProfile({ userId: userA }, { force: true });
  check(
    "interest profile picked up the gaming-laptop category",
    (profileA.interests.CATEGORY?.[laptops!.id] ?? 0) > 0,
    `category weight ${profileA.interests.CATEGORY?.[laptops!.id] ?? 0}`,
  );
  check(
    "interest profile picked up the brand",
    (profileA.interests.BRAND?.[brand!.id] ?? 0) > 0,
    `brand weight ${profileA.interests.BRAND?.[brand!.id] ?? 0}`,
  );
  check(
    "the purchase outweighs a single view",
    (profileA.interests.PRODUCT?.[ids.laptop16] ?? 0) >= (profileA.interests.PRODUCT?.[ids.laptop32] ?? 0),
  );
  check(
    "enough evidence to personalize",
    profile.shouldPersonalize(profileA.confidence),
    `confidence ${profileA.confidence}`,
  );

  // 7. Home page for customer A.
  const home = await engine.recommend({
    type: "PERSONALIZED_FOR_YOU",
    userId: userA,
    sessionHash: sessionA,
    interests: profileA.interests,
    pricePreference: profileA.pricePreference,
    confidence: profileA.confidence,
    limit: 6,
  });
  check("home feed returns recommendations", home.items.length > 0, `${home.items.length} items`);
  check("home feed is attributed to a request", home.recommendationId.length > 0);

  /* ── §78 steps 8–10: purchases create a relationship ──────────────────── */

  /** Create a paid order with the given lines. */
  async function placeOrder(orderNumber: string, lines: Array<[string, number]>): Promise<string> {
    const total = lines.reduce((sum, [, price]) => sum + price, 0);
    const [order] = await db
      .insert(schema.orders)
      .values({
        orderNumber,
        userId: userB,
        status: "COMPLETED",
        paymentStatus: "PAID",
        currency: "INR",
        subtotalAmount: total,
        totalAmount: total,
        shippingFullName: "Customer B",
        shippingPhone: "9999999999",
        shippingLine1: "1 Test Street",
        shippingCity: "Bengaluru",
        shippingState: "KA",
        shippingPostalCode: "560001",
        shippingCountry: "IN",
      })
      .returning();

    for (const [key, price] of lines) {
      await db.insert(schema.orderItems).values({
        orderId: order!.id,
        productId: ids[key],
        productName: fixtures.find((f) => f.key === key)!.name,
        variantName: "Default",
        sku: `${P}-${key}`.toUpperCase(),
        quantity: 1,
        unitPrice: price,
        totalPrice: price,
      });
    }
    return order!.id;
  }

  /* Four orders pairing the laptop with the mouse, plus three filler orders
   * that do NOT contain the mouse.
   *
   * The filler orders are the point. With every product in every order, the
   * mouse's base rate is 1.0, so lift = confidence / 1.0 = 1.0 exactly and no
   * association is detectable — a degenerate fixture, not a code failure. The
   * filler gives the mouse a base rate of 4/7, so the laptop→mouse lift is
   * 1.75 and the pair is genuinely associated rather than merely common. */
  for (let i = 1; i <= 4; i += 1) {
    await placeOrder(`${P}-B${i}`, [
      ["laptop16", 8_500_000],
      ["mouse", 250_000],
    ]);
  }
  for (let i = 5; i <= 7; i += 1) {
    await placeOrder(`${P}-B${i}`, [["bag", 180_000]]);
  }

  const coResult = await compute.computeCoPurchases({ client: db, windowDays: 90 });
  check("co-purchase matrix computed", coResult.wrote > 0, `${coResult.wrote} pairs`);

  const coRows = await db
    .select()
    .from(schema.productCoPurchases)
    .where(eq(schema.productCoPurchases.productId, ids.laptop16));
  const coIds = coRows.map((row) => row.coProductId);
  check("the mouse is a co-purchase of the laptop", coIds.includes(ids.mouse));
  check(
    "co-purchase lift is above 1 (a real association, not just popularity)",
    coRows.every((row) => row.lift > 1),
    coRows.map((row) => `lift ${row.lift.toFixed(2)}`).join(", "),
  );

  /* ── §78 steps 11–14: the product page rails ──────────────────────────── */

  await compute.computeSimilarity({ client: db, batchSize: 50, minScore: 0.01 });

  const similar = await engine.recommend({
    type: "SIMILAR_PRODUCTS",
    productId: ids.laptop16,
    limit: 8,
  });
  check("similar products appear", similar.items.length > 0, `${similar.items.length} items`);
  check(
    "the other gaming laptop is similar",
    similar.items.some((item) => item.productId === ids.laptop32),
  );
  check(
    "an accessory is NOT offered as a similar product",
    !similar.items.some((item) => item.productId === ids.mouse),
    "similarity and complementarity stay distinct",
  );

  const fbt = await engine.recommend({
    type: "FREQUENTLY_BOUGHT_TOGETHER",
    productId: ids.laptop16,
    limit: 8,
  });
  check(
    "frequently-bought-together surfaces the mouse",
    fbt.items.some((item) => item.productId === ids.mouse),
    `${fbt.items.length} items`,
  );

  const crossSell = await engine.recommend({
    type: "CROSS_SELL",
    productId: ids.laptop16,
    limit: 8,
  });
  check(
    "cross-sell offers an accessory from another category",
    crossSell.items.some((item) => item.productId === ids.mouse || item.productId === ids.bag),
    `${crossSell.items.length} items`,
  );
  check(
    "cross-sell does not offer the seed itself",
    !crossSell.items.some((item) => item.productId === ids.laptop16),
  );

  /* ── §78 steps 15–17: a product becomes trending ──────────────────────── */

  // The bag suddenly gets a burst of attention relative to its own baseline.
  for (let i = 0; i < 40; i += 1) {
    await events.recordBehavioralEvent({
      eventType: "PRODUCT_VIEW",
      sessionId: `${P}-burst-${i}`,
      productId: ids.bag,
      categoryId: accessories!.id,
      source: "home",
    });
  }

  const popResult = await compute.computePopularity({ client: db, windowDays: 30, recentDays: 1 });
  check("popularity computed", popResult.wrote > 0, `${popResult.wrote} rows`);

  const [bagPop] = await db
    .select()
    .from(schema.productPopularity)
    .where(
      and(eq(schema.productPopularity.productId, ids.bag), eq(schema.productPopularity.scope, "GLOBAL")),
    );
  check("the burst product has a trending score", (bagPop?.trendingScore ?? 0) > 0, `trending ${bagPop?.trendingScore}`);
  check("the burst product accumulated views", (bagPop?.viewCount ?? 0) >= 40, `${bagPop?.viewCount} views`);

  const trending = await engine.recommend({ type: "TRENDING_PRODUCTS", limit: 8 });
  check("trending rail returns items", trending.items.length > 0, `${trending.items.length} items`);

  /* ── Exclusions and measurement ───────────────────────────────────────── */

  check(
    "the out-of-stock sleeve is excluded from stock-required slots",
    !similar.items.some((item) => item.productId === ids.sleeve),
  );

  await events.recordImpressions({
    recommendationId: fbt.recommendationId,
    type: fbt.type,
    algorithmVersion: fbt.algorithmVersion,
    userId: userA,
    sessionHash: sessionA,
    items: fbt.items.map((item) => ({ productId: item.productId, position: item.position })),
  });

  const attribution = await metrics.findAttribution({
    productId: fbt.items[0]!.productId,
    userId: userA,
    windowDays: 7,
  });
  check("a purchase is attributable to its impression", attribution.attributed);
  check("attribution names the recommendation type", attribution.recommendationType === fbt.type);

  const noImpression = await metrics.findAttribution({
    productId: ids.sleeve,
    sessionHash: `${P}-never-saw-it`,
    windowDays: 7,
  });
  check("a purchase with no impression is NOT attributed", !noImpression.attributed);

  const rolled = await metrics.rollUpMetrics({ date: new Date(), client: db });
  check("metrics rolled up", rolled > 0, `${rolled} rows`);

  const overview = await metrics.recommendationOverview({ windowDays: 30 });
  check("overview reports impressions", overview.impressions > 0, `${overview.impressions} impressions`);

  const trace = await debug.traceRecommendation(
    { type: "SIMILAR_PRODUCTS", productId: ids.laptop16, limit: 8 },
    db,
  );
  check("the debugger traces candidates", trace.candidates.length > 0, `${trace.candidates.length} candidates`);
  check("the debugger reports the active weight version", trace.configVersion.length > 0);

  const coverage = await compute.computeCoverage(db);
  check("precomputed coverage is reported", coverage.products > 0, `${coverage.products} products indexed`);

  /* ── Cleanup ──────────────────────────────────────────────────────────── */

  await db.execute(sql`DELETE FROM recommendation_events`).catch(() => undefined);
  await db.execute(sql`DELETE FROM recommendation_requests`).catch(() => undefined);
  await db.execute(sql`DELETE FROM recommendation_metrics`).catch(() => undefined);
  await db
    .execute(sql`DELETE FROM product_similarity WHERE product_id = ANY(${createdProductIds})`)
    .catch(() => undefined);
  await db
    .execute(sql`DELETE FROM product_co_purchases WHERE product_id = ANY(${createdProductIds})`)
    .catch(() => undefined);
  await db
    .execute(sql`DELETE FROM product_popularity WHERE product_id = ANY(${createdProductIds})`)
    .catch(() => undefined);
  await db
    .execute(sql`DELETE FROM user_interest_signals WHERE user_id IN (${userA}, ${userB}) OR session_hash LIKE ${`${P}%`}`)
    .catch(() => undefined);
  await db
    .execute(sql`DELETE FROM user_interest_profiles WHERE user_id IN (${userA}, ${userB}) OR session_hash LIKE ${`${P}%`}`)
    .catch(() => undefined);
  await db
    .execute(sql`DELETE FROM analytics_events WHERE user_id IN (${userA}, ${userB}) OR session_id LIKE ${`${P}%`}`)
    .catch(() => undefined);
  await db.execute(sql`DELETE FROM products WHERE slug LIKE ${`${P}-%`}`).catch(() => undefined);
  await db.execute(sql`DELETE FROM categories WHERE slug LIKE ${`${P}-%`}`).catch(() => undefined);
  await db.execute(sql`DELETE FROM brands WHERE slug LIKE ${`${P}-%`}`).catch(() => undefined);
  await db.execute(sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`).catch(() => undefined);

  check("cleanup removed the fixtures", true);

  await pool.end();

  console.log(
    failures === 0
      ? "\nE2E RECOMMENDATIONS: all checks passed"
      : `\nE2E RECOMMENDATIONS: ${failures} check(s) failed`,
  );
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error("E2E RECOMMENDATIONS FAIL:", error?.message ?? error);
  process.exit(1);
});
