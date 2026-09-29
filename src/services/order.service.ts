import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { orderItems, orders, payments, shipments, type Order } from "@/db/schema";
import { NotFoundError } from "@/lib/errors";
import { pageCount, type PageParams } from "@/lib/pagination";

/**
 * Customer-facing order service.
 * HARD RULE: every query is scoped by the session-derived userId.
 * There is intentionally NO path from a request-supplied orderId to data
 * without an ownership check (IDOR-proof by construction).
 */

export interface OrderSummaryDTO {
  id: string;
  orderNumber: string;
  placedAt: Date;
  status: Order["status"];
  paymentStatus: Order["paymentStatus"];
  fulfillmentStatus: Order["fulfillmentStatus"];
  shippingStatus: Order["shippingStatus"];
  totalPaise: number;
  currency: string;
  itemsCount: number;
  previewName: string | null;
}

export interface OrderDetailDTO extends OrderSummaryDTO {
  subtotalPaise: number;
  discountPaise: number;
  shippingPaise: number;
  taxPaise: number;
  couponCode: string | null;
  cancelReason: string | null;
  paidAt: Date | null;
  customerNotes: string | null;
  shippingAddress: {
    fullName: string;
    phone: string;
    line1: string;
    line2: string | null;
    landmark: string | null;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
  items: {
    id: string;
    productName: string;
    variantName: string;
    sku: string;
    quantity: number;
    unitPricePaise: number;
    discountPaise: number;
    totalPaise: number;
  }[];
  payment: {
    provider: string;
    method: string | null;
    status: string;
    paidAt: Date | null;
  } | null;
  shipments: {
    id: string;
    carrier: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    status: string;
    estimatedDeliveryAt: Date | null;
    shippedAt: Date | null;
    deliveredAt: Date | null;
  }[];
}

function toSummary(order: Order, itemsCount: number, previewName: string | null): OrderSummaryDTO {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    placedAt: order.createdAt,
    status: order.status,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    shippingStatus: order.shippingStatus,
    totalPaise: order.totalAmount,
    currency: order.currency,
    itemsCount,
    previewName,
  };
}

export async function listCustomerOrders(
  userId: string,
  page: PageParams,
): Promise<{ orders: OrderSummaryDTO[]; total: number; pages: number }> {
  const [{ n: total }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(eq(orders.userId, userId));

  const rows = await db
    .select({ order: orders, itemsCount: sql<number>`count(${orderItems.id})::int` })
    .from(orders)
    .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(eq(orders.userId, userId))
    .groupBy(orders.id)
    .orderBy(desc(orders.createdAt))
    .limit(page.pageSize)
    .offset(page.offset);

  const previews = rows.length
    ? await db
        .select({ orderId: orderItems.orderId, name: orderItems.productName })
        .from(orderItems)
        .where(
          sql`${orderItems.orderId} IN (${sql.join(rows.map((r) => sql`${r.order.id}`), sql`, `)})`,
        )
        .groupBy(orderItems.orderId, orderItems.productName)
    : [];

  const previewByOrder = new Map<string, string>(previews.map((p) => [p.orderId, p.name]));

  return {
    orders: rows.map((row) =>
      toSummary(row.order, Number(row.itemsCount), previewByOrder.get(row.order.id) ?? null),
    ),
    total: Number(total),
    pages: pageCount(Number(total), page.pageSize),
  };
}

/** Ownership-checked detail fetch. Throws NotFound for foreign orders. */
export async function getCustomerOrder(userId: string, orderId: string): Promise<OrderDetailDTO> {
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.userId, userId)))
    .limit(1);
  if (!order) throw new NotFoundError("Order not found.");

  const [items, [payment], orderShipments, [{ n: itemsCount }]] = await Promise.all([
    db.select().from(orderItems).where(eq(orderItems.orderId, order.id)),
    db.select().from(payments).where(eq(payments.orderId, order.id)).orderBy(desc(payments.createdAt)).limit(1),
    db.select().from(shipments).where(eq(shipments.orderId, order.id)).orderBy(desc(shipments.createdAt)),
    db.select({ n: sql<number>`count(*)::int` }).from(orderItems).where(eq(orderItems.orderId, order.id)),
  ]);

  return {
    ...toSummary(order, Number(itemsCount), items[0]?.productName ?? null),
    subtotalPaise: order.subtotalAmount,
    discountPaise: order.discountAmount,
    shippingPaise: order.shippingAmount,
    taxPaise: order.taxAmount,
    couponCode: order.couponCode,
    cancelReason: order.cancelReason,
    paidAt: order.paidAt,
    customerNotes: order.customerNotes,
    shippingAddress: {
      fullName: order.shippingFullName,
      phone: order.shippingPhone,
      line1: order.shippingLine1,
      line2: order.shippingLine2,
      landmark: order.shippingLandmark,
      city: order.shippingCity,
      state: order.shippingState,
      postalCode: order.shippingPostalCode,
      country: order.shippingCountry,
    },
    items: items.map((item) => ({
      id: item.id,
      productName: item.productName,
      variantName: item.variantName,
      sku: item.sku,
      quantity: item.quantity,
      unitPricePaise: item.unitPrice,
      discountPaise: item.discountAmount,
      totalPaise: item.totalPrice,
    })),
    payment: payment
      ? {
          provider: payment.provider,
          method: payment.method,
          status: payment.status,
          paidAt: payment.paidAt,
        }
      : null,
    shipments: orderShipments.map((shipment) => ({
      id: shipment.id,
      carrier: shipment.carrier,
      trackingNumber: shipment.trackingNumber,
      trackingUrl: shipment.trackingUrl,
      status: shipment.status,
      estimatedDeliveryAt: shipment.estimatedDeliveryAt,
      shippedAt: shipment.shippedAt,
      deliveredAt: shipment.deliveredAt,
    })),
  };
}
