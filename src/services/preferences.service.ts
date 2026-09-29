import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userPreferences, type UserPreferences } from "@/db/schema";
import type { PreferencesInput } from "@/validations/account";

/**
 * Account preferences — server-side defaults merged with persisted row.
 * Lazy: the row is upserted on first save.
 */

export type PreferencesDTO = Pick<
  UserPreferences,
  "marketingEmails" | "orderNotifications" | "promotionalNotifications" | "language" | "currency"
>;

export const DEFAULT_PREFERENCES: PreferencesDTO = {
  marketingEmails: true,
  orderNotifications: true,
  promotionalNotifications: false,
  language: "en-IN",
  currency: "INR",
};

export async function getPreferences(userId: string): Promise<PreferencesDTO> {
  const [row] = await db.select().from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1);
  if (!row) return DEFAULT_PREFERENCES;
  return {
    marketingEmails: row.marketingEmails,
    orderNotifications: row.orderNotifications,
    promotionalNotifications: row.promotionalNotifications,
    language: row.language,
    currency: row.currency,
  };
}

export async function savePreferences(userId: string, input: PreferencesInput): Promise<PreferencesDTO> {
  await db
    .insert(userPreferences)
    .values({ userId, ...input })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: {
        marketingEmails: input.marketingEmails,
        orderNotifications: input.orderNotifications,
        promotionalNotifications: input.promotionalNotifications,
        language: input.language,
        currency: input.currency,
        updatedAt: new Date(),
      },
    });
  return input;
}
