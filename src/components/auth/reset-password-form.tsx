"use client";

import Link from "next/link";
import { KeyRound } from "lucide-react";
import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PasswordInput } from "@/components/ui/password-input";
import { resetPasswordAction, type ActionResult } from "@/server/actions/auth-actions";

const initialState: ActionResult = { ok: false, error: "" };

export function ResetPasswordForm({ token }: { token: string | null }) {
  const [state, formAction, pending] = useActionState(resetPasswordAction, initialState);
  const fields = !state.ok ? state.fieldErrors : undefined;

  if (!token) {
    return (
      <div className="space-y-6">
        <h1 className="font-display text-3xl font-extrabold uppercase tracking-tight sm:text-4xl">
          Link not usable<span className="text-flame">.</span>
        </h1>
        <Alert variant="warning" title="Missing reset token">
          This reset link is incomplete. Request a fresh one below.
        </Alert>
        <Button asChild variant="primary" size="lg" className="w-full">
          <Link href="/forgot-password">Request a new link</Link>
        </Button>
      </div>
    );
  }

  if (state.ok) {
    return (
      <div className="space-y-6">
        <KeyRound className="size-8 text-success" aria-hidden />
        <h1 className="font-display text-3xl font-extrabold uppercase tracking-tight sm:text-4xl">
          Password updated<span className="text-flame">.</span>
        </h1>
        <p className="text-sm leading-relaxed text-smoke">
          {state.message} Other devices have been signed out for safety.
        </p>
        <Button asChild variant="primary" size="lg" className="w-full">
          <Link href="/login?reset=1">Sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-extrabold uppercase tracking-tight sm:text-4xl">
          Choose a new
          <br />
          password<span className="text-flame">.</span>
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-smoke">
          Make it strong and unique — you&apos;ll be signed out everywhere else automatically.
        </p>
      </div>

      {state.error ? <Alert variant="error" title="Couldn't reset password">{state.error}</Alert> : null}

      <form action={formAction} className="space-y-4">
        <input type="hidden" name="token" value={token} />
        <Field label="New password" required error={fields?.password} description="10+ characters with a good mix.">
          <PasswordInput
            name="password"
            autoComplete="new-password"
            placeholder="New password"
            invalid={Boolean(fields?.password)}
            disabled={pending}
          />
        </Field>
        <Field label="Confirm new password" required error={fields?.confirmPassword}>
          <PasswordInput
            name="confirmPassword"
            autoComplete="new-password"
            placeholder="Repeat it"
            invalid={Boolean(fields?.confirmPassword)}
            disabled={pending}
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
          {pending ? "Updating…" : "Reset password"}
        </Button>
      </form>
    </div>
  );
}
