import { Bell, Heart, MapPin, Package } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { addresses } from "@/db/schema";
import { AccountShell } from "@/components/layouts/account-shell";
import { StatusBadge } from "@/components/ui/badge";
import { EmptyOrders } from "@/components/ui/empty-state";
import { Price } from "@/components/ui/price";
import { loadAccountContext } from "@/server/account-context";
import { listCustomerOrders } from "@/services/order.service";
import { wishlistCount } from "@/services/wishlist.service";
import { parsePage } from "@/lib/pagination";
import { formatDate } from "@/lib/format";
import { relativeTime } from "@/lib/relative-time";

/** Account overview — every number on this page comes from the database. */
export default async function AccountOverviewPage() {
  const context = await loadAccountContext();
  if (!context) redirect("/login");

  const { user, identity, unreadNotifications } = context;

  const [wishlist, [addressCount], orderData] = await Promise.all([
    wishlistCount(user.id),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(addresses)
      .where(eq(addresses.userId, user.id)),
    listCustomerOrders(user.id, parsePage("1", 3)),
  ]);

  const ordersList = orderData.orders;

  return (
    <AccountShell
      title={`Hey, ${user.name.split(" ")[0]}`}
      description="Your Inkline account at a glance."
      active="overview"
      identity={identity}
      unreadNotifications={unreadNotifications}
    >
      {/* Stats — real counts */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          { label: "Orders", value: String(orderData.total), icon: Package, hint: "All time" },
          { label: "Wishlist items", value: String(wishlist), icon: Heart, hint: "Saved designs" },
          { label: "Saved addresses", value: String(addressCount.n), icon: MapPin, hint: "Faster checkout" },
          { label: "Unread alerts", value: String(unreadNotifications), icon: Bell, hint: "Notification center" },
        ].map((stat) => (
          <div key={stat.label} className="rounded-card border-[1.5px] border-clay bg-cream p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-smoke">{stat.label}</p>
              <stat.icon className="size-4 text-smoke" aria-hidden />
            </div>
            <p className="mt-2.5 font-display text-3xl font-extrabold tracking-tight">{stat.value}</p>
            <p className="mt-1 text-[11px] text-smoke">{stat.hint}</p>
          </div>
        ))}
      </div>

      {/* Verification banner */}
      {!user.emailVerifiedAt ? (
        <div className="mt-6 rounded-card border-[1.5px] border-warning/50 bg-warning/10 p-5">
          <p className="text-sm font-semibold text-ink">Verify your email to protect your account</p>
          <p className="mt-1 text-xs leading-relaxed text-smoke">
            We sent you a verification link after registration. Resend it from{" "}
            <a href="/verify-email" className="font-semibold text-ink underline decoration-flame decoration-2 underline-offset-2 hover:text-flame">
              the verification page
            </a>
            .
          </p>
        </div>
      ) : null}

      {/* Recent orders */}
      <section className="mt-8" aria-labelledby="recent-orders">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="recent-orders" className="font-display text-lg font-bold uppercase tracking-tight">
            Recent orders
          </h2>
          <Link href="/account/orders" className="text-xs font-semibold underline decoration-flame decoration-2 underline-offset-4 hover:text-flame">
            View all
          </Link>
        </div>

        {ordersList.length === 0 ? (
          <EmptyOrders />
        ) : (
          <ul className="space-y-3">
            {ordersList.map((order) => (
              <li key={order.id}>
                <Link
                  href={`/account/orders/${order.id}`}
                  className="flex flex-wrap items-center gap-3 rounded-card border-[1.5px] border-clay bg-cream p-4 transition-colors hover:border-ink sm:flex-nowrap sm:gap-4"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-xs font-semibold">{order.orderNumber}</p>
                    <p className="mt-0.5 truncate text-xs text-smoke">
                      {order.previewName ?? "Order"}
                      {order.itemsCount > 1 ? ` + ${order.itemsCount - 1} more` : ""} · {relativeTime(order.placedAt)}
                    </p>
                  </div>
                  <StatusBadge status={order.status === "COMPLETED" ? "delivered" : "processing"} />
                  <Price amount={order.totalPaise} size="md" className="font-semibold" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-8 font-mono text-[10px] uppercase tracking-[0.18em] text-smoke/60">
        Member since {formatDate(user.createdAt)} · {user.emailVerifiedAt ? "Email verified" : "Email unverified"}
      </p>
    </AccountShell>
  );
}
