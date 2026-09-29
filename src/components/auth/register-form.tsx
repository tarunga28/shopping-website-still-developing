"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState } from "react";
import { AuthenticatorBanner } from "@/components/auth/auth-bits";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { registerAction, type ActionResult } from "@/server/actions/auth-actions";

const initialState: ActionResult = { ok: false, error: "" };

export function RegisterForm() {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(async (prev: unknown, formData: FormData) => {
    const result = await registerAction(prev, formData);
    if (result.ok) {
      // Small beat so the success copy registers before the redirect.
      setTimeout(() => router.push("/login?registered=1"), 900);
    }
    return result;
  }, initialState);

  const fields = !state.ok ? state.fieldErrors : undefined;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-extrabold uppercase tracking-tight sm:text-4xl">
          Create your
          <br />
          account<span className="text-flame">.</span>
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-smoke">
          One account for orders, saved addresses, wishlists and drop access.
        </p>
      </div>

      {state.ok ? <Alert variant="success" title="You're in!">{state.message} Redirecting to sign in…</Alert> : null}
      {!state.ok && state.error ? <Alert variant="error" title="Couldn't create your account">{state.error}</Alert> : null}

      <form action={formAction} className="space-y-4" noValidate={false}>
        <Field label="Full name" required error={fields?.name}>
          <Input
            type="text"
            name="name"
            autoComplete="name"
            placeholder="Asha Kapoor"
            invalid={Boolean(fields?.name)}
            disabled={pending || state.ok}
          />
        </Field>
        <Field label="Email" required error={fields?.email}>
          <Input
            type="email"
            name="email"
            autoComplete="email"
            placeholder="you@example.com"
            invalid={Boolean(fields?.email)}
            disabled={pending || state.ok}
          />
        </Field>
        <Field label="Phone (optional)" error={fields?.phone} description="For delivery updates — 10-digit Indian mobile.">
          <Input
            type="tel"
            name="phone"
            autoComplete="tel"
            placeholder="98765 43210"
            invalid={Boolean(fields?.phone)}
            disabled={pending || state.ok}
          />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Password" required error={fields?.password} description="10+ characters.">
            <PasswordInput
              name="password"
              autoComplete="new-password"
              placeholder="Create a password"
              invalid={Boolean(fields?.password)}
              disabled={pending || state.ok}
            />
          </Field>
          <Field label="Confirm password" required error={fields?.confirmPassword}>
            <PasswordInput
              name="confirmPassword"
              autoComplete="new-password"
              placeholder="Repeat it"
              invalid={Boolean(fields?.confirmPassword)}
              disabled={pending || state.ok}
            />
          </Field>
        </div>

        <div className="space-y-1.5">
          <label className="flex cursor-pointer items-start gap-2.5 text-xs leading-relaxed text-smoke">
            <Checkbox name="acceptTerms" className="mt-0.5" disabled={pending || state.ok} aria-describedby="terms-copy" />
            <span id="terms-copy">
              I agree to the{" "}
              <Link href="/legal/terms" className="font-semibold text-ink underline decoration-flame decoration-2 underline-offset-2 hover:text-flame">
                Terms of service
              </Link>{" "}
              and{" "}
              <Link href="/legal/privacy" className="font-semibold text-ink underline decoration-flame decoration-2 underline-offset-2 hover:text-flame">
                Privacy policy
              </Link>
              .
            </span>
          </label>
          {fields?.acceptTerms ? (
            <p role="alert" className="text-xs font-medium text-danger">
              {fields.acceptTerms}
            </p>
          ) : null}
        </div>

        <Button type="submit" variant="primary" size="lg" loading={pending} disabled={state.ok} className="w-full">
          {pending ? "Creating your account…" : "Create account"}
        </Button>
      </form>

      <p className="text-center text-sm text-smoke">
        Already have an account?{" "}
        <Link href="/login" className="font-semibold text-ink underline decoration-flame decoration-2 underline-offset-4 hover:text-flame">
          Sign in
        </Link>
      </p>

      <AuthenticatorBanner />
    </div>
  );
}
