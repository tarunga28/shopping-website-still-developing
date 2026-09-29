import Link from "next/link";
import { LockKeyhole } from "lucide-react";
import type { ReactNode } from "react";
import { Logo } from "@/components/brand/logo";
import { TrustIndicators } from "@/components/brand/trust-badges";

/**
 * Checkout layout shell — focused, distraction-free chrome for the
 * payment flow: brand mark, "secure checkout" reassurance, and a
 * two-column frame (form steps left, order summary right).
 */
export function CheckoutShell({
  children,
  summary,
}: {
  children: ReactNode;
  /** Order summary rail — own scroll region on desktop. */
  summary: ReactNode;
}) {
  return (
    <div className="min-h-svh bg-cream">
      <header className="sticky top-0 z-40 border-b-[1.5px] border-ink bg-paper">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-5 sm:px-8">
          <Link href="/" aria-label="Inkline — home" className="inline-flex">
            <Logo />
          </Link>
          <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">
            <LockKeyhole className="size-3.5 text-success" aria-hidden />
            Secure checkout · Razorpay
          </p>
        </div>
      </header>

      <main id="main-content" className="mx-auto w-full max-w-6xl px-5 py-8 sm:px-8 md:py-12">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_22rem]">
          <div className="min-w-0">{children}</div>
          <aside aria-label="Order summary" className="lg:sticky lg:top-24 lg:self-start">
            {summary}
          </aside>
        </div>
        <footer className="mt-12 border-t border-clay pt-6">
          <TrustIndicators />
        </footer>
      </main>
    </div>
  );
}
