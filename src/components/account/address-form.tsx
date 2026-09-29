"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createAddressAction,
  updateAddressAction,
  type ActionResult,
} from "@/server/actions/account-actions";
import { INDIAN_STATES } from "@/validations/account";
import type { Address } from "@/db/schema";

const initialState: ActionResult = { ok: false, error: "" };

/** Used for both create and edit — identical field contract. */
export function AddressForm({
  address,
  onDone,
}: {
  address?: Address;
  onDone: () => void;
}) {
  const router = useRouter();
  const isEdit = Boolean(address);
  const [stateValue, setStateValue] = useState(address?.state ?? "");

  const [state, formAction, pending] = useActionState(async (prev: unknown, formData: FormData) => {
    if (isEdit && address) {
      return updateAddressAction(address.id, prev, formData);
    }
    return createAddressAction(prev, formData);
  }, initialState);

  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);

  const fields = !state.ok ? state.fieldErrors : undefined;

  return (
    <form action={formAction} className="space-y-4">
      {state.ok ? <Alert variant="success">{state.message}</Alert> : null}
      {!state.ok && state.error ? <Alert variant="error">{state.error}</Alert> : null}

      <Field label="Full name" required error={fields?.fullName}>
        <Input
          name="fullName"
          defaultValue={address?.fullName}
          autoComplete="name"
          placeholder="Recipient's full name"
          invalid={Boolean(fields?.fullName)}
          disabled={pending}
        />
      </Field>

      <Field label="Phone" required error={fields?.phone} description="10-digit mobile, with country code if outside India.">
        <Input
          name="phone"
          type="tel"
          defaultValue={address?.phone}
          autoComplete="tel"
          placeholder="98765 43210"
          invalid={Boolean(fields?.phone)}
          disabled={pending}
        />
      </Field>

      <Field label="Address line 1" required error={fields?.addressLine1}>
        <Input
          name="addressLine1"
          defaultValue={address?.addressLine1}
          autoComplete="address-line1"
          placeholder="Flat, house no., street"
          invalid={Boolean(fields?.addressLine1)}
          disabled={pending}
        />
      </Field>

      <Field label="Address line 2" error={fields?.addressLine2}>
        <Input
          name="addressLine2"
          defaultValue={address?.addressLine2 ?? ""}
          autoComplete="address-line2"
          placeholder="Area, apartment (optional)"
          invalid={Boolean(fields?.addressLine2)}
          disabled={pending}
        />
      </Field>

      <Field label="Landmark" error={fields?.landmark}>
        <Input
          name="landmark"
          defaultValue={address?.landmark ?? ""}
          placeholder="Near… (optional)"
          invalid={Boolean(fields?.landmark)}
          disabled={pending}
        />
      </Field>

      <input type="hidden" name="state" value={stateValue} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="City" required error={fields?.city}>
          <Input
            name="city"
            defaultValue={address?.city}
            autoComplete="address-level2"
            placeholder="Bengaluru"
            invalid={Boolean(fields?.city)}
            disabled={pending}
          />
        </Field>
        <Field label="State" required error={fields?.state}>
          <Select value={stateValue} onValueChange={setStateValue} disabled={pending}>
            <SelectTrigger aria-label="State" className="h-11 w-full">
              <SelectValue placeholder="Select state" />
            </SelectTrigger>
            <SelectContent>
              {INDIAN_STATES.map((state) => (
                <SelectItem key={state} value={state}>
                  {state}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="PIN code" required error={fields?.postalCode}>
          <Input
            name="postalCode"
            inputMode="numeric"
            maxLength={6}
            defaultValue={address?.postalCode}
            autoComplete="postal-code"
            placeholder="560001"
            invalid={Boolean(fields?.postalCode)}
            disabled={pending}
          />
        </Field>
        <Field label="Country" required error={fields?.country}>
          <Input name="country" defaultValue={address?.country ?? "IN"} maxLength={2} disabled />
        </Field>
      </div>

      <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink/80">
        <Checkbox
          name="isDefault"
          defaultChecked={address?.isDefault ?? false}
          disabled={pending}
        />
        Set as default shipping address
      </label>

      <div className="flex gap-3 pt-2">
        <Button type="submit" variant="primary" size="md" loading={pending}>
          {pending ? "Saving…" : isEdit ? "Save changes" : "Save address"}
        </Button>
        <Button type="button" variant="outline" size="md" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
