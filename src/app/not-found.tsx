import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buildMetadata } from "@/lib/seo";

export const metadata: Metadata = buildMetadata({
  title: "Page not found",
  description: "The page you're looking for doesn't exist or has moved.",
  noIndex: true,
});

export default function NotFound() {
  return (
    <div className="relative flex min-h-[70vh] flex-col items-center justify-center gap-6 overflow-hidden px-6 py-20 text-center">
      <span
        aria-hidden
        className="pointer-events-none absolute select-none font-display text-[38vw] font-extrabold leading-none text-transparent opacity-[0.06]"
        style={{ WebkitTextStroke: "2px var(--color-ink)" }}
      >
        404
      </span>
      <p className="relative font-mono text-[11px] font-medium uppercase tracking-[0.24em] text-flame">
        Error 404
      </p>
      <h1 className="relative max-w-xl font-display text-4xl font-extrabold uppercase leading-[0.95] tracking-tight sm:text-6xl">
        This print
        <br />
        never made it<span className="text-flame">.</span>
      </h1>
      <p className="relative max-w-md text-sm leading-relaxed text-smoke sm:text-base">
        The page you&apos;re looking for doesn&apos;t exist, was moved, or sold out before it was
        ever printed.
      </p>
      <div className="relative flex flex-wrap items-center justify-center gap-3">
        <Button asChild variant="primary" size="lg">
          <Link href="/">
            <ArrowLeft className="size-4" aria-hidden />
            Back to home
          </Link>
        </Button>
        <Button asChild variant="outline" size="lg">
          <Link href="/#shop">
            <Compass className="size-4" aria-hidden />
            Explore the drop
          </Link>
        </Button>
      </div>
    </div>
  );
}
