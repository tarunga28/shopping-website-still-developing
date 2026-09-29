import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { analyticsEventTypeEnum } from "./enums";
import { idColumn, timestampsNoUpdate } from "./helpers";
import { products } from "./catalog";
import { users } from "./users";

/* ── Newsletter (pre-launch capture — live since Part 1) ──────────────── */
export const newsletterSubscribers = pgTable(
  "newsletter_subscribers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Stored lowercase; uniqueness enforced at the DB level. */
    email: text("email").notNull(),
    source: text("source").notNull().default("homepage"),
    /** SHA-256 hash of the signup IP (salted) — raw IPs are never stored. */
    ipHash: text("ip_hash"),
    consentedAt: timestamp("consented_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("newsletter_subscribers_email_key").on(table.email)],
);

/* ── Audit log — append-only admin/security trail ─────────────────────── */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Acting staff user (null = system/customer-originated). */
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    /** e.g. "product.created", "order.refunded", "user.suspended". */
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    /** Redacted context — never passwords, card data or API secrets. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    /** Privacy-preserving salted hash of the actor IP. */
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_events_action_idx").on(table.action),
    index("audit_events_entity_idx").on(table.entityType, table.entityId),
    index("audit_events_actor_idx").on(table.actorId),
    index("audit_events_created_at_idx").on(table.createdAt),
  ],
);

/* ── Analytics events — small, pre-aggregable commerce signals ────────── */
export const analyticsEvents = pgTable(
  "analytics_events",
  {
    ...idColumn,
    eventType: analyticsEventTypeEnum("event_type").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    sessionId: text("session_id"),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    /** Small structured context (query text, variant id, cart value). */
    context: jsonb("context").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("analytics_events_type_created_idx").on(table.eventType, table.createdAt),
    index("analytics_events_product_idx").on(table.productId),
    index("analytics_events_created_at_idx").on(table.createdAt),
  ],
);

export type NewsletterSubscriber = typeof newsletterSubscribers.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type AnalyticsEvent = typeof analyticsEvents.$inferSelect;
