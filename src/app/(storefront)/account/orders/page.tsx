import Link from "next/link";
import { redirect } from "next/navigation";
import { AccountShell } from "@/components/layouts/account-shell";
import { EmptyOrders } from "@/components/ui/empty-state";
import { Price } from "@/components/ui/price";
import { StatusBadge, Badge } from "@/components/ui/badge";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { loadAccountContext } from "@/server/account-context";
import { listCustomerOrders } from "@/services/order.service";
import { parsePage } from "@/lib/pagination";
import { formatDate } from "@/lib/format";

const payBadgeVariant = {
  PAID: "delivered",
  PENDING: "processing",
  AUTHORIZED: "processing",
  FAILED: "cancelled",
  CANCELLED: "cancelled",
  REFUNDED: "cancelled",
  PARTIALLY_REFUNDED: "shipped",
} as const;

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const context = await loadAccountContext();
  if (!context) redirect("/login");

  const params = await searchParams;
  const page = parsePage(params.page, 10);
  const { orders: orderRows, total, pages } = await listCustomerOrders(context.user.id, page);

  return (
    <AccountShell
      title="Orders"
      description={`${total} ${total === 1 ? "order" : "orders"} — print, production and shipping status live here.`}
      active="orders"
      identity={context.identity}
      unreadNotifications={context.unreadNotifications}
    >
      {orderRows.length === 0 ? (
        <EmptyOrders />
      ) : (
        <>
          <ul className="space-y-3" aria-label="Order history">
            {orderRows.map((order) => (
              <li key={order.id}>
                <Link
                  href={`/account/orders/${order.id}`}
                  className="block rounded-card border-[1.5px] border-clay bg-cream p-4 transition-colors hover:border-ink sm:p-5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-sm font-semibold">{order.orderNumber}</p>
                      <p className="mt-1 truncate text-xs text-smoke">
                        Placed {formatDate(order.placedAt)} · {order.itemsCount}{" "}
                        {order.itemsCount === 1 ? "item" : "items"}
                        {order.previewName ? ` · ${order.previewName}` : ""}
                      </p>
                    </div>
                    <Price amount={order.totalPaise} size="md" className="font-semibold" />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <StatusBadge status={order.status === "COMPLETED" ? "delivered" : "processing"} />
                    <Badge variant={payBadgeVariant[order.paymentStatus] ?? "soft"}>
                      Payment: {order.paymentStatus.replace(/_/g, " ").toLowerCase()}
                    </Badge>
                    <Badge variant="soft">
                      Fulfillment: {order.fulfillmentStatus.replace(/_/g, " ").toLowerCase()}
                    </Badge>
                    {order.shippingStatus !== "NOT_SHIPPED" ? (
                      <Badge variant="shipped">
                        {order.shippingStatus.replace(/_/g, " ").toLowerCase()}
                      </Badge>
                    ) : null}
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          {pages > 1 ? (
            <Pagination aria-label="Order pages" className="mt-8">
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    href={`/account/orders?page=${page.page - 1}`}
                    aria-disabled={page.page === 1}
                    className={page.page === 1 ? "pointer-events-none opacity-40" : undefined}
                  />
                </PaginationItem>
                {Array.from({ length: pages }, (_, i) => (
                  <PaginationItem key={i}>
                    <PaginationLink href={`/account/orders?page=${i + 1}`} isActive={page.page === i + 1}>
                      {i + 1}
                    </PaginationLink>
                  </PaginationItem>
                ))}
                <PaginationItem>
                  <PaginationNext
                    href={`/account/orders?page=${page.page + 1}`}
                    aria-disabled={page.page === pages}
                    className={page.page === pages ? "pointer-events-none opacity-40" : undefined}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          ) : null}
        </>
      )}
    </AccountShell>
  );
}
