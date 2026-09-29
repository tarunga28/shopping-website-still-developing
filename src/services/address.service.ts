import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { addresses, type Address } from "@/db/schema";
import { withTransaction } from "@/db/utils";
import { AppError, NotFoundError } from "@/lib/errors";
import { writeAudit } from "@/services/audit.service";
import type { AddressInput } from "@/validations/account";

/**
 * Address book service — every function is scoped by an authenticated
 * user id supplied by the session-bound caller. Authorization lives here,
 * never in the UI.
 */

export type AddressDTO = Omit<Address, never>;

export async function listAddresses(userId: string): Promise<AddressDTO[]> {
  return db
    .select()
    .from(addresses)
    .where(eq(addresses.userId, userId))
    .orderBy(desc(addresses.isDefault), desc(addresses.createdAt));
}

async function getOwnedAddress(userId: string, addressId: string): Promise<Address> {
  const [row] = await db
    .select()
    .from(addresses)
    .where(and(eq(addresses.id, addressId), eq(addresses.userId, userId)))
    .limit(1);
  if (!row) throw new NotFoundError("Address not found.");
  return row;
}

export async function createAddress(userId: string, input: AddressInput): Promise<AddressDTO> {
  return withTransaction(async (tx) => {
    // First address becomes default automatically; an explicit default
    // clears the previous one in the same transaction.
    const current = await tx.select({ id: addresses.id }).from(addresses).where(eq(addresses.userId, userId));
    const makeDefault = input.isDefault || current.length === 0;

    if (makeDefault) {
      await tx.update(addresses).set({ isDefault: false }).where(eq(addresses.userId, userId));
    }

    const [created] = await tx
      .insert(addresses)
      .values({
        userId,
        fullName: input.fullName,
        phone: input.phone,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2 || null,
        landmark: input.landmark || null,
        city: input.city,
        state: input.state,
        postalCode: input.postalCode,
        country: input.country,
        isDefault: makeDefault,
      })
      .returning();
    return created;
  });
}

export async function updateAddress(userId: string, addressId: string, input: AddressInput): Promise<AddressDTO> {
  await getOwnedAddress(userId, addressId);

  return withTransaction(async (tx) => {
    if (input.isDefault) {
      await tx.update(addresses).set({ isDefault: false }).where(eq(addresses.userId, userId));
    }
    const [updated] = await tx
      .update(addresses)
      .set({
        fullName: input.fullName,
        phone: input.phone,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2 || null,
        landmark: input.landmark || null,
        city: input.city,
        state: input.state,
        postalCode: input.postalCode,
        country: input.country,
        isDefault: input.isDefault,
      })
      .where(and(eq(addresses.id, addressId), eq(addresses.userId, userId)))
      .returning();
    if (!updated) throw new NotFoundError("Address not found.");
    return updated;
  });
}

export async function deleteAddress(userId: string, addressId: string): Promise<void> {
  const owned = await getOwnedAddress(userId, addressId);
  await withTransaction(async (tx) => {
    await tx.delete(addresses).where(and(eq(addresses.id, addressId), eq(addresses.userId, userId)));

    // Default deleted → promote the most recent remaining address.
    if (owned.isDefault) {
      const [next] = await tx
        .select()
        .from(addresses)
        .where(eq(addresses.userId, userId))
        .orderBy(desc(addresses.createdAt))
        .limit(1);
      if (next) {
        await tx.update(addresses).set({ isDefault: true }).where(eq(addresses.id, next.id));
      }
    }
  });
}

export async function setDefaultAddress(userId: string, addressId: string): Promise<AddressDTO> {
  await getOwnedAddress(userId, addressId);
  return withTransaction(async (tx) => {
    await tx.update(addresses).set({ isDefault: false }).where(eq(addresses.userId, userId));
    const [updated] = await tx
      .update(addresses)
      .set({ isDefault: true })
      .where(and(eq(addresses.id, addressId), eq(addresses.userId, userId)))
      .returning();
    if (!updated) throw new NotFoundError("Address not found.");
    return updated;
  });
}
