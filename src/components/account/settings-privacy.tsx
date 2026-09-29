"use client";

import { useActionState, useState } from "react";
import { Download, TriangleAlert } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field } from "@/components/ui/field";
import { PasswordInput } from "@/components/ui/password-input";
import { Textarea } from "@/components/ui/textarea";
import {
  deactivateAccountAction,
  requestDataExportAction,
  type ActionResult,
} from "@/server/actions/account-actions";
import { notify } from "@/lib/toast";

const initialState: ActionResult = { ok: false, error: "" };

/* ── Data export card (creates a real support ticket) ─────────────────── */

export function ExportDataCard() {
  const [pending, setPending] = useState(false);

  async function handleExport() {
    setPending(true);
    const result = await requestDataExportAction();
    if (result.ok) notify.success("Data export requested", result.message);
    else notify.error(result.error);
    setPending(false);
  }

  return (
    <div className="rounded-card border-[1.5px] border-clay bg-cream p-6">
      <div className="flex items-start gap-3">
        <Download className="mt-0.5 size-5 text-flame" aria-hidden />
        <div className="flex-1">
          <h2 className="font-display text-sm font-bold uppercase tracking-tight">Your data</h2>
          <p className="mt-1.5 text-xs leading-relaxed text-smoke">
            Request a copy of everything we hold about you — profile, addresses, orders, wishlist
            and notifications. We prepare it securely and email it within 7 days.
          </p>
          <Button variant="outline" size="md" className="mt-4" onClick={handleExport} loading={pending}>
            Request data export
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── Deactivation card (password-confirmed, records preserved) ────────── */

export function DeactivateAccountCard({ role }: { role: string }) {
  const [state, formAction, pending] = useActionState(deactivateAccountAction, initialState);
  const hasPassword = true; // credentials accounts

  if (role !== "CUSTOMER") {
    return (
      <div className="rounded-card border-[1.5px] border-clay bg-cream/40 p-6">
        <h2 className="font-display text-sm font-bold uppercase tracking-tight text-smoke">
          Account lifecycle
        </h2>
        <p className="mt-1.5 text-xs text-smoke">Staff accounts are managed by a super admin.</p>
      </div>
    );
  }

  return (
    <div className="rounded-card border-[1.5px] border-danger/40 bg-danger/5 p-6">
      <div className="flex items-start gap-3">
        <TriangleAlert className="mt-0.5 size-5 text-danger" aria-hidden />
        <div className="flex-1">
          <h2 className="font-display text-sm font-bold uppercase tracking-tight">Deactivate account</h2>
          <p className="mt-1.5 text-xs leading-relaxed text-smoke">
            Deactivating signs you out everywhere and stops all emails. Your orders, invoices and
            financial records are preserved as required by law — nothing is deleted. You can ask
            support to reopen the account later.
          </p>

          {!state.ok && state.error ? (
            <Alert variant="error" className="mt-3">{state.error}</Alert>
          ) : null}

          <ConfirmDialog
            title="Deactivate your account?"
            description="You'll be signed out immediately. Orders and records stay intact; reactivation happens via support."
            confirmLabel="Yes, deactivate"
            confirmVariant="danger"
            trigger={
              <Button variant="outline-danger" size="md" className="mt-4" disabled={!hasPassword}>
                Deactivate my account
              </Button>
            }
            onConfirm={async () => {
              // The confirm dialog runs the action; the password step happens
              // inside the secure form below — this button just gates intent.
            }}
          />
          <DeactivatePasswordForm formAction={formAction} pending={pending} error={!state.ok ? state.error : null} />
        </div>
      </div>
    </div>
  );
}

function DeactivatePasswordForm({
  formAction,
  pending,
  error,
}: {
  formAction: (formData: FormData) => void;
  pending: boolean;
  error: string | null;
}) {
  return (
    <form action={formAction} className="mt-4 space-y-3 rounded-card border border-danger/30 bg-paper p-4">
      <p className="text-xs font-semibold text-ink">Confirm with your current password to deactivate</p>
      {error ? <p className="text-xs font-medium text-danger">{error}</p> : null}
      <Field label="Current password" required>
        <PasswordInput
          name="password"
          autoComplete="current-password"
          placeholder="Your password"
          disabled={pending}
        />
      </Field>
      <Field label="Why are you leaving? (optional)">
        <Textarea
          name="reason"
          rows={2}
          placeholder="A quick note helps us improve."
          disabled={pending}
        />
      </Field>
      <Button type="submit" variant="danger" size="md" loading={pending}>
        {pending ? "Deactivating…" : "Confirm deactivation"}
      </Button>
    </form>
  );
}
