"use client";

import Link from "next/link";
import { ChevronDown, Heart, Menu, Search } from "lucide-react";
import { useCallback, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/brand/logo";
import { AccountMenu, type SessionHint } from "@/components/layout/account-menu";
import { CartButton } from "@/components/layout/cart-button";
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
import { collectionPath, loginPath } from "@/lib/storefront-paths";
import { cn } from "@/lib/utils";
import type { StorefrontCollection } from "@/types/storefront";

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

function CollectionsMenu({ collections }: { collections: StorefrontCollection[] }) {
  if (collections.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="group flex min-h-10 items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-ink/80 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-flame data-[state=open]:text-ink"
        aria-label="Browse collections"
      >
        Collections
        <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Collections</DropdownMenuLabel>
        {collections.map((collection) => (
          <DropdownMenuItem key={collection.slug} asChild>
            <Link
              href={collectionPath(collection.slug)}
              data-track="COLLECTION_CLICK"
              data-track-id={collection.slug}
              className="cursor-pointer flex-col items-start gap-1"
            >
              <span className="text-sm font-semibold">{collection.name}</span>
              {collection.description ? (
                <span className="line-clamp-2 text-xs text-smoke">{collection.description}</span>
              ) : null}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SiteHeader({
  user,
  collections = [],
  cartCount = null,
}: {
  user: SessionHint | null;
  collections?: StorefrontCollection[];
  /** Null when the cart is not connected. Never pass 0 just to fill a badge. */
  cartCount?: number | null;
}) {
  const openSearch = useCallback(() => {
    document.getElementById("site-search-trigger")?.click();
  }, []);
  useHotkey("k", openSearch, { withModifier: true });

  return (
    <header className="sticky top-0 z-50 border-b-[1.5px] border-ink bg-paper/90 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-[90rem] items-center justify-between gap-3 px-4 sm:px-8 lg:px-12">
        <div className="flex min-w-0 items-center gap-2">
          <MobileNav
            user={user}
            collections={collections}
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

        <nav aria-label="Primary" className="hidden items-center gap-7 lg:flex">
          {mainNav.map((item) => (
            <Link
              key={item.href + item.label}
              href={item.href}
              className="group relative text-[11px] font-semibold uppercase tracking-[0.16em] text-ink/80 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-flame"
            >
              {item.label}
              <span className="absolute -bottom-1 left-0 h-[1.5px] w-0 bg-flame transition-all duration-300 group-hover:w-full" />
            </Link>
          ))}
          <CollectionsMenu collections={collections} />
        </nav>

        <div className="flex items-center gap-2">
          <SearchDialog
            trigger={
              <ActionButton label="Search the catalogue" id="site-search-trigger">
                <Search className="size-4" aria-hidden />
                <span className="sr-only">Search</span>
              </ActionButton>
            }
          />

          <div className="hidden items-center gap-2 md:flex">
            <Link
              href={user ? "/account/wishlist" : loginPath("/account/wishlist")}
              data-track="WISHLIST_OPENED"
              aria-label={user ? "Wishlist" : "Wishlist — sign in required"}
              title="Wishlist"
              className="relative flex size-10 shrink-0 items-center justify-center rounded-pill border-[1.5px] border-ink bg-paper transition-all duration-300 hover:bg-ink hover:text-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame"
            >
              <Heart className="size-4" aria-hidden />
            </Link>
            {user ? (
              <span className="inline-flex items-center gap-2">
                <span className="hidden text-[11px] font-semibold uppercase tracking-[0.14em] xl:inline">Account</span>
                <AccountMenu user={user} />
              </span>
            ) : (
              <Link
                href="/login"
                data-track="ACCOUNT_OPENED"
                className="inline-flex h-10 items-center gap-2 rounded-pill border-[1.5px] border-ink bg-ink px-5 text-[11px] font-semibold uppercase tracking-[0.14em] text-paper transition-all hover:border-flame hover:bg-flame hover:text-on-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame"
              >
                Login
              </Link>
            )}
          </div>

          <CartButton count={cartCount} />
        </div>
      </div>
    </header>
  );
}
