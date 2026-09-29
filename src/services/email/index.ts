import "server-only";
import { logger } from "@/lib/logger";

/**
 * Transactional email service — provider-agnostic interface.
 *
 * Provider selection is environment-driven:
 *   RESEND_API_KEY set  → real Resend delivery (https://resend.com)
 *   otherwise           → development log provider (links surface in the
 *                         server log, clearly tagged, nothing is faked)
 */

export interface OutgoingMail {
  to: string;
  subject: string;
  /** Pre-escaped plain text body. */
  text: string;
  /** Optional minimal HTML body — provider wraps it in the brand shell later. */
  html?: string;
}

export interface EmailProvider {
  name: string;
  send(mail: OutgoingMail): Promise<{ delivered: boolean; providerMessageId?: string }>;
}

/* ── Development log provider ─────────────────────────────────────────── */
class LogEmailProvider implements EmailProvider {
  name = "log";
  async send(mail: OutgoingMail): Promise<{ delivered: boolean }> {
    logger.info("[DEV EMAIL — not actually sent]", {
      to: mail.to,
      subject: mail.subject,
      bodyPreview: mail.text.slice(0, 500),
    });
    return { delivered: false };
  }
}

/* ── Resend provider (real HTTPS API, key from env) ───────────────────── */
class ResendEmailProvider implements EmailProvider {
  name = "resend";
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(mail: OutgoingMail): Promise<{ delivered: boolean; providerMessageId?: string }> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Resend API error ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    const body = (await response.json().catch(() => ({}))) as { id?: string };
    return { delivered: true, providerMessageId: body.id };
  }
}

let cached: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (cached) return cached;
  const resendKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM ?? "Inkline <hello@inkline.in>";
  cached = resendKey ? new ResendEmailProvider(resendKey, from) : new LogEmailProvider();
  return cached;
}

/* ── Typed mail templates (minimal text for now; rich HTML lands with
      the notifications milestone) ────────────────────────────────────── */

export async function sendVerificationEmail(opts: { to: string; verifyUrl: string }) {
  const provider = getEmailProvider();
  return provider.send({
    to: opts.to,
    subject: "Verify your Inkline email",
    text: [
      "Welcome to Inkline!",
      "",
      "Confirm this email address to activate your account:",
      opts.verifyUrl,
      "",
      "This link expires in 24 hours. If you didn't create an account, ignore this email.",
      "",
      "— Team Inkline",
    ].join("\n"),
  });
}

export async function sendPasswordResetEmail(opts: { to: string; resetUrl: string }) {
  const provider = getEmailProvider();
  return provider.send({
    to: opts.to,
    subject: "Reset your Inkline password",
    text: [
      "We received a request to reset your Inkline password.",
      "",
      "Reset link (valid for 30 minutes):",
      opts.resetUrl,
      "",
      "If this wasn't you, ignore this email — your password stays unchanged.",
      "",
      "— Team Inkline",
    ].join("\n"),
  });
}
