import "dotenv/config";
async function main() {
  const { db, pool } = await import("@/db");
  const { users, authTokens } = await import("@/db/schema");
  const { and, eq, desc } = await import("drizzle-orm");
  const accountSvc = await import("@/services/account.service");
  const { generateRawToken, hashToken, TOKEN_TTL_MINUTES } = await import("@/server/auth/tokens");

  const [user] = await db.select().from(users).where(eq(users.email, "e2e.owner@inkline.test"));
  // Simulate the full second half correctly: query EMAIL_CHANGE token properly
  const [tokenRow] = await db.select().from(authTokens)
    .where(and(eq(authTokens.userId, user.id), eq(authTokens.type, "EMAIL_CHANGE")))
    .orderBy(desc(authTokens.createdAt)).limit(1);
  console.log("EMAIL_CHANGE token found:", !!tokenRow, "| unconsumed:", !tokenRow?.consumedAt);
  if (!tokenRow) { console.error("no email change request present — run requestEmailChange first"); process.exit(1); }

  const raw = generateRawToken();
  await db.update(authTokens)
    .set({ tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + TOKEN_TTL_MINUTES.EMAIL_CHANGE * 60000) })
    .where(eq(authTokens.id, tokenRow.id));
  const result = await accountSvc.confirmEmailChange(raw, {});
  console.log("EMAIL CHANGE confirmed:", result.newEmail);
  const [after] = await db.select().from(users).where(eq(users.id, user.id));
  console.log("email switched:", after.email, "| stamp:", after.securityStamp, "| pendingEmail:", after.pendingEmail ?? "null");
  console.log(after.email === "e2e.owner@inkline.test" && after.securityStamp > 1 ? "PASS" : "FAIL");
  await pool.end();
}
main().catch((e) => { console.error("E2E FAIL:", e); process.exit(1); });
