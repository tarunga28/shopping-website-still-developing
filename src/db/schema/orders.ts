import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  fulfillmentStatusEnum,
  orderStatusEnum,
  paymentStatusEnum,
  refundStatusEnum,
  shipmentStatusEnum,
} from "./enums";
import { idColumn, money, moneyZero, timestamps, timestampsNoUpdate } from "./helpers";
import { products, productVariants } from "./catalog";
import { users } from "./users";

/* ── Orders ───────────────────────────────────────────────────────────── */
export const orders = pgTable(
  "orders",
  {
    ...idColumn,
    /** Human-facing number, e.g. INK-2026-000123. Unique forever. */
    orderNumber: text("order_number").notNull(),
    /** Kept (set null on user deletion) so sales history survives. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),

    /* Four independent status systems — each transitions separately. */
    status: orderStatusEnum("status").notNull().default("PENDING"),
    paymentStatus: paymentStatusEnum("payment_status").notNull().default("PENDING"),
    fulfillmentStatus: fulfillmentStatusEnum("fulfillment_status")
      .notNull()
      .default("UNFULFILLED"),
    shippingStatus: shipmentStatusEnum("shipping_status").notNull().default("NOT_SHIPPED"),

    currency: text("currency").notNull().default("INR"),
    /** All amounts in minor units, computed server-side. */
    subtotalAmount: money("subtotal_amount"),
    discountAmount: moneyZero("discount_amount"),
    shippingAmount: moneyZero("shipping_amount"),
    taxAmount: moneyZero("tax_amount"),
    totalAmount: money("total_amount"),

    couponCode: text("coupon_code"),
    couponId: uuid("coupon_id"), // FK added by engagement schema relation (nullable, no cascade)

    internalNotes: text("internal_notes"),
    customerNotes: text("customer_notes"),

    /* Shipping address snapshot — immutable history even if the
       customer's saved addresses change later. */
    shippingFullName: text("shipping_full_name").notNull(),
    shippingPhone: text("shipping_phone").notNull(),
    shippingLine1: text("shipping_line1").notNull(),
    shippingLine2: text("shipping_line2"),
    shippingCity: text("shipping_city").notNull(),
    shippingState: text("shipping_state").notNull(),
    shippingPostalCode: text("shipping_postal_code").notNull(),
    shippingCountry: text("shipping_country").notNull().default("IN"),
    shippingLandmark: text("shipping_landmark"),

    billingSameAsShipping: boolean("billing_same_as_shipping").notNull().default(true),
    billingFullName: text("billing_full_name"),
    billingLine1: text("billing_line1"),
    billingLine2: text("billing_line2"),
    billingCity: text("billing_city"),
    billingState: text("billing_state"),
    billingPostalCode: text("billing_postal_code"),
    billingCountry: text("billing_country"),

    paidAt: timestamp("paid_at", { withTimezone: true, mode: "date" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
    cancelReason: text("cancel_reason"),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("orders_order_number_key").on(table.orderNumber),
    index("orders_user_id_idx").on(table.userId),
    index("orders_status_idx").on(table.status),
    index("orders_payment_status_idx").on(table.paymentStatus),
    index("orders_created_at_idx").on(table.createdAt),
    check("orders_amounts_non_negative", sql`${table.subtotalAmount} >= 0 AND ${table.totalAmount} >= 0`),
  ],
);

/* ── Order items — full purchase-time snapshots ───────────────────────── */
export const orderItems = pgTable(
  "order_items",
  {
    ...idColumn,
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** Nullable FKs (set null): history survives catalog edits/deletions. */
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "set null" }),

    /* Snapshots (immutable once written) */
    productName: text("product_name").notNull(),
    variantName: text("variant_name").notNull(),
    sku: text("sku").notNull(),
    designSnapshot: jsonb("design_snapshot").$type<{
      designId?: string;
      designName?: string;
      placements?: string[];
    }>(),

    quantity: integer("quantity").notNull(),
    unitPrice: money("unit_price"),
    discountAmount: moneyZero("discount_amount"),
    totalPrice: money("total_price"),
    ...timestampsNoUpdate,
  },
  (table) => [
    index("order_items_order_idx").on(table.orderId),
    index("order_items_product_idx").on(table.productId),
    check("order_items_quantity_positive", sql`${table.quantity} > 0`),
    check("order_items_prices_non_negative", sql`${table.unitPrice} >= 0 AND ${table.totalPrice} >= 0`),
  ],
);

/* ── Payments — provider references only, never card data ─────────────── */
export const payments = pgTable(
  "payments",
  {
    ...idColumn,
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** "razorpay" | "stripe" | "cod" | future providers */
    provider: text("provider").notNull(),
    providerPaymentId: text("provider_payment_id"),
    providerOrderId: text("provider_order_id"),
    amount: money("amount"),
    currency: text("currency").notNull().default("INR"),
    status: paymentStatusEnum("status").notNull().default("PENDING"),
    /** upi | card | netbanking | wallet — provider-reported. */
    method: text("method"),
    failureReason: text("failure_reason"),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("payments_provider_payment_id_key").on(table.providerPaymentId),
    index("payments_order_idx").on(table.orderId),
    index("payments_status_idx").on(table.status),
    check("payments_amount_positive", sql`${table.amount} > 0`),
  ],
);

/* ── Refunds (full + partial) ─────────────────────────────────────────── */
export const refunds = pgTable(
  "refunds",
  {
    ...idColumn,
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    paymentId: uuid("payment_id").references(() => payments.id, { onDelete: "set null" }),
    amount: money("amount"),
    currency: text("currency").notNull().default("INR"),
    reason: text("reason"),
    status: refundStatusEnum("status").notNull().default("PENDING"),
    providerRefundId: text("provider_refund_id"),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
    ...timestampsNoUpdate,
  },
  (table) => [index("refunds_order_idx").on(table.orderId)],
);

/* ── Shipments — carrier-agnostic, multiple per order allowed ─────────── */
export const shipments = pgTable(
  "shipments",
  {
    ...idColumn,
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    carrier: text("carrier"),
    trackingNumber: text("tracking_number"),
    trackingUrl: text("tracking_url"),
    status: shipmentStatusEnum("status").notNull().default("NOT_SHIPPED"),
    estimatedDeliveryAt: timestamp("estimated_delivery_at", { withTimezone: true, mode: "date" }),
    shippedAt: timestamp("shipped_at", { withTimezone: true, mode: "date" }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (table) => [
    index("shipments_order_idx").on(table.orderId),
    index("shipments_tracking_idx").on(table.carrier, table.trackingNumber),
  ],
);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderItem = typeof orderItems.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type Refund = typeof refunds.$inferSelect;
export type Shipment = typeof shipments.$inferSelect;
