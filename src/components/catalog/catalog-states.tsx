"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";

/** Customer-safe load failure. Details were already logged server-side; nothing technical is shown. */
export function CatalogLoadError() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <ErrorState
      kind="api"
      title="We couldn't load the catalog right now."
      description="Please try again in a moment. Nothing about your browsing has been lost."
      className="my-10"
    >
      <Button variant="primary" size="md" disabled={pending} onClick={() => startTransition(() => router.refresh())}>
        {pending ? "Trying…" : "Try Again"}
      </Button>
    </ErrorState>
  );
}
