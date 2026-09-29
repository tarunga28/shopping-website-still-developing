import { sql } from "drizzle-orm";
import { db } from "@/db";
import { siteConfig } from "@/config/site";

export const dynamic = "force-dynamic";

/**
 * Liveness + readiness probe used by deployment platforms and monitors.
 * Returns 200 only when the app AND its database dependency respond.
 * Intentionally reveals no internals beyond coarse check status.
 */
export async function GET() {
  const startedAt = performance.now();

  try {
    await db.execute(sql`select 1`);
    const latencyMs = Math.round(performance.now() - startedAt);

    return Response.json(
      {
        ok: true,
        service: siteConfig.name.toLowerCase(),
        version: siteConfig.version,
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
        checks: {
          database: { ok: true, latencyMs },
        },
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      {
        ok: false,
        timestamp: new Date().toISOString(),
        checks: { database: { ok: false } },
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
