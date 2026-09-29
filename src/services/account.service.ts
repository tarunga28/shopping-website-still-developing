import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { authTokens, users } from "@/db/schema";
import { withTransaction } from "@/db/utils";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { verifyPassword } from "@/server/auth/password";
import { generateRawToken, hashToken, isTokenUsable, TOKEN_TTL_MINUTES } from "@/server/auth/tokens";
import { normalizeEmail } from "@/validations/auth";
import { hashIp, writeAudit } from "@/services/audit.service";
import { absoluteUrl } from "@/lib/seo";
import { createNotification } from "@/services/notification.service";
import { getEmailProvider } from "@/services/email";
import { supportTickets, supportMessages } from "@/db/schema";

export interface AccountRequestContext {
  ip?: string;
  userAgent?: string;
}

export class AccountError extends AppError {
  constructor(message: string) {
    super(message, { status: 400, code: "ACCOUNT_ERROR" });
  }
}

/* ── Email change (secure two-step) ──────────────────────────────────── */

export async function requestEmailChange(
  userId: string,
  newEmailRaw: string,
  context: AccountRequestContext = {},
): Promise<{ maskedTarget: string }> {
  const newEmail = normalizeEmail(newEmailRaw);
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new AccountError("Account not found.");

  if (newEmail === user.email) {
    throw new AccountError("That's already your account email.");
  }

  const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, newEmail)).limit(1);
  if (taken) throw new AccountError("That email is already linked to another account.");

  const rawToken = await withTransaction(async (tx) => {
    await tx
      .update(authTokens)
      .set({ consumedAt: new Date() })
      .where(and(eq(authTokens.userId, userId), eq(authTokens.type, "EMAIL_CHANGE"), sql`${authTokens.consumedAt} IS NULL`));

    const raw = generateRawToken();
    await tx.insert(authTokens).values({
      userId,
      type: "EMAIL_CHANGE",
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + TOKEN_TTL_MINUTES.EMAIL_CHANGE * 60_000),
      ipHash: hashIp(context.ip),
    });
    await tx.update(users).set({ pendingEmail: newEmail }).where(eq(users.id, userId));
    return raw;
  });

  const confirmUrl = absoluteUrl(`/account/profile/confirm-email?token=${rawToken}`);
  await getEmailProvider()
    .send({
      to: newEmail,
      subject: "Confirm your new Inkline email",
      text: [
        `Hello ${user.name},`,
        "",
        "You asked to change the email on your Inkline account to this address.",
        "Confirm it here (valid for 2 hours):",
        confirmUrl,
        "",
        "If you didn't request this, ignore the email — your sign-in email stays unchanged.",
        "",
        "— Team Inkline",
      ].join("\n"),
    })
    .catch((error) => logger.warn("Email-change email failed", { error: error instanceof Error ? error.message : "unknown" }));

  await writeAudit({
    action: "user.email_change_requested",
    entityType: "user",
    entityId: userId,
    actorId: userId,
    metadata: { targetDomain: newEmail.split("@")[1] },
    ip: context.ip,
    userAgent: context.userAgent,
  });

  // Mask target address for the UI confirmation copy.
  const [local, domain] = newEmail.split("@");
  const maskedTarget = `${local.slice(0, 2)}***@${domain}`;
  return { maskedTarget };
}

export async function confirmEmailChange(
  rawToken: string,
  context: AccountRequestContext = {},
): Promise<{ userId: string; newEmail: string }> {
  const tokenHash = hashToken(rawToken);
  const [token] = await db
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.tokenHash, tokenHash), eq(authTokens.type, "EMAIL_CHANGE")))
    .limit(1);

  if (!token || !isTokenUsable(token)) {
    throw new AccountError("This confirmation link is invalid or has expired.");
  }

  const [user] = await db.select().from(users).where(eq(users.id, token.userId)).limit(1);
  if (!user?.pendingEmail) throw new AccountError("No pending email change found.");

  const newEmail = user.pendingEmail;
  const [conflict] = await db.select({ id: users.id }).from(users).where(eq(users.email, newEmail)).limit(1);
  if (conflict && conflict.id !== user.id) {
    throw new AccountError("That email was taken by another account. Please choose a different one.");
  }

  await withTransaction(async (tx) => {
    await tx.update(authTokens).set({ consumedAt: new Date() }).where(eq(authTokens.id, token.id));
    await tx
      .update(users)
      .set({
        email: newEmail,
        pendingEmail: null,
        emailVerifiedAt: new Date(),
        // New sign-in identity → other sessions should re-authenticate.
        securityStamp: sql`${users.securityStamp} + 1`,
      })
      .where(eq(users.id, user.id));
  });

  await createNotification(user.id, {
    type: "ACCOUNT",
    title: "Email address changed",
    message: `Your sign-in email is now ${newEmail}. Other devices were signed out.`,
    linkHref: "/account/security",
  });

  await writeAudit({
    action: "user.email_changed",
    entityType: "user",
    entityId: user.id,
    actorId: user.id,
    metadata: { toDomain: newEmail.split("@")[1] },
    ip: context.ip,
    userAgent: context.userAgent,
  });

  return { userId: user.id, newEmail };
}

/* ── Account deactivation (records preserved) ────────────────────────── */

export async function deactivateAccount(
  userId: string,
  password: string,
  reason: string | undefined,
  context: AccountRequestContext = {},
): Promise<void> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user?.passwordHash) throw new AccountError("We couldn't verify your account.");
  if (!verifyPassword(user.passwordHash, password)) {
    throw new AccountError("That password isn't correct.");
  }
  if (user.role !== "CUSTOMER") {
    throw new AccountError("Staff accounts can't be deactivated from here.");
  }

  await withTransaction(async (tx) => {
    await tx
      .update(users)
      .set({ status: "DEACTIVATED", securityStamp: sql`${users.securityStamp} + 1` })
      .where(eq(users.id, userId));
    // Consume any outstanding credential tokens.
    await tx
      .update(authTokens)
      .set({ consumedAt: new Date() })
      .where(and(eq(authTokens.userId, userId), sql`${authTokens.consumedAt} IS NULL`));
  });

  await writeAudit({
    action: "user.deactivated",
    entityType: "user",
    entityId: userId,
    actorId: userId,
    metadata: { reasonLength: reason?.length ?? 0 },
    ip: context.ip,
    userAgent: context.userAgent,
  });
}

/* ── Data export request (creates a real support ticket) ─────────────── */

export async function requestDataExport(userId: string): Promise<{ ticketNumber: string }> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new AccountError("Account not found.");

  const ticketNumber = `EXP-${Date.now().toString(36).toUpperCase()}`;
  await withTransaction(async (tx) => {
    const [ticket] = await tx
      .insert(supportTickets)
      .values({
        ticketNumber,
        userId,
        subject: "Data export request",
        status: "OPEN",
        priority: "NORMAL",
        channel: "account",
      })
      .returning();
    await tx.insert(supportMessages).values({
      ticketId: ticket.id,
      body: `Customer requested an export of their personal data (account ${user.email}). Export should include profile, addresses, orders, wishlist and notifications, delivered within 7 days per privacy policy.`,
      isStaff: false,
    });
  });

  await createNotification(userId, {
    type: "ACCOUNT",
    title: "Data export requested",
    message: "Our team will prepare your data export and share it via email.",
    linkHref: "/account/settings",
  });

  await writeAudit({
    action: "user.data_export_requested",
    entityType: "user",
    entityId: userId,
    actorId: userId,
    metadata: { ticketNumber },
  });

  return { ticketNumber };
}
