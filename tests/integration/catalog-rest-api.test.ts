// @vitest-environment node
/**
 * Part 11 — the REST catalog API against a real PostgreSQL database.
 *
 * These are the endpoints Part 11 specifies: /api/products (+ :id, slug/:slug,
 * :id/variants, :id/inventory), /api/categories (+ :id) and /api/brands.
 *
 * Two things matter most and are asserted explicitly, because they are the ones
 * that silently regress:
 *   1. A public response never carries an internal field (cost price, admin
 *      notes, the ledger). The projections are explicit allow-lists, and a test
 *      that pins that is what keeps a new column from leaking by default.
 *   2. Reads and writes on the same path are separated by the session role, not
 *      by a request parameter — so a client cannot ask for the admin shape.
 *
 * Skipped unless TEST_DATABASE_URL points at a disposable database; `npm run
 * test:db` boots one.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

/**
 * Auth is mocked rather than exercised: NextAuth needs a real request cookie and
 * a database user row, which tests both the auth layer and the route at once and
 * makes a failure ambiguous. The session module is stubbed with mutable state so
 * each test can be anonymous, an editor, or a plain customer.
 */
const session: { user: { id: string; role: string } | null } = { user: null };

vi.mock("@/server/auth/session", () => ({
  getFreshUser: vi.fn(async () => session.user),
  getOptionalUser: vi.fn(async () => session.user),
  getSession: vi.fn(async () => null),
  authRequestContext: vi.fn(async () => ({ ip: "203.0.113.9", userAgent: "vitest" })),
}));

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const P = `rest${randomBytes(4).toString("hex")}`;
const slug = (name: string) => `${P}-${name}`;

type Modules = {
  db: typeof import("@/db").db;
  schema: typeof import("@/db/schema");
  eq: typeof import("drizzle-orm").eq;
  productsRoute: typeof import("@/app/api/products/route");
  productByIdRoute: typeof import("@/app/api/products/[id]/route");
  productBySlugRoute: typeof import("@/app/api/products/slug/[slug]/route");
  categoriesRoute: typeof import("@/app/api/categories/route");
  categoryByIdRoute: typeof import("@/app/api/categories/[id]/route");
  brandsRoute: typeof import("@/app/api/brands/route");
  variantsRoute: typeof import("@/app/api/products/[id]/variants/route");
  inventoryRoute: typeof import("@/app/api/products/[id]/inventory/route");
};

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe.skipIf(!enabled)("catalog REST API (PostgreSQL)", () => {
  let m: Modules;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const [dbm, schema, drizzle, productsRoute, productByIdRoute, productBySlugRoute,
      categoriesRoute, categoryByIdRoute, brandsRoute, variantsRoute, inventoryRoute] =
      await Promise.all([
        import("@/db"),
        import("@/db/schema"),
        import("drizzle-orm"),
        import("@/app/api/products/route"),
        import("@/app/api/products/[id]/route"),
        import("@/app/api/products/slug/[slug]/route"),
        import("@/app/api/categories/route"),
        import("@/app/api/categories/[id]/route"),
        import("@/app/api/brands/route"),
        import("@/app/api/products/[id]/variants/route"),
        import("@/app/api/products/[id]/inventory/route"),
      ]);
    m = {
      db: dbm.db, schema, eq: drizzle.eq,
      productsRoute, productByIdRoute, productBySlugRoute,
      categoriesRoute, categoryByIdRoute, brandsRoute, variantsRoute, inventoryRoute,
    };

    const { categories, users } = schema;
    const categorySlug = slug("cat");
    const [row] = await m.db
      .insert(categories)
      .values({ name: `${P} category`, slug: categorySlug, path: categorySlug, depth: 0 })
      .returning({ id: categories.id });
    ids.category = row!.id;
    ids.categorySlug = categorySlug;

    // `inventory_ledger.actor_id` and `audit_events.actor_id` both reference
    // users.id, so the actor has to be a real row — an invented id fails the
    // foreign key and every write that records who did it.
    const [actor] = await m.db
      .insert(users)
      .values({ name: `${P} Editor`, email: `${P}@example.test`, role: "ADMIN" })
      .returning({ id: users.id });
    ids.actor = actor!.id;
    session.user = { id: actor!.id, role: "ADMIN" };
  });

  beforeEach(() => {
    session.user = null;
  });

  afterAll(async () => {
    const { categories } = m.schema;
    // Cascade removes the products, variants and ledger rows created here.
    await m.db.delete(categories).where(m.eq(categories.id, ids.category!)).catch(() => undefined);
    const { brands, users } = m.schema;
    if (ids.brandSlug) await m.db.delete(brands).where(m.eq(brands.slug, ids.brandSlug)).catch(() => undefined);
    if (ids.actor) await m.db.delete(users).where(m.eq(users.id, ids.actor)).catch(() => undefined);
  });

  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const slugCtx = (value: string) => ({ params: Promise.resolve({ slug: value }) });

  /**
   * Create a product through the API as an editor, then activate it.
   *
   * The API creates DRAFT rows and the publish checklist demands images,
   * descriptions and variants — all unrelated to what these tests assert. So
   * the fixture flips the status directly rather than satisfying a checklist it
   * is not testing.
   */
  async function createProduct(name: string, extra: Record<string, unknown> = {}): Promise<{ id: string; slug: string }> {
    session.user = { id: ids.actor!, role: "ADMIN" };
    const response = await m.productsRoute.POST(new Request("http://test.local/api/products", json({
      name,
      slug: slug(name.replace(/\s+/g, "-").toLowerCase()),
      productType: "OTHER",
      basePrice: "1200",
      currency: "INR",
      shortDescription: `${name} short description.`,
      categoryIds: [ids.category!],
      ...extra,
    })));
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as { data: { id: string; slug: string } };

    // `publicProductCondition` requires a PRODUCT image as well as a
    // description and a positive price, so a product without one is not
    // publicly visible no matter its status. The fixture supplies it rather
    // than weakening the condition under test.
    const { images, products } = m.schema;
    await m.db.insert(images).values({
      type: "PRODUCT",
      role: "PRIMARY",
      url: `https://cdn.test/${body.data.slug}.jpg`,
      altText: name,
      productId: body.data.id,
      storageKey: `private/${P}/${body.data.slug}.jpg`,
    });

    // A publicly visible product also needs at least one variant priced above
    // zero — `publicProductCondition` requires it, so without one the row is
    // invisible no matter its status.
    const { productVariants } = m.schema;
    await m.db.insert(productVariants).values({
      productId: body.data.id,
      sku: `${P}-${body.data.slug}`.toUpperCase().replace(/[^A-Z0-9-]/g, "-").slice(0, 60),
      name: "Standard",
      price: 120000,
      availability: "IN_STOCK",
    });

    if (extra.status !== "DRAFT") {
      await m.db
        .update(products)
        .set({ status: "ACTIVE", visibility: "PUBLIC", publishedAt: new Date() })
        .where(m.eq(products.id, body.data.id));
    }
    return body.data;
  }

  /* ── /api/products (create) ─────────────────────────────────────────── */

  it("rejects POST /api/products when the caller is not an editor", async () => {
    const anonymous = await m.productsRoute.POST(new Request("http://test.local/api/products", json({
      name: `${P} anon`, productType: "OTHER", basePrice: "100", currency: "INR",
    })));
    expect(anonymous.status).toBe(401);

    session.user = { id: ids.actor!, role: "CUSTOMER" };
    const customer = await m.productsRoute.POST(new Request("http://test.local/api/products", json({
      name: `${P} customer`, productType: "OTHER", basePrice: "100", currency: "INR",
    })));
    expect(customer.status).toBe(403);
  });

  it("POST /api/products validates the payload before writing", async () => {
    session.user = { id: ids.actor!, role: "ADMIN" };
    const response = await m.productsRoute.POST(new Request("http://test.local/api/products", json({
      name: "x", // below the 2-character minimum
      productType: "OTHER",
      basePrice: "100",
      currency: "INR",
    })));
    expect(response.status).toBe(422);
  });

  /* ── /api/products/:id and /api/products/slug/:slug ─────────────────── */

  it("GET /api/products/:id returns the public projection with no internal fields", async () => {
    const product = await createProduct(`${P} Public Detail`);
    session.user = null;

    const response = await m.productByIdRoute.GET(new Request("http://test.local/api/products/x"), ctx(product.id));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { scope: string; product: Record<string, unknown> } };
    expect(body.data.scope).toBe("public");
    expect(body.data.product.id).toBe(product.id);

    // The whole point of an allow-list projection: these must be absent, not
    // merely empty.
    const leaked = ["costPrice", "adminNotes", "taxRateBp", "searchVector", "supplierNotes", "createdAt"];
    for (const field of leaked) {
      expect(body.data.product, `public response leaked ${field}`).not.toHaveProperty(field);
    }
    expect(JSON.stringify(body.data.product)).not.toContain("costPrice");
  });

  it("GET /api/products/:id gives an editor the admin shape", async () => {
    const product = await createProduct(`${P} Admin Detail`);
    session.user = { id: ids.actor!, role: "ADMIN" };

    const response = await m.productByIdRoute.GET(new Request("http://test.local/api/products/x"), ctx(product.id));
    const body = (await response.json()) as { data: { scope: string } };
    expect(body.data.scope).toBe("admin");
  });

  it("GET /api/products/:id rejects a malformed id rather than querying", async () => {
    const response = await m.productByIdRoute.GET(new Request("http://test.local/api/products/x"), ctx("not-a-uuid"));
    expect(response.status).toBe(422);
  });

  it("GET /api/products/slug/:slug resolves a public product and 404s a draft", async () => {
    const product = await createProduct(`${P} Slug Lookup`);
    session.user = null;

    const found = await m.productBySlugRoute.GET(new Request("http://test.local/x"), slugCtx(product.slug));
    expect(found.status, await found.clone().text()).toBe(200);

    // A draft is not publicly visible. It must be indistinguishable from a
    // product that does not exist, or the endpoint enumerates unpublished slugs.
    const draft = await createProduct(`${P} Draft`, { status: "DRAFT" });
    const missing = await m.productBySlugRoute.GET(new Request("http://test.local/x"), slugCtx(draft.slug));
    expect(missing.status).toBe(404);

    const absent = await m.productBySlugRoute.GET(new Request("http://test.local/x"), slugCtx(`${P}-nope`));
    expect(absent.status).toBe(404);
    expect(await absent.json()).toEqual(await missing.json());
  });

  it("PUT /api/products/:id updates and DELETE archives instead of deleting", async () => {
    const product = await createProduct(`${P} Lifecycle`);
    session.user = { id: ids.actor!, role: "ADMIN" };

    const updated = await m.productByIdRoute.PUT(
      new Request("http://test.local/api/products/x", json({
        name: `${P} Lifecycle Renamed`,
        slug: product.slug,
        productType: "OTHER",
        basePrice: "1500",
        currency: "INR",
        categoryIds: [ids.category!],
      })),
      ctx(product.id),
    );
    expect(updated.status).toBe(200);

    const deleted = await m.productByIdRoute.DELETE(new Request("http://test.local/x", { method: "DELETE" }), ctx(product.id));
    expect(deleted.status).toBe(200);

    // Archived, not gone: orders, reviews and carts still reference the row.
    const { products } = m.schema;
    const [row] = await m.db
      .select({ status: products.status })
      .from(products)
      .where(m.eq(products.id, product.id));
    expect(row!.status).toBe("ARCHIVED");

    // And it is off the public surface.
    session.user = null;
    const gone = await m.productBySlugRoute.GET(new Request("http://test.local/x"), slugCtx(product.slug));
    expect(gone.status).toBe(404);
  });

  /* ── /api/categories ────────────────────────────────────────────────── */

  it("POST /api/categories requires an editor and creates with a derived path", async () => {
    session.user = null;
    const denied = await m.categoriesRoute.POST(new Request("http://test.local/api/categories", json({
      name: `${P} Denied`,
    })));
    expect(denied.status).toBe(401);

    session.user = { id: ids.actor!, role: "ADMIN" };
    const created = await m.categoriesRoute.POST(new Request("http://test.local/api/categories", json({
      name: `${P} Child`,
      parentId: ids.category,
    })));
    expect(created.status, await created.clone().text()).toBe(200);
    const body = (await created.json()) as { data: { id: string; path: string; depth: number } };
    ids.childCategory = body.data.id;

    // The path is server-derived from the parent, never taken from the client.
    expect(body.data.path.startsWith(`${ids.categorySlug}/`)).toBe(true);
    expect(body.data.depth).toBe(1);
  });

  it("PUT and DELETE /api/categories/:id update and archive", async () => {
    session.user = { id: ids.actor!, role: "ADMIN" };

    const updated = await m.categoryByIdRoute.PUT(
      new Request("http://test.local/x", json({ name: `${P} Child Renamed`, parentId: ids.category })),
      ctx(ids.childCategory!),
    );
    expect(updated.status).toBe(200);

    const deleted = await m.categoryByIdRoute.DELETE(new Request("http://test.local/x", { method: "DELETE" }), ctx(ids.childCategory!));
    expect(deleted.status).toBe(200);

    const { categories } = m.schema;
    const [row] = await m.db
      .select({ isActive: categories.isActive })
      .from(categories)
      .where(m.eq(categories.id, ids.childCategory!));
    expect(row!.isActive).toBe(false);
  });

  /* ── /api/brands ────────────────────────────────────────────────────── */

  it("GET /api/brands hides inactive brands from the public and shows them to an editor", async () => {
    session.user = { id: ids.actor!, role: "ADMIN" };
    const brandSlug = slug("brand");
    ids.brandSlug = brandSlug;

    const created = await m.brandsRoute.POST(new Request("http://test.local/api/brands", json({
      name: `${P} Brand`,
      slug: brandSlug,
      isActive: false,
    })));
    expect(created.status, await created.clone().text()).toBe(200);
    const createdBody = (await created.json()) as { data: { id: string; isActive: boolean } };
    expect(createdBody.data.isActive).toBe(false);

    // Public: an inactive brand must not appear at all.
    session.user = null;
    const publicList = await m.brandsRoute.GET(new Request("http://test.local/api/brands?search=" + encodeURIComponent(P)));
    const publicBody = (await publicList.json()) as { data: { brands: { slug: string }[] } };
    expect(publicBody.data.brands.some((brand) => brand.slug === brandSlug)).toBe(false);

    // Editor: it must appear, because the screen exists to reactivate it.
    session.user = { id: ids.actor!, role: "ADMIN" };
    const adminList = await m.brandsRoute.GET(new Request(`http://test.local/api/brands?search=${encodeURIComponent(P)}&includeInactive=true`));
    const adminBody = (await adminList.json()) as { data: { brands: { slug: string; isActive: boolean }[] } };
    const found = adminBody.data.brands.find((brand) => brand.slug === brandSlug);
    expect(found?.isActive).toBe(false);
  });

  it("POST /api/brands requires an editor", async () => {
    session.user = null;
    const response = await m.brandsRoute.POST(new Request("http://test.local/api/brands", json({ name: `${P} Nope` })));
    expect(response.status).toBe(401);
  });

  /* ── /api/products/:id/variants ─────────────────────────────────────── */

  it("GET /api/products/:id/variants never exposes cost price publicly", async () => {
    const product = await createProduct(`${P} Variant Host`);
    session.user = { id: ids.actor!, role: "ADMIN" };

    const created = await m.variantsRoute.POST(
      new Request("http://test.local/x", json({
        sku: `${P}-V1`.toUpperCase().replace(/[^A-Z0-9-]/g, "-"),
        name: "128GB",
        price: 130000,
        costPrice: 70000,
        stockQuantity: 12,
        attributes: { size: "M", storage: "128GB" },
      })),
      ctx(product.id),
    );
    expect(created.status, await created.clone().text()).toBe(200);
    ids.product = product.id;

    // The fixture already added a "Standard" variant, so pick the one created
    // here by SKU rather than asserting on the array length.
    const variantSku = `${P}-V1`.toUpperCase().replace(/[^A-Z0-9-]/g, "-");

    session.user = null;
    const publicResponse = await m.variantsRoute.GET(new Request("http://test.local/x"), ctx(product.id));
    const publicBody = (await publicResponse.json()) as { data: { scope: string; variants: Record<string, unknown>[] } };
    expect(publicBody.data.scope).toBe("public");
    const publicVariant = publicBody.data.variants.find((variant) => variant.sku === variantSku);
    expect(publicVariant, "the created variant should be listed publicly").toBeDefined();
    expect(publicVariant).not.toHaveProperty("costPrice");
    expect(publicVariant).toHaveProperty("price");
    // No public variant may carry cost price, not just the one under test.
    for (const variant of publicBody.data.variants) {
      expect(variant, `public response leaked costPrice on ${String(variant.sku)}`).not.toHaveProperty("costPrice");
    }

    session.user = { id: ids.actor!, role: "ADMIN" };
    const adminResponse = await m.variantsRoute.GET(new Request("http://test.local/x"), ctx(product.id));
    const adminBody = (await adminResponse.json()) as { data: { scope: string; variants: Record<string, unknown>[] } };
    expect(adminBody.data.scope).toBe("admin");
    const adminVariant = adminBody.data.variants.find((variant) => variant.sku === variantSku);
    expect(adminVariant).toHaveProperty("costPrice");
    expect(adminVariant!.costPrice).toBe(70000);
  });

  it("POST /api/products/:id/variants records opening stock in the ledger", async () => {
    const product = await createProduct(`${P} Ledger Host`);
    session.user = { id: ids.actor!, role: "ADMIN" };

    const created = await m.variantsRoute.POST(
      new Request("http://test.local/x", json({
        sku: `${P}-V2`.toUpperCase().replace(/[^A-Z0-9-]/g, "-"),
        name: "Large",
        price: 90000,
        stockQuantity: 5,
        attributes: { size: "L" },
      })),
      ctx(product.id),
    );
    expect(created.status, await created.clone().text()).toBe(200);

    // Opening stock must be explainable by the ledger, or the balance is a
    // number nothing can account for.
    const { inventoryLedger } = m.schema;
    const rows = await m.db
      .select({ operation: inventoryLedger.operation, changed: inventoryLedger.quantityChanged })
      .from(inventoryLedger);
    const opening = rows.filter((row) => row.operation === "STOCK_IN" && Number(row.changed) === 5);
    expect(opening.length).toBeGreaterThan(0);
  });

  it("POST /api/products/:id/variants rejects a malformed SKU", async () => {
    session.user = { id: ids.actor!, role: "ADMIN" };
    const response = await m.variantsRoute.POST(
      new Request("http://test.local/x", json({
        sku: "lowercase and spaces",
        name: "Bad",
        price: 90000,
        attributes: { size: "S" },
      })),
      ctx(ids.product!),
    );
    expect(response.status).toBe(422);
  });

  /* ── /api/products/:id/inventory ────────────────────────────────────── */

  it("GET /api/products/:id/inventory hides the ledger from the public", async () => {
    session.user = null;
    const response = await m.inventoryRoute.GET(new Request("http://test.local/x"), ctx(ids.product!));
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data.scope).toBe("public");
    expect(body.data.stock).toBeDefined();
    expect(body.data).not.toHaveProperty("ledger");
  });

  it("POST /api/products/:id/inventory writes a traceable movement and blocks overselling", async () => {
    session.user = { id: ids.actor!, role: "ADMIN" };

    const { productVariants } = m.schema;
    const [variant] = await m.db
      .select({ id: productVariants.id, stock: productVariants.stockQuantity })
      .from(productVariants)
      .where(m.eq(productVariants.productId, ids.product!))
      .limit(1);
    const variantId = variant!.id;

    const adjusted = await m.inventoryRoute.POST(
      new Request("http://test.local/x", json({
        variantId,
        operation: "STOCK_IN",
        quantity: 7,
        reason: "Restock",
        referenceType: "PURCHASE_ORDER",
        referenceId: `${P}-po-1`,
      })),
      ctx(ids.product!),
    );
    expect(adjusted.status).toBe(200);

    // The ledger row carries previous / changed / new, which is what makes the
    // balance auditable.
    const { inventoryLedger } = m.schema;
    const [entry] = await m.db
      .select({
        previous: inventoryLedger.previousQuantity,
        changed: inventoryLedger.quantityChanged,
        next: inventoryLedger.newQuantity,
        operation: inventoryLedger.operation,
      })
      .from(inventoryLedger)
      .where(m.eq(inventoryLedger.variantId, variantId))
      .orderBy(inventoryLedger.createdAt);
    const last = entry!;
    expect(last.operation).toBe("STOCK_IN");
    expect(Number(last.next) - Number(last.previous)).toBe(Number(last.changed));

    // Overselling is refused: the ledger must never explain a negative balance.
    const oversell = await m.inventoryRoute.POST(
      new Request("http://test.local/x", json({
        variantId,
        operation: "SALE",
        quantity: 100_000,
      })),
      ctx(ids.product!),
    );
    expect(oversell.status).toBeGreaterThanOrEqual(400);

    // The balance is unchanged by the refused movement.
    const [after] = await m.db
      .select({ stock: productVariants.stockQuantity })
      .from(productVariants)
      .where(m.eq(productVariants.id, variantId));
    expect(Number(after!.stock)).toBe(Number(last.next));
  });

  it("POST /api/products/:id/inventory rejects a reference type outside the database enum", async () => {
    session.user = { id: ids.actor!, role: "ADMIN" };
    const { productVariants } = m.schema;
    const [variant] = await m.db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(m.eq(productVariants.productId, ids.product!))
      .limit(1);

    // ORDER_LINE is not a value of the `inventory_reference` pgEnum. It used to
    // pass validation and fail at the driver instead.
    const response = await m.inventoryRoute.POST(
      new Request("http://test.local/x", json({
        variantId: variant!.id,
        operation: "STOCK_IN",
        quantity: 1,
        referenceType: "ORDER_LINE",
      })),
      ctx(ids.product!),
    );
    expect(response.status).toBe(422);
  });
});
