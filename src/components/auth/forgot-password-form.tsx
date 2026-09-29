"use client";

import Link from "next/link";
import { ArrowLeft, MailCheck } from "lucide-react";
import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { forgotPasswordAction, type ActionResult } from "@/server/actions/auth-actions";

const initialState: ActionResult = { ok: false, error: "" };

export function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState(forgotPasswordAction, initialState);
  const fields = !state.ok ? state.fieldErrors : undefined;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-extrabold uppercase tracking-tight sm:text-4xl">
          Reset your
          <br />
          password<span className="text-flame">.</span>
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-smoke">
          Tell us your account email and we&apos;ll send a secure reset link. For your security,
          the link works once and expires in 30 minutes.
        </p>
      </div>

      {state.ok ? (
        <div className="space-y-5 rounded-card border-[1.5px] border-success/50 bg-success/10 p-6">
          <MailCheck className="size-8 text-success" aria-hidden />
          <div>
            <h2 className="font-display text-lg font-bold uppercase">Check your inbox</h2>
            <p className="mt-2 text-sm leading-relaxed text-ink/75">{state.message}</p>
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">
            Didn&apos;t arrive? Check spam, or try again in a few minutes.
          </p>
        </div>
      ) : (
        <>
          {state.error ? <Alert variant="error" title="Couldn't send reset email">{state.error}</Alert> : null}
          <form action={formAction} className="space-y-4">
            <Field label="Email" required error={fields?.email}>
              <Input
                type="email"
                name="email"
                autoComplete="email"
                placeholder="you@example.com"
                invalid={Boolean(fields?.email)}
                disabled={pending}
              />
            </Field>
            <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
              {pending ? "Sending link…" : "Send reset link"}
            </Button>
          </form>
        </>
      )}

      <Link
        href="/login"
        className="group flex items-center justify-center gap-2 text-sm font-semibold text-smoke transition-colors hover:text-ink"
      >
        <ArrowLeft className="size-4 transition-transform group-hover:-translate-x-1" aria-hidden />
        Back to sign in
      </Link>
    </div>
  );
}
