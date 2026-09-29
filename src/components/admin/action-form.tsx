"use client";

import { useActionState, type ReactNode } from "react";
import type { CatalogActionResult } from "@/server/actions/catalog-actions";

export function ActionForm({
  action,
  children,
  className,
}: {
  action: (prev: CatalogActionResult | null, form: FormData) => Promise<CatalogActionResult>;
  children: ReactNode;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className={className} aria-busy={pending}>
      {children}
      {state?.ok === false ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      {state?.ok ? (
        <p role="status" className="text-sm text-ink">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
