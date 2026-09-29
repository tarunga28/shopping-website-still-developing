import { sql } from "drizzle-orm";
import Link from "next/link";
import { BarChart3, Package, ShoppingCart, Ticket, Users } from "lucide-react";
import { AdminShell } from "@/components/layouts/admin-shell";
import { StatCard } from "@/components/cards/stat-card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { db } from "@/db";
import { orders, products, supportTickets, users } from "@/db/schema";
import { getFreshUser } from "@/server/auth/session";
import { logoutAction } from "@/server/actions/auth-actions";

export const dynamic = "force-dynamic";

async function count(table: Parameters<typeof db.execute>[0] extends infer T ? T : never): Promise<number> {
  const result = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${table}`);
  return Number(result.rows[0]?.n ?? 0);
}

/** Admin landing — live counts only; management UIs arrive per milestone. */
export default async function AdminDashboardPage() {
  const admin = await getFreshUser();
  const [productCount, orderCount, customerCount, ticketCount] = await Promise.all([
    count(products),
    count(orders),
    count(users),
    count(supportTickets),
  ]);

  return (
    <AdminShell>
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Badge variant="new">Foundation live</Badge>
          <h1 className="mt-3 font-display text-3xl font-extrabold uppercase tracking-tight sm:text-4xl">
            Console<span className="text-flame">.</span>
          </h1>
          <p className="mt-2 text-sm text-smoke">
            Signed in as <span className="font-semibold text-ink">{admin?.email}</span> · role{" "}
            <span className="font-mono text-xs font-semibold">{admin?.role}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link href="/admin/products">Manage products</Link>
          </Button>
          <form action={logoutAction}>
            <Button variant="outline" size="sm" type="submit">
              Sign out
            </Button>
          </form>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Products" value={String(productCount)} icon={Package} hint="Open catalog management" />
        <StatCard label="Orders" value={String(orderCount)} icon={ShoppingCart} hint="Checkout opens at launch" />
        <StatCard label="Registered accounts" value={String(customerCount)} icon={Users} hint="Customers + staff" />
        <StatCard label="Support tickets" value={String(ticketCount)} icon={Ticket} hint="Support module pending" />
      </div>

      <section className="mt-10 rounded-card border-[1.5px] border-clay bg-cream p-6">
        <h2 className="flex items-center gap-2 font-display text-lg font-bold uppercase tracking-tight">
          <BarChart3 className="size-5 text-flame" aria-hidden />
          What lands here next
        </h2>
        <div className="mt-4 grid grid-cols-1 gap-3 text-sm text-smoke sm:grid-cols-2">
          {[
            "Order queue with POD fulfillment status",
            "Customer directory with lifecycle actions",
            "Coupon, review and support-ticket operations",
            "A connected print supplier",
          ].map((item) => (
            <p key={item} className="flex items-start gap-2">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-flame" aria-hidden />
              {item}
            </p>
          ))}
        </div>
      </section>
    </AdminShell>
  );
}
