import "server-only";
import { notFound, redirect } from "next/navigation";
import type { User } from "@/db/schema";
import { canEditCatalog } from "@/lib/catalog-rules";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";
import { getFreshUser } from "@/server/auth/session";

/** Page gate. Support and order managers can open the console, not the catalog editor. */
export async function requireCatalogEditor(): Promise<User> {
  const user = await getFreshUser();
  if (!user) redirect("/login?redirect=/admin/products");
  if (!canEditCatalog(user.role)) notFound();
  return user;
}

export async function requireCatalogEditorApi(): Promise<User> {
  const user = await getFreshUser();
  if (!user) throw new UnauthorizedError();
  if (!canEditCatalog(user.role)) {
    throw new ForbiddenError("You don't have permission to manage the catalog.");
  }
  return user;
}
