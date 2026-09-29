import "dotenv/config";

async function main() {
  const { registerUser } = await import("@/services/auth.service");
  const { db, pool } = await import("@/db");
  const { authTokens, users } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");

  const email = "e2e.customer@inkline.test";
  await db.delete(users).where(eq(users.email, email));

  const { userId } = await registerUser(
    { name: "E2E Customer", email, phone: "9876543210", password: "Tr0ub4dour&9x" },
    { ip: "203.0.113.7", userAgent: "e2e-script" },
  );
  console.log("registered userId:", userId);

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  console.log("role:", user.role, "| status:", user.status, "| hash format:", user.passwordHash?.slice(0, 7), "| verified:", user.emailVerifiedAt ?? "null");

  const tokens = await db.select().from(authTokens).where(eq(authTokens.userId, userId));
  console.log("verification token issued:", tokens.length, "| stored:", tokens[0]?.tokenHash.length, "char sha256 hex");

  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
