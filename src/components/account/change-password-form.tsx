"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PasswordInput } from "@/components/ui/password-input";
import { changePasswordAction, type ActionResult } from "@/server/actions/auth-actions";

const initialState: ActionResult = { ok: false, error: "" };

export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState(changePasswordAction, initialState);
  const fields = !state.ok ? state.fieldErrors : undefined;

  return (
    <form action={formAction} className="space-y-5 rounded-card border-[1.5px] border-clay bg-cream p-6">
      <div>
        <h2 className="font-display text-sm font-bold uppercase tracking-tight">Change password</h2>
        <p className="mt-1 text-xs text-smoke">
          Other devices will be signed out when your password changes.
        </p>
      </div>

      {state.ok ? <Alert variant="success" title="Done">{state.message}</Alert> : null}
      {!state.ok && state.error ? <Alert variant="error" title="Couldn't change password">{state.error}</Alert> : null}

      <Field label="Current password" required error={fields?.currentPassword}>
        <PasswordInput
          name="currentPassword"
          autoComplete="current-password"
          placeholder="Your current password"
          invalid={Boolean(fields?.currentPassword)}
          disabled={pending || state.ok}
        />
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="New password" required error={fields?.password} description="10+ characters.">
          <PasswordInput
            name="password"
            autoComplete="new-password"
            placeholder="New password"
            invalid={Boolean(fields?.password)}
            disabled={pending || state.ok}
          />
        </Field>
        <Field label="Confirm new password" required error={fields?.confirmPassword}>
          <PasswordInput
            name="confirmPassword"
            autoComplete="new-password"
            placeholder="Repeat it"
            invalid={Boolean(fields?.confirmPassword)}
            disabled={pending || state.ok}
          />
        </Field>
      </div>

      <Button type="submit" variant="primary" size="md" loading={pending} disabled={state.ok}>
        {pending ? "Updating…" : "Update password"}
      </Button>
    </form>
  );
}
