import "server-only";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, pool } from "@/db";
import { notifications, users } from "@/db/schema";
import { relativeTime } from "@/lib/relative-time";

/**
 * Notification center service — in-app notifications only.
 * All reads/writes are user-scoped by the session-derived id.
 */

export type NotificationType = (typeof notifications.type.enumValues)[number];

/** Public DTO — never leak internals beyond these fields. */
export interface NotificationDTO {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  linkHref: string | null;
  read: boolean;
  createdAt: Date;
  ago: string;
}

export async function createNotification(
  userId: string,
  input: { type: NotificationType; title: string; message: string; linkHref?: string },
): Promise<void> {
  await db.insert(notifications).values({
    userId,
    type: input.type,
    title: input.title,
    message: input.message,
    linkHref: input.linkHref ?? null,
  });
}

export async function listNotifications(userId: string, limit = 30): Promise<NotificationDTO[]> {
  const rows = await db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(Math.min(limit, 100));

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    message: row.message,
    linkHref: row.linkHref,
    read: row.readAt !== null,
    createdAt: row.createdAt,
    ago: relativeTime(row.createdAt),
  }));
}

export async function unreadCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return Number(row?.n ?? 0);
}

export async function markNotificationRead(userId: string, notificationId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)));
}

export async function markAllNotificationsRead(userId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `UPDATE notifications SET read_at = now()
     WHERE user_id = $1 AND read_at IS NULL
     RETURNING 1`,
    [userId],
  );
  return result.rowCount ?? 0;
}

/** Convenience broadcaster for account-security type alerts. */
export async function securityAlert(userId: string, title: string, message: string): Promise<void> {
  await createNotification(userId, { type: "ACCOUNT", title, message, linkHref: "/account/security" });
}
