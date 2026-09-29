import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { ticketPriorityEnum, ticketStatusEnum } from "./enums";
import { idColumn, timestamps, timestampsNoUpdate } from "./helpers";
import { orders } from "./orders";
import { users } from "./users";

/* ── Support tickets ──────────────────────────────────────────────────── */
export const supportTickets = pgTable(
  "support_tickets",
  {
    ...idColumn,
    ticketNumber: text("ticket_number").notNull(),
    /** Set null keeps the ticket if the customer account is removed. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    assignedToId: uuid("assigned_to_id").references(() => users.id, { onDelete: "set null" }),
    subject: text("subject").notNull(),
    status: ticketStatusEnum("status").notNull().default("OPEN"),
    priority: ticketPriorityEnum("priority").notNull().default("NORMAL"),
    channel: text("channel").notNull().default("email"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("support_tickets_number_key").on(table.ticketNumber),
    index("support_tickets_user_idx").on(table.userId),
    index("support_tickets_status_idx").on(table.status),
  ],
);

export const supportMessages = pgTable(
  "support_messages",
  {
    ...idColumn,
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => supportTickets.id, { onDelete: "cascade" }),
    /** Null author = system message. */
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    isStaff: boolean("is_staff").notNull().default(false),
    body: text("body").notNull(),
    ...timestampsNoUpdate,
  },
  (table) => [index("support_messages_ticket_idx").on(table.ticketId)],
);

export type SupportTicket = typeof supportTickets.$inferSelect;
export type SupportMessage = typeof supportMessages.$inferSelect;
