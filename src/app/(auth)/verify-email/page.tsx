import type { Metadata } from "next";
import Link from "next/link";
import { BadgeCheck, Clock, MailWarning, Mailbox } from "lucide-react";
import { ResendVerificationForm } from "@/components/auth/resend-verification-form";
import { Button } from "@/components/ui/button";
import { consumeVerifyEmailToken } from "@/server/actions/auth-actions";
import { buildMetadata } from "@/lib/seo";

export const metadata: Metadata = buildMetadata({
  title: "Verify your email",
  path: "/verify-email",
  noIndex: true,
});

/**
 * Verification states:
 *   /verify-email               → "check your inbox" + resend form
 *   /verify-email?token=…       → consume the token server-side, then render
 *                                 verified / expired / invalid accordingly
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; email?: string }>;
}) {
  const { token, email } = await searchParams;

  /* ── Token flow — consume once, render the outcome ─────────────────── */
  if (token) {
    const result = await consumeVerifyEmailToken(token);

    if (result.ok) {
      return (
        <div className="space-y-6 text-left">
          <BadgeCheck className="size-10 text-success" aria-hidden />
          <h1 className="font-display text-3xl font-extrabold uppercase tracking-tight sm:text-4xl">
            Email verified<span className="text-flame">.</span>
          </h1>
          <p className="text-sm leading-relaxed text-smoke">
            {result.message} Your account is fully activated — welcome aboard.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button asChild variant="primary" size="lg" className="flex-1">
              <Link href="/login?verified=1">Sign in</Link>
            </Button>
            <Button asChild variant="outline" size="lg" className="flex-1">
              <Link href="/">Back to the store</Link>
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-6">
        <MailWarning className="size-10 text-warning" aria-hidden />
        <h1 className="font-display text-3xl font-extrabold uppercase tracking-tight sm:text-4xl">
          Link no longer
          <br />
          valid<span className="text-flame">.</span>
        </h1>
        <p className="text-sm leading-relaxed text-smoke">{result.error}</p>
        <div className="rounded-card border-[1.5px] border-clay bg-cream/60 p-5">
          <ResendVerificationForm />
        </div>
      </div>
    );
  }

  /* ── No token — "we sent you a link" + resend ──────────────────────── */
  return (
    <div className="space-y-6">
      <Mailbox className="size-10 text-flame" aria-hidden />
      <h1 className="font-display text-3xl font-extrabold uppercase tracking-tight sm:text-4xl">
        Check your
        <br />
        inbox<span className="text-flame">.</span>
      </h1>
      <p className="text-sm leading-relaxed text-smoke">
        We&apos;ve sent a verification link to the email you registered with. It stays valid for
        24 hours. Click it to activate your account.
      </p>
      <div className="rounded-card border-[1.5px] border-clay bg-cream/60 p-5">
        <ResendVerificationForm defaultEmail={email} />
      </div>
      <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">
        <Clock className="size-3.5" aria-hidden />
        Links are single-use and expire for your protection
      </p>
    </div>
  );
}
