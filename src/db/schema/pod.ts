import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { podEventTypeEnum, podOrderStatusEnum, podProviderStatusEnum } from "./enums";
import { idColumn, money, moneyNullable, timestamps, timestampsNoUpdate } from "./helpers";
import { products, productVariants } from "./catalog";
import { orders } from "./orders";

/* ── POD providers ────────────────────────────────────────────────────── */
export const podProviders = pgTable(
  "pod_providers",
  {
    ...idColumn,
    name: text("name").notNull(),
    /** Stable machine code: "printrove" | "qikink" | "printful" | … */
    code: text("code").notNull(),
    status: podProviderStatusEnum("status").notNull().default("ACTIVE"),
    isDefault: boolean("is_default").notNull().default(false),
    /**
     * Non-secret configuration only (base URLs, webhook paths, flags).
     * API keys/secrets live in environment variables — NEVER here.
     */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [uniqueIndex("pod_providers_code_key").on(table.code)],
);

/* ── Product-level supplier mapping ───────────────────────────────────── */
export const podProductMappings = pgTable(
  "pod_product_mappings",
  {
    ...idColumn,
    providerId: uuid("provider_id")
      .notNull()
      .references(() => podProviders.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    supplierProductId: text("supplier_product_id").notNull(),
    supplierSku: text("supplier_sku"),
    baseCost: moneyNullable("base_cost"),
    currency: text("currency").notNull().default("INR"),
    isActive: boolean("is_active").notNull().default(true),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("pod_product_mappings_unique").on(table.providerId, table.productId),
    index("pod_product_mappings_product_idx").on(table.productId),
    check("pod_product_mappings_cost_non_negative", sql`${table.baseCost} IS NULL OR ${table.baseCost} >= 0`),
  ],
);

/* ── Variant-level supplier mapping (print routing lives here) ────────── */
export const podVariantMappings = pgTable(
  "pod_variant_mappings",
  {
    ...idColumn,
    providerId: uuid("provider_id")
      .notNull()
      .references(() => podProviders.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    supplierVariantId: text("supplier_variant_id").notNull(),
    supplierSku: text("supplier_sku"),
    cost: moneyNullable("cost"),
    currency: text("currency").notNull().default("INR"),
    supplierAvailability: text("supplier_availability"),
    isActive: boolean("is_active").notNull().default(true),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("pod_variant_mappings_unique").on(table.providerId, table.variantId),
    index("pod_variant_mappings_variant_idx").on(table.variantId),
  ],
);

/* ── POD orders — one fulfillment job per provider per customer order ─── */
export const podOrders = pgTable(
  "pod_orders",
  {
    ...idColumn,
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => podProviders.id, { onDelete: "restrict" }),
    supplierOrderId: text("supplier_order_id"),
    status: podOrderStatusEnum("status").notNull().default("DRAFT"),
    totalCost: moneyNullable("total_cost"),
    currency: text("currency").notNull().default("INR"),
    errorMessage: text("error_message"),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "date" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" }),
    shippedAt: timestamp("shipped_at", { withTimezone: true, mode: "date" }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "date" }),
    failedAt: timestamp("failed_at", { withTimezone: true, mode: "date" }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (table) => [
    index("pod_orders_order_idx").on(table.orderId),
    index("pod_orders_status_idx").on(table.status),
    index("pod_orders_supplier_order_idx").on(table.supplierOrderId),
  ],
);

/* ── POD events — idempotent supplier event log (webhooks + polling) ──── */
export const podEvents = pgTable(
  "pod_events",
  {
    ...idColumn,
    providerId: uuid("provider_id")
      .notNull()
      .references(() => podProviders.id, { onDelete: "cascade" }),
    podOrderId: uuid("pod_order_id").references(() => podOrders.id, { onDelete: "set null" }),
    eventType: podEventTypeEnum("event_type").notNull(),
    /** Provider's event ID — with providerId forms the idempotency key. */
    externalEventId: text("external_event_id").notNull(),
    /** Trimmed summary of the payload (never the full raw webhook
     *  forever — the ingestion layer stores essentials only). */
    payloadSummary: jsonb("payload_summary").$type<Record<string, unknown>>(),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
    error: text("error"),
    ...timestampsNoUpdate,
  },
  (table) => [
    uniqueIndex("pod_events_idempotency_key").on(table.providerId, table.externalEventId),
    index("pod_events_pod_order_idx").on(table.podOrderId),
    index("pod_events_created_at_idx").on(table.createdAt),
  ],
);

export type PodProvider = typeof podProviders.$inferSelect;
export type PodOrder = typeof podOrders.$inferSelect;
export type PodEvent = typeof podEvents.$inferSelect;
