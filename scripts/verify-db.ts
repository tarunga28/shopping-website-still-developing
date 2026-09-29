/**
 * Database verification — asserts the schema's integrity contract:
 * relationships resolve, unique/check constraints bite, cascades work,
 * POD event idempotency holds, and transactions roll back cleanly.
 * Probe writes live inside rolled-back transactions, so the script
 * never mutates persisted data. Safe to run anytime.
 */
import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "@/db";
import {
  cartItems,
  carts,
  categories,
  designs,
  podEvents,
  podOrders,
  podProviders,
  podVariantMappings,
  productCategories,
  productDesigns,
  products,
  productVariants,
  users,
  orders,
} from "@/db/schema";

let failures = 0;
const pass = (name: string) => console.log(`  ✓ ${name}`);
const fail = (name: string, detail: string) => {
  failures += 1;
  console.error(`  ✗ ${name} — ${detail}`);
};

/** Flatten DrizzleQueryError → pg error chain into searchable text. */
function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" || ");
}

const isRollbackToken = (error: unknown) => errorText(error).trim() === "Rollback";

async function main() {
  console.log("Verifying Inkline database integrity…");

  /* ── 1. Seed sanity counts ──────────────────────────────────────── */
  const [productCount] = await db.select({ n: sql<number>`count(*)` }).from(products);
  const [variantCount] = await db.select({ n: sql<number>`count(*)` }).from(productVariants);
  const [podMapCount] = await db.select({ n: sql<number>`count(*)` }).from(podVariantMappings);
  Number(productCount.n) >= 8 && Number(variantCount.n) >= 40 && Number(podMapCount.n) >= 40
    ? pass(`seed data present (${productCount.n} products, ${variantCount.n} variants, ${podMapCount.n} mappings)`)
    : fail("seed data present", `got ${productCount.n}/${variantCount.n}/${podMapCount.n}`);

  /* ── 2. Product relationship graph resolves ─────────────────────── */
  const [grid] = await db.select().from(products).where(eq(products.slug, "offbeat-grid-tee")).limit(1);
  if (!grid) {
    fail("product graph", "offbeat-grid-tee missing");
  } else {
    const [variants, cats, placement, podMap] = await Promise.all([
      db.select().from(productVariants).where(eq(productVariants.productId, grid.id)),
      db.select().from(productCategories).where(eq(productCategories.productId, grid.id)),
      db.select().from(productDesigns).where(eq(productDesigns.productId, grid.id)),
      db
        .select()
        .from(podVariantMappings)
        .innerJoin(productVariants, eq(productVariants.id, podVariantMappings.variantId))
        .where(eq(productVariants.productId, grid.id)),
    ]);
    variants.length === 10 ? pass("product → 10 variants (2 colors × 5 sizes)") : fail("variants", `got ${variants.length}`);
    cats.length >= 1 ? pass("product → category association") : fail("category assoc", "none");
    placement.length === 1 && placement[0].placement === "FRONT"
      ? pass("product → FRONT design placement")
      : fail("design placement", `got ${placement.length}`);
    podMap.length === 10 ? pass("product → 10 POD variant mappings") : fail("pod mappings", `got ${podMap.length}`);
  }

  /* ── 3. Category tree nesting ───────────────────────────────────── */
  const [apparel] = await db.select().from(categories).where(eq(categories.slug, "apparel")).limit(1);
  const children = apparel ? await db.select().from(categories).where(eq(categories.parentId, apparel.id)) : [];
  children.length === 3 ? pass("category tree (Apparel → 3 children)") : fail("category tree", `${children.length} children`);

  /* ── 4. Unique constraint: duplicate slug rejected ──────────────── */
  try {
    await db.insert(products).values({ slug: "offbeat-grid-tee", name: "Duplicate slug probe", productType: "T_SHIRT", basePrice: 100 });
    fail("unique(product.slug)", "duplicate slug was accepted");
  } catch (error) {
    /23505|duplicate key|products_slug_key/i.test(errorText(error))
      ? pass("unique(product.slug) rejects duplicates")
      : fail("unique check", errorText(error));
  }

  /* ── 5. Check constraint: negative price rejected ───────────────── */
  try {
    await db.insert(products).values({ slug: "negative-price-probe", name: "Negative price probe", productType: "MUG", basePrice: -5 });
    fail("check(products.base_price >= 0)", "negative price was accepted");
  } catch (error) {
    /23514|check constraint|base_price_non_negative/i.test(errorText(error))
      ? pass("check(products.base_price >= 0) rejects negatives")
      : fail("check constraint", errorText(error));
  }

  /* ── 6. Cascade: deleting a cart removes its items ──────────────── */
  try {
    await db.transaction(async (tx) => {
      const [cart] = await tx.insert(carts).values({ sessionId: "verify-session" }).returning();
      const [firstVariant] = await tx.select().from(productVariants).where(eq(productVariants.productId, grid.id)).limit(1);
      await tx.insert(cartItems).values({ cartId: cart.id, productId: grid.id, variantId: firstVariant.id, quantity: 2, unitPrice: 89900 });
      await tx.delete(carts).where(eq(carts.id, cart.id));
      const orphans = await tx.select().from(cartItems).where(eq(cartItems.cartId, cart.id));
      if (orphans.length !== 0) throw new Error("cart items not cascaded");
      tx.rollback();
    });
    fail("cascade probe", "transaction did not roll back as instructed");
  } catch (error) {
    if (isRollbackToken(error)) pass("cascade(cart → cart_items)");
    else if (errorText(error).includes("not cascaded")) fail("cascade(cart → items)", "orphaned items survived");
    else fail("cascade probe", errorText(error));
  }

  /* ── 7. POD event idempotency (provider + external_event_id) ────── */
  const [provider] = await db.select().from(podProviders).where(eq(podProviders.code, "printrove")).limit(1);
  try {
    await db.transaction(async (tx) => {
      const [customer] = await tx.insert(users).values({ name: "Verify Customer", email: "verify@inkline.test" }).returning();
      const [order] = await tx
        .insert(orders)
        .values({
          orderNumber: "INK-VERIFY-1",
          userId: customer.id,
          subtotalAmount: 89900,
          totalAmount: 89900,
          shippingFullName: "Verify Customer",
          shippingPhone: "9999999999",
          shippingLine1: "1 Verify Street",
          shippingCity: "Testville",
          shippingState: "Testland",
          shippingPostalCode: "110001",
        })
        .returning();
      const [podOrder] = await tx
        .insert(podOrders)
        .values({ orderId: order.id, providerId: provider.id, status: "SUBMITTED", supplierOrderId: "SUP-VERIFY-1" })
        .returning();

      await tx.insert(podEvents).values({ providerId: provider.id, podOrderId: podOrder.id, eventType: "ORDER_ACCEPTED", externalEventId: "evt-dup-1" });
      try {
        await tx.insert(podEvents).values({ providerId: provider.id, podOrderId: podOrder.id, eventType: "ORDER_ACCEPTED", externalEventId: "evt-dup-1" });
      } catch (inner) {
        if (!/23505|duplicate key|idempotency/i.test(errorText(inner))) {
          throw new Error(`unexpected inner error: ${errorText(inner)}`);
        }
        tx.rollback(); // idempotency held → unwind probe data
        return;
      }
      throw new Error("duplicate POD event was stored");
    });
    fail("pod idempotency probe", "transaction did not roll back as instructed");
  } catch (error) {
    if (isRollbackToken(error)) pass("POD event idempotency rejects duplicate external_event_id");
    else fail("pod idempotency", errorText(error));
  }

  /* ── 8. Rollback guarantees nothing persisted ───────────────────── */
  const [probeUser] = await db.select({ n: sql<number>`count(*)` }).from(users).where(eq(users.email, "verify@inkline.test"));
  const [probeCart] = await db.select({ n: sql<number>`count(*)` }).from(carts).where(eq(carts.sessionId, "verify-session"));
  Number(probeUser.n) === 0 && Number(probeCart.n) === 0
    ? pass("transaction rollback (zero probe rows persisted)")
    : fail("rollback", `leftover probe rows: users=${probeUser.n} carts=${probeCart.n}`);

  const [designCount] = await db.select({ n: sql<number>`count(*)` }).from(designs);
  Number(designCount.n) === 4 ? pass("designs seeded (4)") : fail("designs", `got ${designCount.n}`);

  console.log(failures === 0 ? "\nAll database checks passed ✓" : `\n${failures} check(s) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error("Verification crashed:", errorText(error));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
