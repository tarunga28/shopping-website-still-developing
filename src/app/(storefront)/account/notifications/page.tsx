import { redirect } from "next/navigation";
import { BellRing, Shield } from "lucide-react";
import { AccountShell } from "@/components/layouts/account-shell";
import { MarkAllReadButton, MarkReadButton } from "@/components/account/notification-actions";
import { EmptyNotifications } from "@/components/ui/empty-state";
import { loadAccountContext } from "@/server/account-context";
import { listNotifications } from "@/services/notification.service";
import { cn } from "@/lib/utils";

export default async function NotificationsPage() {
  const context = await loadAccountContext();
  if (!context) redirect("/login");

  const notifications = await listNotifications(context.user.id, 30);

  return (
    <AccountShell
      title="Notifications"
      description="Order, payment, shipping and account alerts."
      active="notifications"
      identity={context.identity}
      unreadNotifications={context.unreadNotifications}
    >
      {notifications.length > 0 ? (
        <div className="mb-5 flex items-center justify-between">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">
            {context.unreadNotifications} unread · showing latest {notifications.length}
          </p>
          <MarkAllReadButton disabled={context.unreadNotifications === 0} />
        </div>
      ) : null}

      {notifications.length === 0 ? (
        <EmptyNotifications />
      ) : (
        <ul className="space-y-3" aria-label="Notifications">
          {notifications.map((notification) => {
            const important = notification.type === "ACCOUNT" || notification.type === "PAYMENT";
            return (
              <li
                key={notification.id}
                className={cn(
                  "flex items-start gap-4 rounded-card border-[1.5px] p-4 transition-colors sm:p-5",
                  notification.read ? "border-clay bg-cream/50" : "border-ink bg-cream",
                )}
              >
                <span
                  aria-label={notification.read ? "Read" : "Unread"}
                  className={cn(
                    "mt-1.5 size-2.5 shrink-0 rounded-full",
                    notification.read ? "bg-clay" : "bg-flame",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {important ? <Shield className="size-3.5 text-flame" aria-hidden /> : <BellRing className="size-3.5 text-smoke" aria-hidden />}
                    <p className={cn("text-sm", notification.read ? "font-medium text-ink/70" : "font-semibold")}>
                      {notification.title}
                    </p>
                    {!notification.read ? (
                      <span className="rounded-pill bg-flame px-1.5 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-widest text-on-accent">
                        New
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-smoke">{notification.message}</p>
                  <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-smoke/70">
                    {notification.ago}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  {notification.linkHref ? (
                    <a
                      href={notification.linkHref}
                      className="text-xs font-semibold underline decoration-flame decoration-2 underline-offset-4 hover:text-flame"
                    >
                      View
                    </a>
                  ) : null}
                  {!notification.read ? <MarkReadButton notificationId={notification.id} /> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </AccountShell>
  );
}
