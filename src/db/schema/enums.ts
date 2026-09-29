import { pgEnum } from "drizzle-orm/pg-core";

/**
 * All PostgreSQL enums for the platform, centralized.
 * Status systems are deliberately separated (order vs payment vs
 * fulfillment vs shipping) because each transitions independently.
 */

/* ── Users ────────────────────────────────────────────────────────────── */
export const userRoleEnum = pgEnum("user_role", [
  "CUSTOMER",
  "SUPPORT",
  "ORDER_MANAGER",
  "PRODUCT_MANAGER",
  "ADMIN",
  "SUPER_ADMIN",
]);

export const userStatusEnum = pgEnum("user_status", ["ACTIVE", "SUSPENDED", "DEACTIVATED"]);

/* ── Catalog ──────────────────────────────────────────────────────────── */
export const productStatusEnum = pgEnum("product_status", [
  "DRAFT",
  "ACTIVE",
  "ARCHIVED",
  "DISCONTINUED",
]);

export const collectionStatusEnum = pgEnum("collection_status", ["DRAFT", "ACTIVE", "ARCHIVED"]);

export const productTypeEnum = pgEnum("product_type", [
  "T_SHIRT",
  "HOODIE",
  "SWEATSHIRT",
  "MUG",
  "POSTER",
  "PHONE_CASE",
  "TOTE_BAG",
  "CUSTOM",
  "OTHER",
]);

export const designStatusEnum = pgEnum("design_status", [
  "DRAFT",
  "PUBLISHED",
  "ARCHIVED",
  "REJECTED",
]);

export const copyrightStatusEnum = pgEnum("copyright_status", [
  "ORIGINAL",
  "LICENSED",
  "PENDING_REVIEW",
  "RESTRICTED",
]);

export const designPlacementEnum = pgEnum("design_placement", [
  "FRONT",
  "BACK",
  "LEFT_SLEEVE",
  "RIGHT_SLEEVE",
  "CENTER",
  "OTHER",
]);

export const availabilityStatusEnum = pgEnum("availability_status", [
  "IN_STOCK",
  "LOW_STOCK",
  "OUT_OF_STOCK",
  "PREORDER",
]);

export const imageTypeEnum = pgEnum("image_type", [
  "PRODUCT",
  "DESIGN",
  "CATEGORY",
  "COLLECTION",
  "USER",
  "REVIEW",
  "BANNER",
]);

export const imageRoleEnum = pgEnum("image_role", [
  "PRIMARY",
  "GALLERY",
  "HOVER",
  "THUMBNAIL",
  "MOBILE",
  "SOCIAL",
]);

/* ── Commerce ─────────────────────────────────────────────────────────── */
export const cartStatusEnum = pgEnum("cart_status", [
  "ACTIVE",
  "CONVERTED",
  "ABANDONED",
  "EXPIRED",
]);

/* ── Orders (four independent status systems) ─────────────────────────── */
export const orderStatusEnum = pgEnum("order_status", [
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "COMPLETED",
  "CANCELLED",
  "ON_HOLD",
]);

export const paymentStatusEnum = pgEnum("payment_status", [
  "PENDING",
  "AUTHORIZED",
  "PAID",
  "FAILED",
  "CANCELLED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
]);

export const fulfillmentStatusEnum = pgEnum("fulfillment_status", [
  "UNFULFILLED",
  "IN_PRODUCTION",
  "PARTIALLY_FULFILLED",
  "FULFILLED",
  "CANCELLED",
]);

export const shipmentStatusEnum = pgEnum("shipment_status", [
  "NOT_SHIPPED",
  "LABEL_CREATED",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "FAILED",
  "RETURNED",
]);

export const refundStatusEnum = pgEnum("refund_status", [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

/* ── POD ──────────────────────────────────────────────────────────────── */
export const podProviderStatusEnum = pgEnum("pod_provider_status", ["ACTIVE", "DISABLED", "TESTING"]);

export const podOrderStatusEnum = pgEnum("pod_order_status", [
  "DRAFT",
  "SUBMITTED",
  "ACCEPTED",
  "IN_PRODUCTION",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
  "FAILED",
]);

export const podEventTypeEnum = pgEnum("pod_event_type", [
  "ORDER_SUBMITTED",
  "ORDER_ACCEPTED",
  "IN_PRODUCTION",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
  "FAILED",
  "OTHER",
]);

/* ── Marketing & engagement ───────────────────────────────────────────── */
export const couponTypeEnum = pgEnum("coupon_type", ["PERCENTAGE", "FIXED_AMOUNT", "FREE_SHIPPING"]);

export const reviewStatusEnum = pgEnum("review_status", ["PENDING", "APPROVED", "REJECTED", "HIDDEN"]);

export const notificationTypeEnum = pgEnum("notification_type", [
  "ORDER",
  "PAYMENT",
  "SHIPPING",
  "ACCOUNT",
  "PROMOTION",
  "SYSTEM",
]);

/* ── Support ──────────────────────────────────────────────────────────── */
export const ticketStatusEnum = pgEnum("ticket_status", [
  "OPEN",
  "IN_PROGRESS",
  "WAITING_FOR_CUSTOMER",
  "RESOLVED",
  "CLOSED",
]);

export const ticketPriorityEnum = pgEnum("ticket_priority", ["LOW", "NORMAL", "HIGH", "URGENT"]);

/* ── Analytics ────────────────────────────────────────────────────────── */
export const analyticsEventTypeEnum = pgEnum("analytics_event_type", [
  "PRODUCT_VIEW",
  "SEARCH",
  "ADD_TO_CART",
  "REMOVE_FROM_CART",
  "CHECKOUT_STARTED",
  "PURCHASE",
  "WISHLIST_ADD",
]);
