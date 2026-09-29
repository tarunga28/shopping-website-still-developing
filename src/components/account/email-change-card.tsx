"use client";

import { BadgeCheck, KeyRound, MailPlus } from "lucide-react";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { requestEmailChangeAction, type ActionResult } from "@/server/actions/account-actions";

const initialState: ActionResult = { ok: false, error: "" };

/**
 * Secure email change — request sends a confirmation to the NEW address.
 * The switch only completes once that link is clicked (2h TTL, single use).
 */
export function EmailChangeCard({
  email,
  verified,
  pendingEmail,
}: {
  email: string;
  verified: boolean;
  pendingEmail: string | null;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(async (prev: unknown, formData: FormData) => {
    const result = await requestEmailChangeAction(prev, formData);
    if (result.ok) router.refresh();
    return result;
  }, initialState);
  const fields = !state.ok ? state.fieldErrors : undefined;

  return (
    <section aria-labelledby="email-heading" className="rounded-card border-[1.5px] border-clay bg-cream p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="email-heading" className="font-display text-sm font-bold uppercase tracking-tight">
          Sign-in email
        </h2>
        {verified ? (
          <Badge variant="delivered">
            <BadgeCheck className="size-3" aria-hidden /> Verified
          </Badge>
        ) : (
          <Badge variant="warning">Unverified</Badge>
        )}
      </div>

      <p className="mt-3 text-sm text-ink/85">{email}</p>

      {pendingEmail ? (
        <Alert variant="info" className="mt-4" title="Change in progress">
          A confirmation link was sent to <strong>{pendingEmail}</strong>. Your sign-in email
          switches only after the new owner confirms it (link valid 2 hours).
        </Alert>
      ) : null}

      {state.ok ? <Alert variant="success" className="mt-4">{state.message}</Alert> : null}
      {!state.ok && state.error ? <Alert variant="error" className="mt-4">{state.error}</Alert> : null}

      <form action={formAction} className="mt-5 space-y-3">
        <Field
          label="New email address"
          description="We'll email a confirmation link to this address — nothing changes until it's confirmed."
          error={fields?.newEmail}
        >
          <Input
            type="email"
            name="newEmail"
            placeholder="new.address@example.com"
            autoComplete="off"
            invalid={Boolean(fields?.newEmail)}
            disabled={pending}
          />
        </Field>
        <Button type="submit" variant="outline" size="md" loading={pending}>
          <MailPlus className="size-4" aria-hidden />
          {pending ? "Sending confirmation…" : "Request email change"}
        </Button>
      </form>

      <p className="mt-4 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-smoke">
        <KeyRound className="size-3.5" aria-hidden /> Confirmed changes sign out other devices
      </p>
    </section>
  );
}
