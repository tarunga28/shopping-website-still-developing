import Link from "next/link";
import { cn } from "@/lib/utils";
import type { CategoryNavData } from "@/services/catalog/listing.service";

const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame";

/** Sidebar category list (desktop). Counts are exact, from the same visibility rules as the grid. */
export function CategoryNavList({ nav }: { nav: CategoryNavData }) {
  if (nav.items.length === 0 && !nav.up) return null;
  return (
    <nav aria-label="Categories" className="mb-8">
      <h2 className="mb-3 font-display text-lg font-extrabold uppercase">{nav.heading}</h2>
      <ul className="space-y-0.5">
        {nav.up ? (
          <li>
            <Link href={nav.up.href} className={cn("inline-flex min-h-9 items-center text-sm text-smoke hover:text-ink", focus)}>
              ← {nav.up.name}
            </Link>
          </li>
        ) : (
          <li>
            <Link
              href="/shop"
              aria-current={nav.currentSlug === null ? "page" : undefined}
              className={cn("flex min-h-9 items-center text-sm hover:underline", nav.currentSlug === null && "font-semibold", focus)}
            >
              All products
            </Link>
          </li>
        )}
        {nav.items.map((item) => (
          <li key={item.slug}>
            <Link
              href={`/category/${item.slug}`}
              aria-current={nav.currentSlug === item.slug ? "page" : undefined}
              className={cn(
                "flex min-h-9 items-center justify-between gap-2 text-sm hover:underline",
                nav.currentSlug === item.slug && "font-semibold",
                focus,
              )}
            >
              <span>{item.name}</span>
              <span className="font-mono text-[11px] text-smoke">{item.count}</span>
            </Link>
            {item.children.length > 0 ? (
              <ul className="ml-3 border-l border-clay pl-3">
                {item.children.map((child) => (
                  <li key={child.slug}>
                    <Link
                      href={`/category/${child.slug}`}
                      aria-current={nav.currentSlug === child.slug ? "page" : undefined}
                      className={cn(
                        "flex min-h-8 items-center justify-between gap-2 text-sm text-smoke hover:text-ink hover:underline",
                        nav.currentSlug === child.slug && "font-semibold text-ink",
                        focus,
                      )}
                    >
                      <span>{child.name}</span>
                      <span className="font-mono text-[11px]">{child.count}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Horizontally scrollable chips (mobile/tablet). */
export function CategoryNavChips({ nav }: { nav: CategoryNavData }) {
  if (nav.items.length === 0) return null;
  const chip = (active: boolean) =>
    cn(
      "inline-flex min-h-9 shrink-0 items-center rounded-pill border-[1.5px] px-4 text-xs font-medium transition-colors",
      active ? "border-ink bg-ink text-paper" : "border-clay bg-paper hover:border-ink",
      focus,
    );
  return (
    <nav aria-label="Categories" className="-mx-1 mb-4 overflow-x-auto px-1 pb-1 lg:hidden">
      <ul className="flex gap-2">
        <li>
          <Link href="/shop" className={chip(nav.currentSlug === null)} aria-current={nav.currentSlug === null ? "page" : undefined}>
            All
          </Link>
        </li>
        {nav.items.map((item) => (
          <li key={item.slug}>
            <Link
              href={`/category/${item.slug}`}
              className={chip(nav.currentSlug === item.slug)}
              aria-current={nav.currentSlug === item.slug ? "page" : undefined}
            >
              {item.name}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
