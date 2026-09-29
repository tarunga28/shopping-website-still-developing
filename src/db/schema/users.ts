import { boolean, index, integer, pgTable, text, uniqueIndex, timestamp, uuid } from "drizzle-orm/pg-core";
import { userRoleEnum, userStatusEnum } from "./enums";
import { idColumn, timestamps } from "./helpers";

/**
 * Users — one row per human: customers and staff share the table,
 * separated by `role`. Passwords are ONLY ever stored as hashes
 * (scrypt/argon from the auth layer); OAuth-only users may have a null
 * hash.
 */
export const users = pgTable(
  "users",
  {
    ...idColumn,
    name: text("name").notNull(),
    email: text("email").notNull(),
    phone: text("phone"),
    /** Never a plain-text password. Null for OAuth-only accounts. */
    passwordHash: text("password_hash"),
    role: userRoleEnum("role").notNull().default("CUSTOMER"),
    status: userStatusEnum("status").notNull().default("ACTIVE"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true, mode: "date" }),
    /** CDN/storage URL of the user's avatar (never a filesystem path). */
    avatarUrl: text("avatar_url"),
    /** Email pending verification for the secure email-change flow. */
    pendingEmail: text("pending_email"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: "date" }),
    /**
     * Bumped on password change/reset or security events. Embedded in
     * the session JWT — a mismatch invalidates the session server-side
     * without needing a session table.
     */
    securityStamp: integer("security_stamp").notNull().default(1),
    ...timestamps,
  },
  (table) => [uniqueIndex("users_email_key").on(table.email), index("users_role_idx").on(table.role)],
);

/** Reusable addresses — a customer can store many; orders snapshot them. */
export const addresses = pgTable(
  "addresses",
  {
    ...idColumn,
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fullName: text("full_name").notNull(),
    phone: text("phone").notNull(),
    addressLine1: text("address_line1").notNull(),
    addressLine2: text("address_line2"),
    city: text("city").notNull(),
    state: text("state").notNull(),
    postalCode: text("postal_code").notNull(),
    country: text("country").notNull().default("IN"),
    landmark: text("landmark"),
    isDefault: boolean("is_default").notNull().default(false),
    ...timestamps,
  },
  (table) => [index("addresses_user_id_idx").on(table.userId)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Address = typeof addresses.$inferSelect;
export type NewAddress = typeof addresses.$inferInsert;
