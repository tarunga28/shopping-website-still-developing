import "server-only";
import { cache } from "react";
import { getFreshUser } from "@/server/auth/session";
import { unreadCount } from "@/services/notification.service";
import type { User } from "@/db/schema";
import type { AccountIdentity } from "@/components/layouts/account-shell";

/**
 * Shared per-request account context: fresh DB user + identity card data
 * + unread notification count. Wrapped in React cache so a page and its
 * AccountShell pay for one round of queries, not two.
 */

export interface AccountContext {
  user: User;
  identity: AccountIdentity;
  unreadNotifications: number;
}

export const loadAccountContext = cache(async (): Promise<AccountContext | null> => {
  const user = await getFreshUser();
  if (!user) return null;
  const unread = await unreadCount(user.id);
  return {
    user,
    identity: { name: user.name, email: user.email, avatarUrl: user.avatarUrl },
    unreadNotifications: unread,
  };
});
