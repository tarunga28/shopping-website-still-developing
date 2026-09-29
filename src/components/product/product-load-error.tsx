"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";

/** Customer-safe failure. The technical cause is logged server-side and never shown. */
export function ProductLoadError() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <ErrorState
      kind="api"
      title="We couldn't load this product right now."
      description="Please try again in a moment."
      className="my-10"
    >
      <Button variant="primary" size="md" disabled={pending} onClick={() => startTransition(() => router.refresh())}>
        {pending ? "Trying…" : "Try Again"}
      </Button>
    </ErrorState>
  );
}
