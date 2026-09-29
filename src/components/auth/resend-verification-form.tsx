"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { resendVerificationAction, type ActionResult } from "@/server/actions/auth-actions";

const initialState: ActionResult = { ok: false, error: "" };

/** Resend verification — neutral response regardless of account existence. */
export function ResendVerificationForm({ defaultEmail }: { defaultEmail?: string }) {
  const [state, formAction, pending] = useActionState(resendVerificationAction, initialState);

  if (state.ok) {
    return (
      <p className="rounded-card border-[1.5px] border-success/50 bg-success/10 px-5 py-4 text-sm text-ink/80">
        {state.message}
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      {!state.ok && state.error ? (
        <p className="text-xs font-medium text-danger">{state.error}</p>
      ) : null}
      <Field label="Account email" required>
        <Input
          type="email"
          name="email"
          defaultValue={defaultEmail}
          autoComplete="email"
          placeholder="you@example.com"
          disabled={pending}
        />
      </Field>
      <Button type="submit" variant="outline" size="lg" loading={pending} className="w-full">
        {pending ? "Sending…" : "Resend verification email"}
      </Button>
    </form>
  );
}
