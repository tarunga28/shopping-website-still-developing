import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function StorefrontNotFound() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-6 py-20 text-center">
      <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-flame">404</p>
      <h1 className="mt-4 font-display text-4xl font-extrabold uppercase leading-[0.95] sm:text-6xl">
        Not in the catalogue<span className="text-flame">.</span>
      </h1>
      <p className="mt-4 text-sm leading-relaxed text-smoke">
        That page is not published. It may have moved, or the address is not a valid storefront link.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Button asChild>
          <Link href="/shop">Shop All</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/">Home</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/categories">Browse Categories</Link>
        </Button>
      </div>
    </div>
  );
}
