import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { couponTypeEnum, notificationTypeEnum, reviewStatusEnum } from "./enums";
import { idColumn, moneyNullable, moneyZero, timestamps, timestampsNoUpdate } from "./helpers";
import { categories, collections, products } from "./catalog";
import { orders } from "./orders";
import { users } from "./users";

/* ── Coupons ──────────────────────────────────────────────────────────── */
export const coupons = pgTable(
  "coupons",
  {
    ...idColumn,
    /** Stored uppercase by the application layer. */
    code: text("code").notNull(),
    type: couponTypeEnum("type").notNull(),
    /** PERCENTAGE → 0–100; FIXED_AMOUNT → minor units; FREE_SHIPPING → 0. */
    value: integer("value").notNull(),
    minimumOrderAmount: moneyNullable("minimum_order_amount"),
    maximumDiscountAmount: moneyNullable("maximum_discount_amount"),
    usageLimit: integer("usage_limit"),
    perUserLimit: integer("per_user_limit"),
    usageCount: integer("usage_count").notNull().default(0),
    startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("coupons_code_key").on(table.code),
    index("coupons_active_idx").on(table.isActive),
    check("coupons_value_non_negative", sql`${table.value} >= 0`),
    check("coupons_percentage_range", sql`${table.type} != 'PERCENTAGE' OR ${table.value} <= 100`),
  ],
);

/** Every redemption (who used what, on which order). */
export const couponUsages = pgTable(
  "coupon_usages",
  {
    ...idColumn,
    couponId: uuid("coupon_id")
      .notNull()
      .references(() => coupons.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    discountApplied: moneyZero("discount_applied"),
    ...timestampsNoUpdate,
  },
  (table) => [
    index("coupon_usages_coupon_idx").on(table.couponId),
    index("coupon_usages_user_idx").on(table.userId),
  ],
);

/* ── Coupon targeting (empty set of a dimension = unrestricted) ───────── */
export const couponProducts = pgTable(
  "coupon_products",
  {
    couponId: uuid("coupon_id")
      .notNull()
      .references(() => coupons.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.couponId, table.productId] })],
);

export const couponCategories = pgTable(
  "coupon_categories",
  {
    couponId: uuid("coupon_id")
      .notNull()
      .references(() => coupons.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.couponId, table.categoryId] })],
);

export const couponCollections = pgTable(
  "coupon_collections",
  {
    couponId: uuid("coupon_id")
      .notNull()
      .references(() => coupons.id, { onDelete: "cascade" }),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.couponId, table.collectionId] })],
);

export const couponCustomers = pgTable(
  "coupon_customers",
  {
    couponId: uuid("coupon_id")
      .notNull()
      .references(() => coupons.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.couponId, table.userId] })],
);

/* ── Reviews ──────────────────────────────────────────────────────────── */
export const reviews = pgTable(
  "reviews",
  {
    ...idColumn,
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** Purchase link powers verified-preview logic — set null keeps the
     *  review if the order row is ever removed. */
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    rating: integer("rating").notNull(),
    title: text("title"),
    content: text("content"),
    status: reviewStatusEnum("status").notNull().default("PENDING"),
    verifiedPurchase: boolean("verified_purchase").notNull().default(false),
    helpfulCount: integer("helpful_count").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    index("reviews_product_idx").on(table.productId),
    index("reviews_status_idx").on(table.status),
    uniqueIndex("reviews_unique_per_order").on(table.userId, table.productId, table.orderId),
    check("reviews_rating_range", sql`${table.rating} BETWEEN 1 AND 5`),
  ],
);

/* ── Notifications ────────────────────────────────────────────────────── */
export const notifications = pgTable(
  "notifications",
  {
    ...idColumn,
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: notificationTypeEnum("type").notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    linkHref: text("link_href"),
    /** Read state is timestamp-based (readAt NULL = unread). */
    readAt: timestamp("read_at", { withTimezone: true, mode: "date" }),
    ...timestampsNoUpdate,
  },
  (table) => [
    index("notifications_user_idx").on(table.userId),
    index("notifications_user_unread_idx").on(table.userId, table.readAt),
  ],
);

export type Coupon = typeof coupons.$inferSelect;
export type Review = typeof reviews.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
