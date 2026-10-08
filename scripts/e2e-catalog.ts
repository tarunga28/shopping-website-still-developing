import "dotenv/config";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * Part 11 — end-to-end catalog lifecycle.
 *
 * Walks the path the spec calls for: an admin creates a product, publishes it,
 * a customer finds and views it, picks a variant, search surfaces it, and stock
 * movements are reflected everywhere they are read.
 *
 * Unlike the integration tests, this exercises the real service entry points in
 * sequence against one database, so it catches wiring problems that unit-level
 * tests cannot see — a variant created without a ledger row, a product that
 * publishes but never appears in search, stock that moves without the listing
 * noticing.
 *
 * Run against a disposable database:
 *   node scripts/test-db.mjs -- npx tsx scripts/e2e-catalog.ts
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
const Module = require_("node:module") as { _resolveFilename: (...args: unknown[]) => string };
const serverOnlyStub = fileURLToPath(new URL("../tests/mocks/server-only.ts", import.meta.url));
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function patched(request: unknown, ...rest: unknown[]): string {
  if (request === "server-only") return serverOnlyStub;
  return (originalResolve as (r: unknown, ...a: unknown[]) => string).call(this, request, ...rest);
};

async function main() {
  const { db, pool } = await import("@/db");
  const { categories, images, productVariants, inventoryLedger, products, users } = await import("@/db/schema");
  const { eq, and, sql } = await import("drizzle-orm");

  const admin = await import("@/services/catalog-admin.service");
  const { productWriteSchema } = await import("@/validations/catalog");
  const variantSvc = await import("@/services/catalog/variant.service");
  const inventorySvc = await import("@/services/catalog/inventory.service");
  const searchSvc = await import("@/services/catalog/search.service");
  const publicSvc = await import("@/services/catalog/public-catalog.service");

  const stamp = Date.now().toString(36);

  // The actor is a real user row: it is written to audit_events.actor_id and
  // inventory_ledger.actor_id, both of which reference users.id, so an invented
  // id would fail the foreign key.
  const [actorRow] = await db
    .insert(users)
    .values({ name: "E2E Catalog Admin", email: `e2e-catalog-${stamp}@inkline.test`, role: "ADMIN" })
    .returning({ id: users.id });
  const actor = { id: actorRow!.id, role: "ADMIN", ip: "198.51.100.7", userAgent: "e2e-catalog" };

  /* ─── 1. Admin creates the taxonomy and the product ─── */

  const category = await admin.createCategory(actor, {
    name: `E2E Category ${stamp}`,
    slug: `e2e-cat-${stamp}`,
    description: "Created by the catalog e2e script.",
    displayOrder: 0,
  });
  check("admin creates a category", Boolean(category.id), `path=${category.path}`);

  const created = await admin.createProduct(
    actor,
    productWriteSchema.parse({
      name: `E2E Aurora Hoodie ${stamp}`,
      slug: `e2e-aurora-hoodie-${stamp}`,
      shortDescription: "A heavyweight hoodie used to verify the catalog lifecycle end to end.",
      description: "Brushed fleece, double-lined hood, and a boxy cut. Used by the e2e script.",
      productType: "HOODIE",
      basePrice: "2499",
      currency: "INR",
      categoryIds: [category.id],
      tags: ["e2e", "hoodie"],
      supplierMappingRequired: false,
    }),
  );
  check("admin creates a product", Boolean(created.id), `slug=${created.slug}`);

  // Publishing is gated: it needs a description, a category, an image and at
  // least one variant. The gates are the point, so satisfy them rather than
  // bypass them.
  await db.insert(images).values({
    type: "PRODUCT",
    role: "PRIMARY",
    url: `https://cdn.inkline.test/products/e2e-${stamp}.jpg`,
    altText: "Aurora hoodie",
    productId: created.id,
    storageKey: `private/e2e/${stamp}.jpg`,
  });

  /* ─── 2. Variants ─── */

  const small = await variantSvc.createVariant(actor, created.id, {
    sku: `E2E-${stamp}-S`.toUpperCase(),
    name: "Small",
    price: "2499",
    stockQuantity: 10,
    assignments: [{ code: "size", valueKey: "s", valueLabel: "S" }],
  });
  const large = await variantSvc.createVariant(actor, created.id, {
    sku: `E2E-${stamp}-L`.toUpperCase(),
    name: "Large",
    price: "2699",
    stockQuantity: 4,
    assignments: [{ code: "size", valueKey: "l", valueLabel: "L" }],
  });
  check("admin creates two variants", Boolean(small.id && large.id), `${small.sku}, ${large.sku}`);

  // Opening stock must be explainable by the ledger, not just present as a number.
  const openingRows = await db
    .select({ id: inventoryLedger.id })
    .from(inventoryLedger)
    .where(
      and(
        eq(inventoryLedger.productId, created.id),
        eq(inventoryLedger.operation, "STOCK_IN"),
      ),
    );
  check("opening stock wrote ledger rows", openingRows.length === 2, `${openingRows.length} STOCK_IN rows`);

  /* ─── 3. Publish ─── */

  const blockers = await admin.publishChecklist(created.id);
  check("publish checklist is satisfied", blockers.length === 0, blockers.join("; ") || "no blockers");
  await admin.publishProduct(actor, created.id);

  const [published] = await db
    .select({ status: products.status, publishedAt: products.publishedAt })
    .from(products)
    .where(eq(products.id, created.id));
  check("product is published", published?.status === "ACTIVE" && published.publishedAt !== null);

  /* ─── 4. Customer browses and views ─── */

  const listing = await publicSvc.getCatalogProducts({
    category: `e2e-cat-${stamp}`,
    page: 1,
    pageSize: 20,
  });
  check(
    "customer finds it in the category listing",
    listing.products.some((p) => p.slug === created.slug),
    `${listing.products.length} products in category`,
  );

  const byId = await publicSvc.getProductByIdPublic(created.id);
  check("customer can view the product by id", byId?.slug === created.slug);

  const bySlug = await publicSvc.getProductBySlugPublic(created.slug);
  check("customer can view the product by slug", bySlug?.id === created.id);

  // The public projection must not carry internal fields.
  const leaked = byId ? Object.keys(byId).filter((k) => ["costPrice", "adminNotes", "searchVector"].includes(k)) : [];
  check("public view leaks no internal fields", leaked.length === 0, leaked.join(", ") || "none present");

  /* ─── 5. Customer picks a variant ─── */

  const variants = await variantSvc.listVariants(created.id);
  const chosen = variants.find((v) => v.sku === large.sku);
  check(
    "customer can pick a variant with its own price",
    chosen?.price === 269900 && variants.length === 2,
    `large=${chosen?.price} paise, ${variants.length} variants`,
  );

  /* ─── 6. Search finds it ─── */

  await searchSvc.indexProduct(created.id);
  const found = await searchSvc.searchProducts(`aurora hoodie ${stamp}`);
  check(
    "search surfaces the published product",
    found.hits.some((hit) => hit.slug === created.slug),
    `${found.hits.length} hits`,
  );

  // A draft must not be searchable, or the index would leak unpublished catalog.
  const draft = await admin.createProduct(
    actor,
    productWriteSchema.parse({
      name: `E2E Unpublished ${stamp}`,
      slug: `e2e-unpublished-${stamp}`,
      shortDescription: "This one is never published.",
      productType: "OTHER",
      basePrice: "999",
      currency: "INR",
      categoryIds: [category.id],
      tags: ["e2e"],
      supplierMappingRequired: false,
    }),
  );
  await searchSvc.indexProduct(draft.id);
  const draftSearch = await searchSvc.searchProducts(`unpublished ${stamp}`);
  check(
    "search does not surface an unpublished product",
    !draftSearch.hits.some((hit) => hit.slug === draft.slug),
    `${draftSearch.hits.length} hits`,
  );

  /* ─── 7. Stock movements are reflected everywhere ─── */

  const before = await inventorySvc.getProductStock(created.id);
  const largeBefore = before.find((row) => row.variantId === large.id);

  const sale = await inventorySvc.adjustInventory({ id: actor.id }, {
    productId: created.id,
    variantId: large.id,
    operation: "SALE",
    quantity: 2,
    referenceType: "ORDER",
    referenceId: `e2e-order-${stamp}`,
    reason: "E2E order",
  });
  check(
    "a sale reduces available stock",
    sale.newQuantity === Number(largeBefore?.stockQuantity ?? 0) - 2,
    `${largeBefore?.stockQuantity} -> ${sale.newQuantity}`,
  );

  // Replaying the same reference must be a no-op, or a retried webhook would
  // deduct stock twice.
  const replay = await inventorySvc.adjustInventory({ id: actor.id }, {
    productId: created.id,
    variantId: large.id,
    operation: "SALE",
    quantity: 2,
    referenceType: "ORDER",
    referenceId: `e2e-order-${stamp}`,
    reason: "E2E order (retried)",
  });
  check("a replayed reference does not move stock twice", replay.idempotentReplay === true && replay.quantityChanged === 0);

  // Overselling must be refused.
  let oversellRejected = false;
  try {
    await inventorySvc.adjustInventory({ id: actor.id }, {
      productId: created.id,
      variantId: large.id,
      operation: "SALE",
      quantity: 10_000,
      reason: "E2E oversell attempt",
    });
  } catch {
    oversellRejected = true;
  }
  check("overselling is refused", oversellRejected);

  const after = await inventorySvc.getProductStock(created.id);
  const largeAfter = after.find((row) => row.variantId === large.id);
  check(
    "the balance matches the ledger after a refused movement",
    largeAfter?.stockQuantity === sale.newQuantity,
    `stock=${largeAfter?.stockQuantity}`,
  );

  // The product rollup is derived, never trusted.
  const [rollup] = await db
    .select({ total: products.stockQuantity })
    .from(products)
    .where(eq(products.id, created.id));
  const sumVariants = after.reduce((sum, row) => sum + row.stockQuantity, 0);
  check("the product stock rollup equals the sum of its variants", rollup?.total === sumVariants, `rollup=${rollup?.total}`);

  /* ─── 8. Integrity: every balance is explainable by replaying the ledger ─── */

  const integrity = await inventorySvc.verifyInventoryIntegrity(variants.map((v) => v.id));
  check(
    "every balance replays from the ledger",
    integrity.mismatches.length === 0 && integrity.checked === 2,
    integrity.mismatches.length
      ? integrity.mismatches.map((m) => `${m.variantId}: stored=${m.stored} derived=${m.derived}`).join("; ")
      : `${integrity.checked} variants verified`,
  );

  /* ─── 9. Archiving removes it from the storefront but keeps the row ─── */

  await admin.archiveProduct(actor, created.id);
  const gonePublic = await publicSvc.getProductBySlugPublic(created.slug);
  const [stillThere] = await db
    .select({ status: products.status })
    .from(products)
    .where(eq(products.id, created.id));
  check(
    "archiving hides the product but keeps the row",
    gonePublic === null && stillThere?.status === "ARCHIVED",
    `status=${stillThere?.status}`,
  );

  /* ─── 10. Clean up ─── */

  // `products.category_id` is ON DELETE SET NULL, so removing the category
  // leaves the products behind rather than taking them with it. That is the
  // intended behaviour — deleting a category must never silently delete stock —
  // so the script removes the products explicitly.
  await db.delete(products).where(eq(products.id, created.id));
  await db.delete(products).where(eq(products.id, draft.id));
  await db.delete(categories).where(eq(categories.id, category.id));
  await db.delete(users).where(eq(users.id, actor.id));

  const remaining = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(products)
    .where(sql`${products.slug} in (${created.slug}, ${draft.slug})`);
  check("cleanup removed the fixture", Number(remaining[0]?.n ?? 0) === 0);

  await pool.end();

  console.log(failures === 0 ? "\nE2E CATALOG: all checks passed" : `\nE2E CATALOG: ${failures} check(s) failed`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error("E2E FAIL:", error?.message ?? error);
  process.exit(1);
});
