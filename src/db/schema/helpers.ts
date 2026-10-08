import { customType, integer, timestamp, uuid, type PgTextBuilderInitial } from "drizzle-orm/pg-core";

/**
 * Shared column helpers so every table gets identical, well-typed columns.
 *
 * MONEY CONVENTION (platform-wide):
 *   All monetary columns are INTEGER minor units (paise for INR) with a
 *   CHECK(amount >= 0) constraint. Integers are exact — no float drift —
 *   and match the `formatPrice` helpers used across the app.
 */

/**
 * PostgreSQL `tsvector`. Drizzle has no built-in type for it, and the column is
 * always written by a generated expression or `to_tsvector(...)` — never by
 * application string interpolation — so a plain opaque type is correct here.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

export const idColumn = {
  id: uuid("id").defaultRandom().primaryKey(),
};

export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const timestampsNoUpdate = {
  createdAt: timestamps.createdAt,
};

/** Required money column in minor units. */
export function money(name: string) {
  return integer(name).notNull();
}

/** Optional money column in minor units. */
export function moneyNullable(name: string) {
  return integer(name).$type<number | null>();
}

/** Zero-default money column (discounts, taxes, counts). */
export function moneyZero(name: string) {
  return integer(name).notNull().default(0);
}

export type { PgTextBuilderInitial };
