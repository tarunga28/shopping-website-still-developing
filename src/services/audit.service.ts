import "server-only";
import { createHash } from "node:crypto";
import { db } from "@/db";
import { auditEvents } from "@/db/schema";
import { logger } from "@/lib/logger";
import type { DbClient } from "@/db/utils";

/**
 * Central audit trail — every security/admin event flows through here so
 * redaction rules live in exactly one place.
 * NEVER pass: passwords, tokens, session secrets, card data, API keys.
 */

export type AuditAction =
  | "user.registered"
  | "user.login_success"
  | "user.login_failed"
  | "user.logout"
  | "user.password_changed"
  | "user.password_reset_requested"
  | "user.password_reset_completed"
  | "user.email_verified"
  | "user.email_verification_resent"
  | "user.profile_updated"
  | "user.suspended"
  | "newsletter.subscribed"
  | "newsletter.duplicate_signup"
  | (string & {}); // domain actions from later milestones

export interface AuditEntry {
  action: AuditAction;
  entityType: string;
  entityId?: string;
  actorId?: string;
  /** Redacted context only. */
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

/** Salted one-way IP hash — raw IPs are never persisted. */
export function hashIp(ip: string | undefined | null): string | null {
  if (!ip) return null;
  const salt = process.env.IP_HASH_SALT ?? "inkline-dev-salt";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex");
}

export async function writeAudit(entry: AuditEntry, client: DbClient = db): Promise<void> {
  try {
    await client.insert(auditEvents).values({
      actorId: entry.actorId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      metadata: entry.metadata,
      ipHash: hashIp(entry.ip),
      userAgent: entry.userAgent?.slice(0, 300) ?? null,
    });
  } catch (error) {
    // Audit must never break the business flow — log and continue.
    logger.warn("Audit write failed", {
      action: entry.action,
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}
