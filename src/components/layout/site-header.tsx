"use client";

import Link from "next/link";
import { ChevronDown, Heart, Menu, Search, ShoppingBag } from "lucide-react";
import { useCallback, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/brand/logo";
import { AccountMenu, type SessionHint } from "@/components/layout/account-menu";
import { ComingSoonDialog } from "@/components/layout/coming-soon-dialog";
import { MobileNav } from "@/components/layout/mobile-nav";
import { SearchDialog } from "@/components/layout/search-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useHotkey } from "@/hooks/use-hotkey";
import { mainNav, siteConfig } from "@/config/site";
import { sampleCollections } from "@/lib/placeholder-data";
import { cn } from "@/lib/utils";
import type { ProductSummary } from "@/types";

function ActionButton({
  label,
  children,
  className,
  id,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "relative flex size-10 shrink-0 items-center justify-center rounded-pill border-[1.5px] border-ink bg-paper",
        "transition-all duration-300 hover:bg-ink hover:text-paper",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Collections dropdown — sample collection list, defined placeholder pages. */
function CollectionsMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="group flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-ink/80 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-flame data-[state=open]:text-ink"
        aria-label="Browse collections"
      >
        Collections
        <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Curated collections</DropdownMenuLabel>
        {sampleCollections.map((collection) => (
          <ComingSoonDialog
            key={collection.slug}
            feature={`"${collection.name}" is curating`}
            description={`${collection.description} This collection opens with the full catalog at launch — join the waitlist for first access.`}
            trigger={
              <DropdownMenuItem
                onSelect={(event) => event.preventDefault()}
                className="cursor-pointer flex-col items-start gap-1"
              >
                <span className="text-sm font-semibold">{collection.name}</span>
                <span className="text-xs text-smoke">{collection.description}</span>
              </DropdownMenuItem>
            }
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SiteHeader({
  user,
  searchProducts = [],
}: {
  user: SessionHint | null;
  searchProducts?: ProductSummary[];
}) {
  // ⌘K / Ctrl-K opens preview search from anywhere.
  const openSearch = useCallback(() => {
    document.getElementById("site-search-trigger")?.click();
  }, []);
  useHotkey("k", openSearch, { withModifier: true });

  return (
    <header className="sticky top-0 z-50 border-b-[1.5px] border-ink bg-paper/90 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-[90rem] items-center justify-between gap-4 px-5 sm:px-8 lg:px-12">
        {/* Left: mobile menu + brand */}
        <div className="flex items-center gap-2">
          <MobileNav
            user={user}
            trigger={
              <Button variant="outline" size="icon-sm" className="rounded-pill lg:hidden" aria-label="Open menu">
                <Menu className="size-5" aria-hidden />
              </Button>
            }
          />
          <Link
            href="/"
            className="flex shrink-0 items-center focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-flame"
            aria-label={`${siteConfig.name} — home`}
          >
            <Logo />
          </Link>
        </div>

        {/* Desktop navigation */}
        <nav aria-label="Primary" className="hidden items-center gap-7 lg:flex">
          {mainNav.map((item, index) => (
            <span key={item.href + item.label} className="flex items-center gap-7">
              {index === 2 ? <CollectionsMenu /> : null}
              <Link
                href={item.href}
                className="group relative text-[11px] font-semibold uppercase tracking-[0.16em] text-ink/80 transition-colors hover:text-ink"
              >
                {item.label}
                <span className="absolute -bottom-1 left-0 h-[1.5px] w-0 bg-flame transition-all duration-300 group-hover:w-full" />
              </Link>
            </span>
          ))}
        </nav>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <SearchDialog
            products={searchProducts}
            trigger={
              <ActionButton label="Search the catalogue (⌘K)" id="site-search-trigger">
                <Search className="size-4" aria-hidden />
                <span className="absolute -bottom-1 -right-1 hidden rounded-pill border border-ink bg-cream px-1 font-mono text-[8px] text-ink md:block">
                  ⌘K
                </span>
              </ActionButton>
            }
          />

          <div className="hidden items-center gap-2 md:flex">
            {user ? (
              <>
                <Link
                  href="/account/wishlist"
                  aria-label="Wishlist"
                  title="Wishlist"
                  className="relative flex size-10 shrink-0 items-center justify-center rounded-pill border-[1.5px] border-ink bg-paper transition-all duration-300 hover:bg-ink hover:text-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame"
                >
                  <Heart className="size-4" aria-hidden />
                </Link>
                <AccountMenu user={user} />
              </>
            ) : (
              <Link
                href="/login"
                className="inline-flex h-10 items-center gap-2 rounded-pill border-[1.5px] border-ink bg-ink px-5 text-[11px] font-semibold uppercase tracking-[0.14em] text-paper transition-all hover:border-flame hover:bg-flame hover:text-on-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame"
              >
                Sign in
              </Link>
            )}
          </div>

          <ComingSoonDialog
            feature="Your cart is almost ready"
            description="Checkout with secure Razorpay payments (UPI, cards, netbanking) goes live at launch. Until then, join the waitlist to get first access."
            trigger={
              <ActionButton label="Cart — 0 items">
                <ShoppingBag className="size-4" aria-hidden />
                <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-pill bg-flame font-mono text-[9px] font-semibold text-on-accent">
                  0
                </span>
              </ActionButton>
            }
          />
        </div>
      </div>
    </header>
  );
}
