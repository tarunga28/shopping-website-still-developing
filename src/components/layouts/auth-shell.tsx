import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/brand/logo";

/**
 * Authentication layout shell — split frame used by sign-in/sign-up/
 * recovery routes. Art side carries the brand story; form side centers
 * a single narrow card.
 */
export function AuthShell({
  children,
  quote,
}: {
  children: ReactNode;
  quote?: { text: string; attribution: string };
}) {
  return (
    <div className="grid min-h-svh grid-cols-1 lg:grid-cols-2">
      {/* Form side */}
      <div className="flex flex-col p-6 sm:p-10">
        <Link href="/" aria-label="Inkline — home" className="inline-flex w-fit">
          <Logo size="lg" />
        </Link>
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-sm">{children}</div>
        </div>
        <p className="text-center font-mono text-[9px] uppercase tracking-[0.2em] text-smoke">
          Original art · printed on demand · India
        </p>
      </div>

      {/* Art side */}
      <div className="relative hidden border-l-[1.5px] border-ink bg-flame lg:flex lg:flex-col lg:items-center lg:justify-center lg:p-16">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center font-display text-[24rem] font-extrabold leading-none text-ink/10"
        >
          ✳
        </span>
        <figure className="relative max-w-md text-center">
          <blockquote className="font-display text-4xl font-extrabold uppercase leading-[1] tracking-tight text-ink">
            “{quote?.text ?? "Every piece starts as real ink on real paper."}”
          </blockquote>
          <figcaption className="mt-6 font-mono text-[10px] uppercase tracking-[0.22em] text-ink/70">
            {quote?.attribution ?? "The Inkline studio"}
          </figcaption>
        </figure>
      </div>
    </div>
  );
}
