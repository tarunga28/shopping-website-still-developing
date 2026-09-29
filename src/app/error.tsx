"use client";

import { useEffect } from "react";
import Link from "next/link";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Global error boundary for the storefront segment.
 * Shows production-safe copy; the error digest is surfaced for support
 * correlation, full details stay in server logs.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // In production this feeds error monitoring; in dev it aids debugging.
    console.error(`[storefront-error] ${error.name}: ${error.message}`, error.digest ?? "");
  }, [error]);

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-6 px-6 py-20 text-center">
      <p className="font-mono text-[11px] font-medium uppercase tracking-[0.24em] text-flame">
        Error 500
      </p>
      <h1 className="max-w-xl font-display text-4xl font-extrabold uppercase leading-[0.95] tracking-tight sm:text-6xl">
        The ink
        <br />
        smudged<span className="text-flame">.</span>
      </h1>
      <p className="max-w-md text-sm leading-relaxed text-smoke sm:text-base">
        Something went wrong on our side. It&apos;s not your fault — our team has been notified.
        Please try again.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button onClick={reset} variant="primary" size="lg">
          <RotateCcw className="size-4" aria-hidden />
          Try again
        </Button>
        <Button asChild variant="outline" size="lg">
          <Link href="/">Back to home</Link>
        </Button>
      </div>
      {error.digest ? (
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-smoke/60">
          Reference: {error.digest}
        </p>
      ) : null}
    </div>
  );
}
