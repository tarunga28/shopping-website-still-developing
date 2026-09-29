import Link from "next/link";
import { BadgeCheck, MailWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmEmailChange } from "@/services/account.service";
import { buildMetadata } from "@/lib/seo";

export const metadata = buildMetadata({ title: "Confirm new email", noIndex: true });

/**
 * Email-change confirmation landing — consumes the single-use token from
 * the confirmation email. Success signs other sessions out server-side.
 */
export default async function ConfirmEmailChangePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  let outcome: { ok: true } | { ok: false; message: string } = { ok: false, message: "Missing confirmation token." };
  if (token) {
    try {
      await confirmEmailChange(token, {});
      outcome = { ok: true };
    } catch (error) {
      outcome = { ok: false, message: error instanceof Error ? error.message : "This confirmation link is invalid or has expired." };
    }
  }

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col items-center justify-center gap-6 px-6 py-16 text-center">
      {outcome.ok ? (
        <>
          <BadgeCheck className="size-10 text-success" aria-hidden />
          <h1 className="font-display text-3xl font-extrabold uppercase tracking-tight sm:text-4xl">
            Email changed<span className="text-flame">.</span>
          </h1>
          <p className="text-sm leading-relaxed text-smoke">
            Your sign-in email has been updated. Other devices were signed out — please sign in again
            with your new email.
          </p>
          <Button asChild variant="primary" size="lg">
            <Link href="/login">Sign in with new email</Link>
          </Button>
        </>
      ) : (
        <>
          <MailWarning className="size-10 text-warning" aria-hidden />
          <h1 className="font-display text-3xl font-extrabold uppercase tracking-tight sm:text-4xl">
            Link not usable<span className="text-flame">.</span>
          </h1>
          <p className="text-sm leading-relaxed text-smoke">{outcome.message}</p>
          <div className="flex flex-wrap justify-center gap-3">
            <Button asChild variant="primary" size="lg">
              <Link href="/account/profile">Back to profile</Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link href="/">Home</Link>
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
