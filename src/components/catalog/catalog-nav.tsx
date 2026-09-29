"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useTransition, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Client-side navigation for catalog controls. The URL is the state: every
 * filter/sort change is a real `router.push`, so back/forward, refresh and
 * shared links all reproduce the same listing. The transition flag lets the
 * results dim while the server renders the next page.
 */

interface CatalogNavValue {
  pending: boolean;
  navigate: (href: string) => void;
}

const CatalogNavContext = createContext<CatalogNavValue>({ pending: false, navigate: () => undefined });

export function CatalogNavProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const navigate = useCallback(
    (href: string) => {
      startTransition(() => {
        router.push(href, { scroll: false });
      });
    },
    [router],
  );
  const value = useMemo(() => ({ pending, navigate }), [pending, navigate]);
  return <CatalogNavContext.Provider value={value}>{children}</CatalogNavContext.Provider>;
}

export function useCatalogNav(): CatalogNavValue {
  return useContext(CatalogNavContext);
}

/** Wraps results so they visibly (and for assistive tech) reflect a pending update. */
export function ResultsRegion({ children, className }: { children: ReactNode; className?: string }) {
  const { pending } = useCatalogNav();
  return (
    <div
      aria-busy={pending}
      className={cn("transition-opacity duration-200 motion-reduce:transition-none", pending && "opacity-50", className)}
    >
      {children}
    </div>
  );
}
