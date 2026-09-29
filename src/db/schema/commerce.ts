import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { cartStatusEnum } from "./enums";
import { idColumn, money, timestamps, timestampsNoUpdate } from "./helpers";
import { products, productVariants } from "./catalog";
import { users } from "./users";

/* ── Cart ─────────────────────────────────────────────────────────────── */
export const carts = pgTable(
  "carts",
  {
    ...idColumn,
    /** Registered owner; null for guest carts. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    /** Anonymous session token (hashed) for guest carts. */
    sessionId: text("session_id"),
    status: cartStatusEnum("status").notNull().default("ACTIVE"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (table) => [
    index("carts_user_idx").on(table.userId),
    index("carts_session_idx").on(table.sessionId),
    index("carts_status_idx").on(table.status),
  ],
);

export const cartItems = pgTable(
  "cart_items",
  {
    ...idColumn,
    cartId: uuid("cart_id")
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull(),
    /**
     * Price snapshot (minor units) captured server-side at add-to-cart
     * time — checkout re-verifies against the catalog; the frontend
     * price is never trusted.
     */
    unitPrice: money("unit_price"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("cart_items_cart_variant_key").on(table.cartId, table.variantId),
    index("cart_items_cart_idx").on(table.cartId),
    check("cart_items_quantity_positive", sql`${table.quantity} > 0`),
    check("cart_items_unit_price_non_negative", sql`${table.unitPrice} >= 0`),
  ],
);

/* ── Wishlist ─────────────────────────────────────────────────────────── */
export const wishlists = pgTable(
  "wishlists",
  {
    ...idColumn,
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("Saved items"),
    ...timestampsNoUpdate,
  },
  (table) => [uniqueIndex("wishlists_user_name_key").on(table.userId, table.name)],
);

export const wishlistItems = pgTable(
  "wishlist_items",
  {
    ...idColumn,
    wishlistId: uuid("wishlist_id")
      .notNull()
      .references(() => wishlists.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** Optional when the whole product is wished rather than a variant. */
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
    ...timestampsNoUpdate,
  },
  (table) => [
    uniqueIndex("wishlist_items_unique_product").on(table.wishlistId, table.productId),
    index("wishlist_items_wishlist_idx").on(table.wishlistId),
  ],
);

export type Cart = typeof carts.$inferSelect;
export type CartItem = typeof cartItems.$inferSelect;
export type Wishlist = typeof wishlists.$inferSelect;
export type WishlistItem = typeof wishlistItems.$inferSelect;
