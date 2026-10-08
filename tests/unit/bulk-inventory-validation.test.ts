import { describe, expect, it } from "vitest";
import { bulkInventorySchema } from "@/validations/catalog";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";

/** A minimal valid batch, so each case changes exactly one thing. */
function base(overrides: Record<string, unknown> = {}) {
  return {
    operation: "STOCK_IN",
    quantity: 5,
    targets: [{ productId: UUID_A, variantId: UUID_B }],
    reason: "Restock from supplier",
    confirmation: "STOCK_IN 1",
    ...overrides,
  };
}

describe("bulkInventorySchema", () => {
  it("accepts a well-formed batch", () => {
    const parsed = bulkInventorySchema.safeParse(base());
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  });

  it("requires a reason — a bulk stock change must be explainable later", () => {
    expect(bulkInventorySchema.safeParse(base({ reason: "" })).success).toBe(false);
    expect(bulkInventorySchema.safeParse(base({ reason: "   " })).success).toBe(false);
  });

  it("rejects a zero quantity, which would write a no-op ledger row per variant", () => {
    expect(bulkInventorySchema.safeParse(base({ quantity: 0 })).success).toBe(false);
  });

  it("allows a signed quantity only within bounds", () => {
    expect(bulkInventorySchema.safeParse(base({ quantity: -5, confirmation: "STOCK_IN 1" })).success).toBe(true);
    expect(bulkInventorySchema.safeParse(base({ quantity: 1.5 })).success).toBe(false);
    expect(bulkInventorySchema.safeParse(base({ quantity: 1_000_000 })).success).toBe(false);
  });

  /**
   * SALE / RETURN / CANCELLATION / RESERVED / RELEASED describe what happened to
   * one specific order. Applying them to many variants at once would write
   * ledger rows that cannot be traced to anything real, so they are not offered.
   */
  it("offers only the operations that make sense in bulk", () => {
    for (const operation of ["STOCK_IN", "MANUAL_ADJUSTMENT", "DAMAGE"]) {
      expect(
        bulkInventorySchema.safeParse(base({ operation, confirmation: `${operation} 1` })).success,
        `${operation} should be allowed`,
      ).toBe(true);
    }
    for (const operation of ["SALE", "RETURN", "CANCELLATION", "RESERVED", "RELEASED"]) {
      expect(
        bulkInventorySchema.safeParse(base({ operation, confirmation: `${operation} 1` })).success,
        `${operation} should be rejected in bulk`,
      ).toBe(false);
    }
  });

  it("requires at least one target and caps the batch at 100", () => {
    expect(bulkInventorySchema.safeParse(base({ targets: [] })).success).toBe(false);

    const hundred = Array.from({ length: 100 }, () => ({ productId: UUID_A, variantId: UUID_B }));
    expect(bulkInventorySchema.safeParse(base({ targets: hundred, confirmation: "STOCK_IN 100" })).success).toBe(true);

    const hundredAndOne = [...hundred, { productId: UUID_A, variantId: UUID_C }];
    expect(bulkInventorySchema.safeParse(base({ targets: hundredAndOne })).success).toBe(false);
  });

  it("rejects a target whose product and variant ids are not both uuids", () => {
    expect(bulkInventorySchema.safeParse(base({ targets: [{ productId: "nope", variantId: UUID_B }] })).success).toBe(
      false,
    );
    expect(
      bulkInventorySchema.safeParse(base({ targets: [{ productId: UUID_A, variantId: "nope" }] })).success,
    ).toBe(false);
    // A dropped field must not slip through as undefined.
    expect(bulkInventorySchema.safeParse(base({ targets: [{ productId: UUID_A }] })).success).toBe(false);
  });

  it("rejects a reference type outside the database enum", () => {
    expect(bulkInventorySchema.safeParse(base({ referenceType: "MANUAL" })).success).toBe(true);
    expect(bulkInventorySchema.safeParse(base({ referenceType: "PURCHASE_ORDER" })).success).toBe(true);
    expect(bulkInventorySchema.safeParse(base({ referenceType: "ORDER_LINE" })).success).toBe(false);
  });

  it("keeps the confirmation field, so the action layer can enforce the typed phrase", () => {
    const parsed = bulkInventorySchema.parse(base({ confirmation: "STOCK_IN 1" }));
    expect(parsed.confirmation).toBe("STOCK_IN 1");
  });
});
