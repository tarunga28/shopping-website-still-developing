import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, ExternalLink, MapPin, Package } from "lucide-react";
import { AccountShell } from "@/components/layouts/account-shell";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { Price } from "@/components/ui/price";
import { loadAccountContext } from "@/server/account-context";
import { getCustomerOrder } from "@/services/order.service";
import { formatDate } from "@/lib/format";
import { NotFoundError } from "@/lib/errors";

/**
 * Order detail — ownership is enforced in getCustomerOrder():
 * the query carries BOTH order id and the session user id, so another
 * customer's order id simply resolves as not-found.
 */
export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const context = await loadAccountContext();
  if (!context) redirect("/login");

  const { orderId } = await params;

  let order;
  try {
    order = await getCustomerOrder(context.user.id, orderId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  return (
    <AccountShell
      title={order.orderNumber}
      description={`Placed ${formatDate(order.placedAt)}`}
      active="orders"
      identity={context.identity}
      unreadNotifications={context.unreadNotifications}
    >
      <Breadcrumbs
        className="mb-6"
        items={[
          { label: "Account", href: "/account" },
          { label: "Orders", href: "/account/orders" },
          { label: order.orderNumber },
        ]}
      />

      {/* Status rail */}
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={order.status === "COMPLETED" ? "delivered" : "processing"} />
        <Badge variant="soft">Payment: {order.paymentStatus.replace(/_/g, " ").toLowerCase()}</Badge>
        <Badge variant="soft">Fulfillment: {order.fulfillmentStatus.replace(/_/g, " ").toLowerCase()}</Badge>
        {order.shippingStatus !== "NOT_SHIPPED" ? (
          <Badge variant="shipped">{order.shippingStatus.replace(/_/g, " ").toLowerCase()}</Badge>
        ) : null}
        {order.couponCode ? <Badge variant="new">{order.couponCode}</Badge> : null}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_20rem]">
        {/* Items */}
        <section aria-labelledby="items-heading" className="rounded-card border-[1.5px] border-clay bg-cream p-5 sm:p-6">
          <h2 id="items-heading" className="font-display text-base font-bold uppercase tracking-tight">
            Items
          </h2>
          <ul className="mt-4 divide-y divide-clay/70">
            {order.items.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="flex items-start gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-clay bg-sand" aria-hidden>
                    <Package className="size-4 text-smoke" />
                  </span>
                  <div>
                    <p className="text-sm font-semibold">{item.productName}</p>
                    <p className="mt-0.5 text-xs text-smoke">
                      {item.variantName} · SKU {item.sku} · Qty {item.quantity}
                    </p>
                    <p className="mt-1 font-mono text-[10px] text-smoke">
                      {item.discountPaise > 0 ? "Includes item discount" : ""}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <Price amount={item.unitPricePaise} size="sm" />
                  <p className="mt-0.5 font-mono text-xs font-semibold">
                    × {item.quantity} = <Price amount={item.totalPaise} size="sm" />
                  </p>
                </div>
              </li>
            ))}
          </ul>

          {/* Totals */}
          <dl className="mt-5 space-y-2 border-t-[1.5px] border-ink pt-4 text-sm">
            <div className="flex justify-between">
              <dt className="text-smoke">Subtotal</dt>
              <dd><Price amount={order.subtotalPaise} size="sm" /></dd>
            </div>
            {order.discountPaise > 0 ? (
              <div className="flex justify-between text-success">
                <dt>Discount{order.couponCode ? ` (${order.couponCode})` : ""}</dt>
                <dd>−<Price amount={order.discountPaise} size="sm" /></dd>
              </div>
            ) : null}
            <div className="flex justify-between">
              <dt className="text-smoke">Shipping</dt>
              <dd>{order.shippingPaise === 0 ? "Free" : <Price amount={order.shippingPaise} size="sm" />}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-smoke">Tax (GST incl.)</dt>
              <dd><Price amount={order.taxPaise} size="sm" /></dd>
            </div>
            <div className="flex justify-between border-t border-clay pt-2.5 text-base font-bold">
              <dt>Total</dt>
              <dd><Price amount={order.totalPaise} size="lg" /></dd>
            </div>
          </dl>
        </section>

        <div className="space-y-6">
          {/* Shipping address snapshot */}
          <section aria-labelledby="ship-to" className="rounded-card border-[1.5px] border-clay bg-cream p-5">
            <h2 id="ship-to" className="flex items-center gap-2 font-display text-sm font-bold uppercase tracking-tight">
              <MapPin className="size-4 text-flame" aria-hidden /> Ship to
            </h2>
            <address className="mt-3 text-sm not-italic leading-relaxed text-ink/80">
              <strong className="block">{order.shippingAddress.fullName}</strong>
              {order.shippingAddress.line1}
              {order.shippingAddress.line2 ? <>, {order.shippingAddress.line2}</> : null}
              <br />
              {order.shippingAddress.city}, {order.shippingAddress.state} — {order.shippingAddress.postalCode}
              <br />
              {order.shippingAddress.country} · {order.shippingAddress.phone}
            </address>
          </section>

          {/* Payment */}
          <section aria-labelledby="payment-heading" className="rounded-card border-[1.5px] border-clay bg-cream p-5">
            <h2 id="payment-heading" className="font-display text-sm font-bold uppercase tracking-tight">Payment</h2>
            {order.payment ? (
              <dl className="mt-3 space-y-1.5 text-sm">
                <div className="flex justify-between"><dt className="text-smoke">Provider</dt><dd className="capitalize">{order.payment.provider}</dd></div>
                <div className="flex justify-between"><dt className="text-smoke">Method</dt><dd className="capitalize">{order.payment.method ?? "—"}</dd></div>
                <div className="flex justify-between"><dt className="text-smoke">Status</dt><dd>{order.payment.status.toLowerCase()}</dd></div>
                {order.payment.paidAt ? (
                  <div className="flex justify-between"><dt className="text-smoke">Paid on</dt><dd>{formatDate(order.payment.paidAt)}</dd></div>
                ) : null}
              </dl>
            ) : (
              <p className="mt-3 text-xs text-smoke">Payment details appear once the payment is captured.</p>
            )}
          </section>

          {/* Tracking */}
          <section aria-labelledby="tracking-heading" className="rounded-card border-[1.5px] border-clay bg-cream p-5">
            <h2 id="tracking-heading" className="font-display text-sm font-bold uppercase tracking-tight">Tracking</h2>
            {order.shipments.length === 0 ? (
              <p className="mt-3 text-xs leading-relaxed text-smoke">
                This order hasn&apos;t shipped yet. Tracking links appear here the moment it leaves our print floor.
              </p>
            ) : (
              <ul className="mt-3 space-y-3">
                {order.shipments.map((shipment) => (
                  <li key={shipment.id} className="text-sm">
                    <p className="font-semibold capitalize">{shipment.carrier ?? "Courier"}</p>
                    <p className="mt-0.5 font-mono text-xs text-smoke">{shipment.trackingNumber ?? "—"}</p>
                    {shipment.trackingUrl ? (
                      <a href={shipment.trackingUrl} target="_blank" rel="noopener noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold text-flame hover:underline">
                        Track package <ExternalLink className="size-3" aria-hidden />
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      <Link href="/account/orders" className="mt-8 inline-flex items-center gap-2 text-xs font-semibold text-smoke hover:text-ink">
        <ArrowLeft className="size-3.5" aria-hidden /> Back to all orders
      </Link>
    </AccountShell>
  );
}
