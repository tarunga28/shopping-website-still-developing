import "server-only";
import { db } from "@/db";
import { newsletterSubscribers } from "@/db/schema";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/services/audit.service";

/**
 * Newsletter service — stores signups with dedupe + audit trail.
 */
export interface RequestContext {
  ip?: string;
  userAgent?: string;
}

export type SubscribeResult = { status: "subscribed" | "already_subscribed" };

export async function subscribeToNewsletter(
  email: string,
  source: string,
  context: RequestContext = {},
): Promise<SubscribeResult> {
  const normalizedEmail = email.trim().toLowerCase();

  const inserted = await db
    .insert(newsletterSubscribers)
    .values({ email: normalizedEmail, source, ipHash: null })
    .onConflictDoNothing({ target: newsletterSubscribers.email })
    .returning({ id: newsletterSubscribers.id });

  if (inserted.length === 0) {
    await writeAudit({
      action: "newsletter.duplicate_signup",
      entityType: "newsletter_subscriber",
      metadata: { source },
      ip: context.ip,
      userAgent: context.userAgent,
    });
    return { status: "already_subscribed" };
  }

  await writeAudit({
    action: "newsletter.subscribed",
    entityType: "newsletter_subscriber",
    entityId: inserted[0].id,
    metadata: { source },
    ip: context.ip,
    userAgent: context.userAgent,
  });

  logger.info("Newsletter signup", { source, id: inserted[0].id });
  return { status: "subscribed" };
}
