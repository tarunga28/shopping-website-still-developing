/**
 * Schema barrel — single import surface for tables, enums and types.
 * The underlying tables are organized by domain:
 *
 *   users.ts        users, addresses
 *   catalog.ts      categories, collections, products, variants, designs, tags, images
 *   commerce.ts     carts, cart items, wishlists
 *   orders.ts       orders (snapshots), order items, payments, refunds, shipments
 *   pod.ts          POD providers, product/variant mappings, POD orders, POD events
 *   engagement.ts   coupons (+ targeting/usages), reviews, notifications
 *   support.ts      support tickets, messages
 *   system.ts       newsletter, audit trail, analytics events
 */

export * from "./enums";
export * from "./users";
export * from "./auth";
export * from "./catalog";

export * from "./commerce";
export * from "./orders";
export * from "./pod";
export * from "./engagement";
export * from "./support";
export * from "./system";
