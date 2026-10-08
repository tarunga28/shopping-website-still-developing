/**
 * Inventory rules (pure).
 *
 * Stock is an **append-only ledger**. `product_variants.stock_quantity` is a
 * fast read path; the ledger is the record. Every movement writes
 * previous / changed / new, so the balance can always be re-derived by replay
 * and an audit can answer "why was this 3 yesterday?".
 *
 * Invariants enforced here (and again by CHECK constraints in the database):
 *   previous + changed = new
 *   new >= 0            (unless an admin explicitly allows overselling)
 *   changed != 0        (a no-op movement is noise, not an event)
 *
 * Direction is fixed per operation so a caller cannot accidentally add stock
 * when recording a sale:
 *   SALE, DAMAGE                → negative (stock leaves)
 *   STOCK_IN, RETURN, CANCELLATION, RELEASED → positive (stock arrives)
 *   MANUAL_ADJUSTMENT           → either sign (corrections go both ways)
 *   RESERVED / RELEASED         → move the *reserved* counter, not stock
 */

export const INVENTORY_OPERATIONS = [
  "STOCK_IN",
  "SALE",
  "RETURN",
  "CANCELLATION",
  "MANUAL_ADJUSTMENT",
  "DAMAGE",
  "RESERVED",
  "RELEASED",
] as const;
export type InventoryOperation = (typeof INVENTORY_OPERATIONS)[number];

export const INVENTORY_REFERENCE_TYPES = [
  "ORDER",
  "ORDER_ITEM",
  "RETURN",
  "CANCELLATION",
  "PURCHASE_ORDER",
  "IMPORT_BATCH",
  "MANUAL",
] as const;
export type InventoryReferenceType = (typeof INVENTORY_REFERENCE_TYPES)[number];

/** Operations that change the on-hand quantity. */
export const STOCK_OPERATIONS: readonly InventoryOperation[] = [
  "STOCK_IN",
  "SALE",
  "RETURN",
  "CANCELLATION",
  "MANUAL_ADJUSTMENT",
  "DAMAGE",
];

/** Operations that move stock into/out of the reservation bucket. */
export const RESERVATION_OPERATIONS: readonly InventoryOperation[] = ["RESERVED", "RELEASED"];

export const AVAILABILITY_STATUSES = ["IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK", "PREORDER"] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

/** Reason strings are bounded so a bulk import cannot write a novel per row. */
export const REASON_MAX_LENGTH = 280;

export function isInventoryOperation(value: string): value is InventoryOperation {
  return (INVENTORY_OPERATIONS as readonly string[]).includes(value);
}

/** True when the operation touches `stock_quantity` rather than `reserved_quantity`. */
export function affectsStock(operation: InventoryOperation): boolean {
  return STOCK_OPERATIONS.includes(operation);
}

export function affectsReservation(operation: InventoryOperation): boolean {
  return RESERVATION_OPERATIONS.includes(operation);
}

/**
 * Signed delta of the counter an operation affects.
 *
 * `quantity` is always supplied as a positive magnitude; the sign comes from the
 * operation. Passing a negative magnitude for a SALE would silently restock the
 * item, so that is rejected rather than coerced.
 *
 * Which counter, and which direction:
 *   STOCK_IN / RETURN / CANCELLATION   on-hand    +
 *   SALE / DAMAGE                      on-hand    −
 *   RESERVED                           reserved   +   (unit is held, still on the shelf)
 *   RELEASED                           reserved   −   (hold dropped)
 *   MANUAL_ADJUSTMENT                  on-hand    ±   (a stocktake correction goes either way)
 *
 * Note RESERVED increases the reservation counter: reserving does not remove the
 * unit from the shelf, it removes it from what can be sold. The ledger row for a
 * reservation therefore records the reservation counter in previous/new, which
 * is why `affectsStock` exists — replay must sum the two counters separately.
 */
export function signedDelta(operation: InventoryOperation, quantity: number): number {
  if (!Number.isInteger(quantity) || quantity === 0) {
    throw new Error("Inventory quantity must be a non-zero integer.");
  }
  if (operation === "MANUAL_ADJUSTMENT") {
    // Corrections are legitimately signed: -2 for damage found, +3 for stock found.
    return quantity;
  }
  if (quantity < 0) {
    throw new Error(`Quantity for ${operation} must be positive; the direction is fixed by the operation.`);
  }
  switch (operation) {
    case "STOCK_IN":
    case "RETURN":
    case "CANCELLATION":
    case "RESERVED":
      return quantity;
    case "SALE":
    case "DAMAGE":
    case "RELEASED":
      return -quantity;
    default:
      throw new Error(`Unsupported inventory operation: ${operation}`);
  }
}

export interface InventoryBalance {
  stockQuantity: number;
  reservedQuantity: number;
}

export interface InventoryMovement {
  operation: InventoryOperation;
  /** Positive magnitude, except MANUAL_ADJUSTMENT which may be signed. */
  quantity: number;
}

export interface InventoryTransition {
  ok: boolean;
  errors: string[];
  next: InventoryBalance;
  /** Signed amount written to `quantity_changed`. */
  delta: number;
  /**
   * Which counter the ledger row's previous/new columns describe. A reservation
   * moves the reservation counter, not on-hand stock, and the ledger must say
   * which one it recorded or a replay cannot reconstruct the balance.
   */
  ledgerCounter: "stock" | "reserved";
  ledgerPrevious: number;
  ledgerNew: number;
}

export interface InventoryPolicy {
  /** Admin setting: allow selling more than is on hand. Off by default. */
  allowNegativeStock?: boolean;
}

/**
 * Apply one movement to a balance.
 *
 * Returns errors instead of throwing so a bulk import can report per-row
 * problems and keep going rather than aborting the whole batch.
 */
export function applyMovement(
  balance: InventoryBalance,
  movement: InventoryMovement,
  policy: InventoryPolicy = {},
): InventoryTransition {
  const errors: string[] = [];
  const allowNegative = policy.allowNegativeStock ?? false;

  let delta: number;
  try {
    delta = signedDelta(movement.operation, movement.quantity);
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : "Invalid inventory movement."],
      next: { ...balance },
      delta: 0,
      ledgerCounter: "stock",
      ledgerPrevious: balance.stockQuantity,
      ledgerNew: balance.stockQuantity,
    };
  }

  const next = { ...balance };
  const touchesStock = affectsStock(movement.operation);

  if (touchesStock) {
    next.stockQuantity = balance.stockQuantity + delta;
    if (next.stockQuantity < 0 && !allowNegative) {
      errors.push(`This would take stock to ${next.stockQuantity}. Only ${balance.stockQuantity} on hand.`);
    }
  } else {
    next.reservedQuantity = balance.reservedQuantity + delta;
    // A reservation can never exceed what is physically on hand.
    if (next.reservedQuantity > balance.stockQuantity) {
      errors.push(
        `Cannot reserve ${movement.quantity}: only ${Math.max(0, balance.stockQuantity - balance.reservedQuantity)} unreserved unit(s) remain.`,
      );
    }
    if (next.reservedQuantity < 0) {
      errors.push("Cannot release more than is currently reserved.");
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    next,
    delta,
    ledgerCounter: touchesStock ? "stock" : "reserved",
    ledgerPrevious: touchesStock ? balance.stockQuantity : balance.reservedQuantity,
    ledgerNew: touchesStock ? next.stockQuantity : next.reservedQuantity,
  };
}

/** Derive the storefront availability label from real numbers. */
export function deriveAvailability(input: {
  stockQuantity: number;
  reservedQuantity: number;
  lowStockThreshold: number;
  /** A preorder product can be bought at zero stock. */
  isPreorder?: boolean;
  /** The product is retired; nothing is purchasable regardless of stock. */
  isDiscontinued?: boolean;
}): AvailabilityStatus {
  if (input.isDiscontinued) return "OUT_OF_STOCK";
  const available = input.stockQuantity - Math.max(0, input.reservedQuantity);
  if (available <= 0) return input.isPreorder ? "PREORDER" : "OUT_OF_STOCK";
  if (available <= Math.max(0, input.lowStockThreshold)) return "LOW_STOCK";
  return "IN_STOCK";
}

/** Units that can actually be sold right now. */
export function availableQuantity(balance: InventoryBalance): number {
  return Math.max(0, balance.stockQuantity - Math.max(0, balance.reservedQuantity));
}

export interface LedgerEntryInput {
  previousQuantity: number;
  quantityChanged: number;
  newQuantity: number;
}

/** The consistency check the database also enforces — validated early for a good message. */
export function assertLedgerConsistent(entry: LedgerEntryInput): void {
  if (!Number.isInteger(entry.previousQuantity) || entry.previousQuantity < 0) {
    throw new Error("Previous quantity must be a non-negative integer.");
  }
  if (!Number.isInteger(entry.quantityChanged) || entry.quantityChanged === 0) {
    throw new Error("Quantity changed must be a non-zero integer.");
  }
  if (!Number.isInteger(entry.newQuantity)) {
    throw new Error("New quantity must be an integer.");
  }
  if (entry.previousQuantity + entry.quantityChanged !== entry.newQuantity) {
    throw new Error(
      `Ledger entry is inconsistent: ${entry.previousQuantity} + ${entry.quantityChanged} ≠ ${entry.newQuantity}.`,
    );
  }
  if (entry.newQuantity < 0) throw new Error("Stock cannot go below zero.");
}

/** Replay a ledger to reconstruct the balance. Used by the integrity check. */
export function replayLedger(
  entries: readonly { quantityChanged: number; operation: InventoryOperation }[],
): { stockQuantity: number; reservedQuantity: number } {
  let stockQuantity = 0;
  let reservedQuantity = 0;
  for (const entry of entries) {
    if (affectsStock(entry.operation)) stockQuantity += entry.quantityChanged;
    else reservedQuantity += entry.quantityChanged;
  }
  return { stockQuantity, reservedQuantity };
}

/** Low-stock report predicate, shared by the admin dashboard and the API. */
export function isLowStock(input: {
  stockQuantity: number;
  reservedQuantity: number;
  lowStockThreshold: number;
}): boolean {
  return availableQuantity(input) <= Math.max(0, input.lowStockThreshold);
}

/** Roll a set of variant balances up to the product total. */
export function rollUpVariants(variants: readonly InventoryBalance[]): InventoryBalance {
  return variants.reduce(
    (total, variant) => ({
      stockQuantity: total.stockQuantity + variant.stockQuantity,
      reservedQuantity: total.reservedQuantity + variant.reservedQuantity,
    }),
    { stockQuantity: 0, reservedQuantity: 0 },
  );
}
