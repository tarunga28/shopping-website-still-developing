import "server-only";
import { db } from "@/db";

/**
 * Database utility layer — wraps the pooled client with helpers that
 * every service should prefer over touching `db` directly.
 */

/** Drizzle transaction handle type. */
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbClient = typeof db | DbTx;

/**
 * Run a unit of work inside a single transaction. Any throw rolls back
 * ALL writes — use for every multi-record business operation
 * (order creation, refunds, POD submission, coupon redemption…).
 */
export async function withTransaction<T>(work: (tx: DbTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => work(tx));
}

/**
 * Order-number generation: INK-YYYY-000123. Derived from the count of
 * today's orders sequence-wise — safe enough behind a unique index and
 * the transaction that creates the order (retry on conflict).
 */
export function formatOrderNumber(sequence: number, date = new Date()): string {
  const year = date.getUTCFullYear();
  const padded = String(sequence).padStart(6, "0");
  return `INK-${year}-${padded}`;
}
