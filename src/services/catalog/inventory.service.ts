import "server-only";
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { inventoryLedger, products, productVariants } from "@/db/schema";
import { withTransaction, type DbClient, type DbTx } from "@/db/utils";
import { invalidateCatalogCache } from "@/lib/catalog/cache";
import {
  affectsStock,
  applyMovement,
  assertLedgerConsistent,
  availableQuantity,
  deriveAvailability,
  isLowStock,
  type AvailabilityStatus,
  type InventoryOperation,
  type InventoryReferenceType,
} from "@/lib/catalog/inventory";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { emitCatalogEvent } from "@/services/catalog/events.service";

/**
 * Inventory operations.
 *
 * Every mutation goes through `adjustInventory`, which:
 *   1. locks the variant row (`FOR UPDATE`) so two concurrent sales cannot both
 *      read the same balance and both succeed;
 *   2. computes the new balance with the pure rules in `lib/catalog/inventory`;
 *   3. appends a ledger row carrying previous / changed / new;
 *   4. writes the derived balance and availability back to the variant;
 *   5. re-rolls the product total from its variants;
 *   6. emits STOCK_CHANGED on the same transaction.
 *
 * A caller never writes `stock_quantity` directly. That single funnel is what
 * makes the ledger trustworthy.
 */

export interface InventoryActor {
  id: string | null;
}

export interface InventoryAdjustInput {
  productId: string;
  variantId: string;
  operation: InventoryOperation;
  /** Positive magnitude; MANUAL_ADJUSTMENT may be signed. */
  quantity: number;
  referenceType?: InventoryReferenceType;
  /** Idempotency key — replaying the same reference is a no-op. */
  referenceId?: string | null;
  reason?: string | null;
  /** Admin setting: permit overselling. Defaults to false. */
  allowNegativeStock?: boolean;
}

export interface InventoryAdjustResult {
  variantId: string;
  previousQuantity: number;
  quantityChanged: number;
  newQuantity: number;
  reservedQuantity: number;
  availability: AvailabilityStatus;
  /** True when the movement was skipped because this reference was already applied. */
  idempotentReplay: boolean;
  ledgerId: string | null;
}

/** Read a variant's balance with a row lock. `FOR UPDATE` serializes writers. */
async function lockVariant(
  tx: DbTx,
  variantId: string,
): Promise<{
  id: string;
  productId: string;
  stockQuantity: number;
  reservedQuantity: number;
  isActive: boolean;
} | null> {
  const [row] = await tx
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      stockQuantity: productVariants.stockQuantity,
      reservedQuantity: productVariants.reservedQuantity,
      isActive: productVariants.isActive,
    })
    .from(productVariants)
    .where(eq(productVariants.id, variantId))
    .for("update");
  return row ?? null;
}

async function productLowStockThreshold(
  tx: DbClient,
  productId: string,
): Promise<number> {
  const [row] = await tx
    .select({ lowStockThreshold: products.lowStockThreshold })
    .from(products)
    .where(eq(products.id, productId));
  return row?.lowStockThreshold ?? 0;
}

/** Re-derive the product rollup from its variants. Never trust a stale total. */
export async function refreshProductStock(productId: string, tx: DbClient): Promise<number> {
  const [row] = await tx
    .select({ total: sql<number>`coalesce(sum(${productVariants.stockQuantity}), 0)::int` })
    .from(productVariants)
    .where(and(eq(productVariants.productId, productId), eq(productVariants.isActive, true)));
  const total = Number(row?.total ?? 0);
  await tx.update(products).set({ stockQuantity: total, updatedAt: new Date() }).where(eq(products.id, productId));
  return total;
}

/**
 * Apply one stock movement.
 *
 * Pass `tx` to join an existing transaction (e.g. order creation deducting stock
 * and writing the order atomically). Without one, a transaction is opened here.
 */
export async function adjustInventory(
  actor: InventoryActor,
  input: InventoryAdjustInput,
  tx?: DbTx,
): Promise<InventoryAdjustResult> {
  const run = async (client: DbTx): Promise<InventoryAdjustResult> => {
    const variant = await lockVariant(client, input.variantId);
    if (!variant) throw new NotFoundError("That variant does not exist.");
    if (variant.productId !== input.productId) {
      throw new ValidationError("That variant belongs to a different product.");
    }

    const movement = { operation: input.operation, quantity: input.quantity };
    const transition = applyMovement(
      { stockQuantity: variant.stockQuantity, reservedQuantity: variant.reservedQuantity },
      movement,
      { allowNegativeStock: input.allowNegativeStock ?? false },
    );
    if (!transition.ok) throw new ValidationError(transition.errors.join(" "));

    const nextStock = affectsStock(input.operation) ? transition.next.stockQuantity : variant.stockQuantity;
    const nextReserved = affectsStock(input.operation) ? variant.reservedQuantity : transition.next.reservedQuantity;

    const threshold = await productLowStockThreshold(client, input.productId);
    const availability = deriveAvailability({
      stockQuantity: nextStock,
      reservedQuantity: nextReserved,
      lowStockThreshold: threshold,
    });

    // Idempotency: a replayed reference (webhook redelivery, retried request)
    // must not move stock twice. The variant row is already locked FOR UPDATE,
    // so concurrent writers are serialized and this check-then-insert cannot
    // race. The partial unique index is the backstop for a duplicate that
    // somehow arrives outside this path.
    if (input.referenceId) {
      const [existing] = await client
        .select({ id: inventoryLedger.id })
        .from(inventoryLedger)
        .where(
          and(
            eq(inventoryLedger.variantId, input.variantId),
            eq(inventoryLedger.operation, input.operation),
            eq(inventoryLedger.referenceId, input.referenceId),
          ),
        )
        .limit(1);
      if (existing) {
        return {
          variantId: input.variantId,
          previousQuantity: variant.stockQuantity,
          quantityChanged: 0,
          newQuantity: variant.stockQuantity,
          reservedQuantity: variant.reservedQuantity,
          availability,
          idempotentReplay: true,
          ledgerId: existing.id,
        };
      }
    }

    // previous/new describe the counter the operation moved, so a replay of the
    // ledger can reconstruct either balance.
    assertLedgerConsistent({
      previousQuantity: transition.ledgerPrevious,
      quantityChanged: transition.delta,
      newQuantity: transition.ledgerNew,
    });

    const [ledgerRow] = await client
      .insert(inventoryLedger)
      .values({
        productId: input.productId,
        variantId: input.variantId,
        previousQuantity: transition.ledgerPrevious,
        quantityChanged: transition.delta,
        newQuantity: transition.ledgerNew,
        operation: input.operation,
        referenceType: input.referenceType ?? "MANUAL",
        referenceId: input.referenceId ?? null,
        reason: input.reason?.slice(0, 280) ?? null,
        actorId: actor.id,
      })
      .returning({ id: inventoryLedger.id });
    if (!ledgerRow) throw new ValidationError("The inventory movement could not be recorded.");

    await client
      .update(productVariants)
      .set({ stockQuantity: nextStock, reservedQuantity: nextReserved, availability, updatedAt: new Date() })
      .where(eq(productVariants.id, input.variantId));

    const productStock = await refreshProductStock(input.productId, client);

    await emitCatalogEvent(client, {
      eventType: "STOCK_CHANGED",
      aggregateType: "variant",
      aggregateId: input.variantId,
      actorId: actor.id,
      payload: {
        productId: input.productId,
        variantId: input.variantId,
        operation: input.operation,
        previousQuantity: variant.stockQuantity,
        quantityChanged: transition.delta,
        newQuantity: nextStock,
        productStockQuantity: productStock,
        availability,
        referenceType: input.referenceType ?? "MANUAL",
        referenceId: input.referenceId ?? null,
      },
    });

    return {
      variantId: input.variantId,
      previousQuantity: variant.stockQuantity,
      quantityChanged: transition.delta,
      newQuantity: nextStock,
      reservedQuantity: nextReserved,
      availability,
      idempotentReplay: false,
      ledgerId: ledgerRow.id,
    };
  };

  const result = tx ? await run(tx) : await withTransaction(run);
  if (!result.idempotentReplay) invalidateCatalogCache();
  return result;
}

/**
 * Set stock to an absolute value (admin correction / stocktake).
 *
 * Recorded as a MANUAL_ADJUSTMENT with the delta, so the ledger stays complete
 * — an absolute overwrite would erase the history of how the number got there.
 */
export async function setStock(
  actor: InventoryActor,
  input: { productId: string; variantId: string; targetQuantity: number; reason?: string | null },
): Promise<InventoryAdjustResult> {
  if (!Number.isInteger(input.targetQuantity) || input.targetQuantity < 0) {
    throw new ValidationError("Target stock must be a non-negative integer.");
  }
  return withTransaction(async (tx) => {
    const variant = await lockVariant(tx, input.variantId);
    if (!variant) throw new NotFoundError("That variant does not exist.");
    const delta = input.targetQuantity - variant.stockQuantity;
    if (delta === 0) {
      const threshold = await productLowStockThreshold(tx, input.productId);
      return {
        variantId: input.variantId,
        previousQuantity: variant.stockQuantity,
        quantityChanged: 0,
        newQuantity: variant.stockQuantity,
        reservedQuantity: variant.reservedQuantity,
        availability: deriveAvailability({
          stockQuantity: variant.stockQuantity,
          reservedQuantity: variant.reservedQuantity,
          lowStockThreshold: threshold,
        }),
        idempotentReplay: true,
        ledgerId: null,
      };
    }
    return adjustInventory(
      actor,
      {
        productId: input.productId,
        variantId: input.variantId,
        operation: "MANUAL_ADJUSTMENT",
        quantity: delta,
        referenceType: "MANUAL",
        reason: input.reason ?? "Stocktake",
      },
      tx,
    );
  });
}

/** Hold stock for a cart/pending order without selling it. */
export async function reserveStock(
  actor: InventoryActor,
  input: { productId: string; variantId: string; quantity: number; orderId: string },
): Promise<InventoryAdjustResult> {
  return adjustInventory(actor, {
    productId: input.productId,
    variantId: input.variantId,
    operation: "RESERVED",
    quantity: input.quantity,
    referenceType: "ORDER",
    referenceId: input.orderId,
    reason: "Reserved for order",
  });
}

export async function releaseStock(
  actor: InventoryActor,
  input: { productId: string; variantId: string; quantity: number; orderId: string },
): Promise<InventoryAdjustResult> {
  return adjustInventory(actor, {
    productId: input.productId,
    variantId: input.variantId,
    operation: "RELEASED",
    quantity: input.quantity,
    referenceType: "ORDER",
    referenceId: `release:${input.orderId}`,
    reason: "Reservation released",
  });
}

/* ── Reads ─────────────────────────────────────────────────────────────── */

export interface LedgerRow {
  id: string;
  productId: string;
  variantId: string;
  previousQuantity: number;
  quantityChanged: number;
  newQuantity: number;
  operation: InventoryOperation;
  referenceType: InventoryReferenceType;
  referenceId: string | null;
  reason: string | null;
  actorId: string | null;
  createdAt: Date;
}

/** Movement history, newest first. Paginated — a busy variant has thousands. */
export async function getInventoryLedger(
  scope: { productId?: string; variantId?: string },
  options: { limit?: number; offset?: number; operation?: InventoryOperation } = {},
  client: DbClient = db,
): Promise<{ entries: LedgerRow[]; total: number }> {
  const conditions = [];
  if (scope.productId) conditions.push(eq(inventoryLedger.productId, scope.productId));
  if (scope.variantId) conditions.push(eq(inventoryLedger.variantId, scope.variantId));
  if (options.operation) conditions.push(eq(inventoryLedger.operation, options.operation));
  if (conditions.length === 0) throw new ValidationError("Scope the ledger to a product or a variant.");

  const where = and(...conditions);
  const [countRow] = await client
    .select({ total: sql<number>`count(*)::int` })
    .from(inventoryLedger)
    .where(where);

  const rows = await client
    .select()
    .from(inventoryLedger)
    .where(where)
    .orderBy(desc(inventoryLedger.createdAt), desc(inventoryLedger.id))
    .limit(Math.max(1, Math.min(options.limit ?? 50, 200)))
    .offset(Math.max(0, options.offset ?? 0));

  return { entries: rows as LedgerRow[], total: Number(countRow?.total ?? 0) };
}

export interface StockSummary {
  variantId: string;
  sku: string;
  name: string;
  stockQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  lowStockThreshold: number;
  availability: AvailabilityStatus;
  isLowStock: boolean;
}

/** Current balances for one product's variants. */
export async function getProductStock(productId: string, client: DbClient = db): Promise<StockSummary[]> {
  const rows = await client
    .select({
      variantId: productVariants.id,
      sku: productVariants.sku,
      name: productVariants.name,
      stockQuantity: productVariants.stockQuantity,
      reservedQuantity: productVariants.reservedQuantity,
      isActive: productVariants.isActive,
      lowStockThreshold: products.lowStockThreshold,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(productVariants.productId, productId))
    .orderBy(productVariants.position, productVariants.name);

  return rows.map((row) => {
    const balance = { stockQuantity: row.stockQuantity, reservedQuantity: row.reservedQuantity };
    return {
      variantId: row.variantId,
      sku: row.sku,
      name: row.name,
      stockQuantity: row.stockQuantity,
      reservedQuantity: row.reservedQuantity,
      availableQuantity: availableQuantity(balance),
      lowStockThreshold: row.lowStockThreshold,
      availability: deriveAvailability({ ...balance, lowStockThreshold: row.lowStockThreshold }),
      isLowStock: isLowStock({ ...balance, lowStockThreshold: row.lowStockThreshold }),
    };
  });
}

/**
 * Low-stock / out-of-stock report for the admin inventory page.
 *
 * Filtered in SQL rather than in memory: with 100k products, loading every row
 * to find the 40 that need attention is the wrong shape of query.
 */
export async function getLowStockReport(
  options: { limit?: number; offset?: number; onlyOutOfStock?: boolean } = {},
  client: DbClient = db,
): Promise<{ rows: StockSummary[]; total: number }> {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const available = sql<number>`(${productVariants.stockQuantity} - ${productVariants.reservedQuantity})`;
  const conditions = [eq(productVariants.isActive, true)];
  if (options.onlyOutOfStock) {
    conditions.push(sql`${available} <= 0`);
  } else {
    conditions.push(sql`${available} <= ${products.lowStockThreshold}`);
  }
  const where = and(...conditions);

  const [countRow] = await client
    .select({ total: sql<number>`count(*)::int` })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(where);

  const rows = await client
    .select({
      variantId: productVariants.id,
      sku: productVariants.sku,
      name: productVariants.name,
      stockQuantity: productVariants.stockQuantity,
      reservedQuantity: productVariants.reservedQuantity,
      lowStockThreshold: products.lowStockThreshold,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(where)
    .orderBy(sql`${available} asc`, productVariants.sku)
    .limit(limit)
    .offset(Math.max(0, options.offset ?? 0));

  return {
    rows: rows.map((row) => {
      const balance = { stockQuantity: row.stockQuantity, reservedQuantity: row.reservedQuantity };
      return {
        variantId: row.variantId,
        sku: row.sku,
        name: row.name,
        stockQuantity: row.stockQuantity,
        reservedQuantity: row.reservedQuantity,
        availableQuantity: availableQuantity(balance),
        lowStockThreshold: row.lowStockThreshold,
        availability: deriveAvailability({ ...balance, lowStockThreshold: row.lowStockThreshold }),
        isLowStock: isLowStock({ ...balance, lowStockThreshold: row.lowStockThreshold }),
      };
    }),
    total: Number(countRow?.total ?? 0),
  };
}

/**
 * Stock row for the admin inventory screen.
 *
 * Extends the public summary with the fields an editor needs to act on the row:
 * which product it belongs to (so the adjustment can be posted back), and the
 * ledger's own audit trail pointer. Deliberately a separate type rather than
 * widening `StockSummary` — that one is returned by the public inventory
 * endpoint, and productId/name of the owning product are fine to show but the
 * type should not quietly grow internal fields.
 */
export interface InventoryAdminRow extends StockSummary {
  productId: string;
  productName: string;
  productSlug: string;
  productStatus: string;
}

export interface InventoryAdminQuery {
  /** Restrict to one product. */
  productId?: string | null;
  /** Match on SKU or product name. */
  search?: string | null;
  /** Only rows at or below their low-stock threshold. */
  onlyLowStock?: boolean;
  /** Only rows with nothing available to sell. */
  onlyOutOfStock?: boolean;
  /** Only active variants. Defaults to true. */
  activeOnly?: boolean;
  /** Restrict to one product lifecycle status, e.g. ACTIVE. */
  productStatus?: string | null;
  sort?: "available-asc" | "available-desc" | "stock-asc" | "sku";
  limit?: number;
  offset?: number;
}

const INVENTORY_SORTS: Record<NonNullable<InventoryAdminQuery["sort"]>, SQL> = {
  "available-asc": sql`(${productVariants.stockQuantity} - ${productVariants.reservedQuantity}) asc`,
  "available-desc": sql`(${productVariants.stockQuantity} - ${productVariants.reservedQuantity}) desc`,
  "stock-asc": sql`${productVariants.stockQuantity} asc`,
  sku: sql`${productVariants.sku} asc`,
};

/**
 * Paginated stock listing for the admin inventory page.
 *
 * Every filter and the sort live in SQL. This screen has to work against a
 * 100k-product catalog, so loading variants to filter them in memory would make
 * the page cost grow with catalog size rather than with page size.
 *
 * Availability is derived from the stored balance rather than recomputed here,
 * for the same reason the storefront uses the balance: it is the same number the
 * shopper is shown, so the editor is never reconciling two sources of truth.
 */
export async function listInventoryForAdmin(
  query: InventoryAdminQuery = {},
  client: DbClient = db,
): Promise<{ rows: InventoryAdminRow[]; total: number; limit: number; offset: number }> {
  const limit = Math.max(1, Math.min(query.limit ?? 50, 200));
  const offset = Math.max(0, query.offset ?? 0);
  const available = sql<number>`(${productVariants.stockQuantity} - ${productVariants.reservedQuantity})`;

  const conditions: SQL[] = [];
  if (query.activeOnly !== false) conditions.push(eq(productVariants.isActive, true));
  if (query.productId) conditions.push(eq(productVariants.productId, query.productId));
  if (query.onlyOutOfStock) conditions.push(sql`${available} <= 0`);
  else if (query.onlyLowStock) conditions.push(sql`${available} <= ${products.lowStockThreshold}`);

  if (query.productStatus) conditions.push(eq(products.status, query.productStatus as typeof products.status.enumValues[number]));

  const needle = query.search?.trim();
  if (needle) {
    const pattern = `%${needle.replace(/[%_\\]/g, "")}%`;
    conditions.push(sql`(${productVariants.sku} ilike ${pattern} or ${products.name} ilike ${pattern})`);
  }

  const where = conditions.length ? and(...conditions) : undefined;

  const [countRow] = await client
    .select({ total: sql<number>`count(*)::int` })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(where);

  const orderBy = INVENTORY_SORTS[query.sort ?? "available-asc"];
  const rows = await client
    .select({
      productId: productVariants.productId,
      productName: products.name,
      productSlug: products.slug,
      productStatus: products.status,
      variantId: productVariants.id,
      sku: productVariants.sku,
      name: productVariants.name,
      stockQuantity: productVariants.stockQuantity,
      reservedQuantity: productVariants.reservedQuantity,
      lowStockThreshold: products.lowStockThreshold,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(where)
    .orderBy(orderBy, productVariants.sku)
    .limit(limit)
    .offset(offset);

  return {
    rows: rows.map((row) => {
      const balance = { stockQuantity: row.stockQuantity, reservedQuantity: row.reservedQuantity };
      return {
        productId: row.productId,
        productName: row.productName,
        productSlug: row.productSlug,
        productStatus: row.productStatus,
        variantId: row.variantId,
        sku: row.sku,
        name: row.name,
        stockQuantity: row.stockQuantity,
        reservedQuantity: row.reservedQuantity,
        availableQuantity: availableQuantity(balance),
        lowStockThreshold: row.lowStockThreshold,
        availability: deriveAvailability({ ...balance, lowStockThreshold: row.lowStockThreshold }),
        isLowStock: isLowStock({ ...balance, lowStockThreshold: row.lowStockThreshold }),
      };
    }),
    total: Number(countRow?.total ?? 0),
    limit,
    offset,
  };
}

/**
 * Integrity check: does every variant's stored balance match a replay of its
 * ledger? Any mismatch means something wrote stock without going through
 * `adjustInventory`, which is exactly what this module exists to prevent.
 */
export async function verifyInventoryIntegrity(
  variantIds: readonly string[],
  client: DbClient = db,
): Promise<{ checked: number; mismatches: { variantId: string; stored: number; derived: number }[] }> {
  if (variantIds.length === 0) return { checked: 0, mismatches: [] };
  const variants = await client
    .select({ id: productVariants.id, stockQuantity: productVariants.stockQuantity })
    .from(productVariants)
    .where(inArray(productVariants.id, [...variantIds]));

  const mismatches: { variantId: string; stored: number; derived: number }[] = [];
  for (const variant of variants) {
    const [row] = await client
      .select({ total: sql<number>`coalesce(sum(${inventoryLedger.quantityChanged}), 0)::int` })
      .from(inventoryLedger)
      .where(
        and(
          eq(inventoryLedger.variantId, variant.id),
          sql`${inventoryLedger.operation} NOT IN ('RESERVED', 'RELEASED')`,
        ),
      );
    const derived = Number(row?.total ?? 0);
    if (derived !== variant.stockQuantity) {
      mismatches.push({ variantId: variant.id, stored: variant.stockQuantity, derived });
    }
  }
  return { checked: variants.length, mismatches };
}
