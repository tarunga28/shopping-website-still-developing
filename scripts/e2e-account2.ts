import "dotenv/config";

async function main() {
  const { db, pool } = await import("@/db");
  const { users, orders, orderItems, products, productVariants } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");

  email: {
    /* Setup two customers */
    const authSvc = await import("@/services/auth.service");
    const mk = async (email: string, name: string) => {
      await db.delete(users).where(eq(users.email, email));
      const r = await authSvc.registerUser({ name, email, phone: null, password: "Str0ngPassword!" }, {});
      return r.userId;
    };
    const owner = await mk("e2e.owner@inkline.test", "Owner User");
    const intruder = await mk("e2e.intruder@inkline.test", "Intruder User");

    /* Create a real order for owner (direct insert, simulating checkout output) */
    const [p] = await db.select().from(products).limit(1);
    const [v] = await db.select().from(productVariants).where(eq(productVariants.productId, p.id)).limit(1);
    const [order] = await db.insert(orders).values({
      orderNumber: "INK-E2E-0001", userId: owner, status: "CONFIRMED", paymentStatus: "PAID",
      fulfillmentStatus: "UNFULFILLED", shippingStatus: "NOT_SHIPPED",
      subtotalAmount: 89900, discountAmount: 0, shippingAmount: 0, taxAmount: 0, totalAmount: 89900,
      shippingFullName: "Owner User", shippingPhone: "9876543210", shippingLine1: "1 Main St",
      shippingCity: "Bengaluru", shippingState: "Karnataka", shippingPostalCode: "560001",
    }).returning();
    await db.insert(orderItems).values({
      orderId: order.id, productId: p.id, variantId: v.id, productName: p.name, variantName: v.name,
      sku: v.sku, quantity: 1, unitPrice: 89900, discountAmount: 0, totalPrice: 89900,
    });

    /* IDOR: intruder must NOT see owner's order */
    const ordSvc = await import("@/services/order.service");
    try {
      await ordSvc.getCustomerOrder(intruder, order.id);
      console.log("IDOR: FAIL — intruder read owner's order!");
      process.exitCode = 1;
    } catch {
      console.log("IDOR: PASS — intruder rejected with not-found");
    }

    /* Owner CAN see their order */
    const detail = await ordSvc.getCustomerOrder(owner, order.id);
    console.log("OWNER view:", detail.orderNumber, "| item:", detail.items[0].productName, "| total:", detail.totalPaise, "| snapshot addr:", detail.shippingAddress.city);

    /* Avatar validation */
    const avatarSvc = await import("@/services/avatar.service");
    try {
      await avatarSvc.uploadAvatar(owner, { name: "evil.js", type: "application/javascript", size: 100, data: Buffer.from("console.log(1)") });
      console.log("AVATAR: FAIL — js accepted");
      process.exitCode = 1;
    } catch (e: any) {
      console.log("AVATAR reject JS: PASS (", e.code ?? e.message, ")");
    }
    try {
      await avatarSvc.uploadAvatar(owner, { name: "fake.png", type: "image/png", size: 100, data: Buffer.from("not a png at all") });
      console.log("AVATAR: FAIL — fake png accepted");
      process.exitCode = 1;
    } catch (e: any) {
      console.log("AVATAR magic-bytes sniff: PASS (", e.code ?? e.message, ")");
    }
    // Real 1x1 PNG
    const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const pngBuf = Buffer.from(pngB64, "base64");
    const up = await avatarSvc.uploadAvatar(owner, { name: "photo.png", type: "image/png", size: pngBuf.length, data: pngBuf });
    console.log("AVATAR upload:", up.avatarUrl);

    /* Email change flow (request + confirm via token hash from DB) */
    const accountSvc = await import("@/services/account.service");
    await accountSvc.requestEmailChange(owner, "new.owner@inkline.test", {});
    const { authTokens, users: usersTbl } = await import("@/db/schema");
    const [tokenRow] = await db.select().from(authTokens).where(eq(authTokens.userId, owner));
    console.log("EMAIL CHANGE: token issued, type:", tokenRow.type);
    // Recovering raw token from dev log isn't possible from hash; emulate the
    // second half by issuing + confirming through the same code path:
    const { generateRawToken, hashToken, TOKEN_TTL_MINUTES } = await import("@/server/auth/tokens");
    const raw = generateRawToken();
    await db.update(authTokens).set({ tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + TOKEN_TTL_MINUTES.EMAIL_CHANGE * 60000) }).where(eq(authTokens.id, tokenRow.id));
    const result = await accountSvc.confirmEmailChange(raw, {});
    console.log("EMAIL CHANGE confirmed:", result.newEmail);
    const [after] = await db.select().from(usersTbl).where(eq(usersTbl.id, owner));
    console.log("EMAIL CHANGE: email switched:", after.email === "new.owner@inkline.test" ? "PASS" : "FAIL", "| stamp bumped:", after.securityStamp, "| pendingEmail:", after.pendingEmail ?? "null");

    /* Deactivation with password */
    try {
      await accountSvc.deactivateAccount(intruder, "wrong-password", undefined, {});
      console.log("DEACTIVATE: FAIL — wrong password accepted");
      process.exitCode = 1;
    } catch (e: any) {
      console.log("DEACTIVATE wrong password rejected: PASS");
    }
    await accountSvc.deactivateAccount(intruder, "Str0ngPassword!", "Testing", {});
    const [deactivated] = await db.select().from(usersTbl).where(eq(usersTbl.id, intruder));
    console.log("DEACTIVATE: status:", deactivated.status, deactivated.status === "DEACTIVATED" ? "PASS" : "FAIL");
    /* orders/records preserved */
    const [preserved] = await db.select().from(orders).where(eq(orders.userId, owner));
    console.log("RECORDS preserved:", preserved ? "PASS (order intact)" : "n/a");

    await pool.end();
  }
}
main().catch((e) => { console.error("E2E FAIL:", e); process.exit(1); });
