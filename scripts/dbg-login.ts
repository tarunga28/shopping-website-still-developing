import "dotenv/config";
async function main() {
  const { verifyLoginCredentials } = await import("@/services/auth.service");
  const { pool } = await import("@/db");
  try {
    const user = await verifyLoginCredentials("admin@inkline.in", "InklineAdmin#2026", { ip: "127.0.0.1" });
    console.log("LOGIN OK:", user.email, user.role);
  } catch (e: any) {
    console.error("LOGIN ERROR:", e.name, e.message, e.code);
    console.error("CAUSE:", e.cause?.message ?? e.cause);
  }
  await pool.end();
}
main();
