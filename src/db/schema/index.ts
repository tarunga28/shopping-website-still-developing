/**
 * Schema barrel — single import surface for tables, enums and types.
 * The underlying tables are organized by domain:
 *
 *   users.ts        users, addresses
 *   catalog.ts      brands, categories, collections, products, variants, designs, tags, media
 *   catalog-intelligence.ts
 *                   attribute engine, inventory ledger, price rules, product
 *                   relations, event outbox, search index/synonyms/suggestions
 *   search.ts       Part 12: spell-correction vocabulary, search history,
 *                   search click events, ranking configs, experiments
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
export * from "./catalog-intelligence";
export * from "./search";

export * from "./commerce";
export * from "./orders";
export * from "./pod";
export * from "./engagement";
export * from "./support";
export * from "./system";
