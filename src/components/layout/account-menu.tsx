"use client";

import Link from "next/link";
import { ChevronDown, Heart, KeyRound, LogOut, Package, Settings2, User as UserIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { logoutAction } from "@/server/actions/auth-actions";
import { cn } from "@/lib/utils";

export interface SessionHint {
  name: string;
  role: string;
  verified: boolean;
}

const ADMIN_ROLES = ["ADMIN", "SUPER_ADMIN", "PRODUCT_MANAGER", "ORDER_MANAGER", "SUPPORT"];

/**
 * Signed-in account menu — replaces the "accounts are coming" dialog for
 * authenticated users. Sign-out is a real server action.
 */
export function AccountMenu({ user }: { user: SessionHint }) {
  const initials = user.name
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const isAdmin = ADMIN_ROLES.includes(user.role);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account menu for ${user.name}`}
        data-track="ACCOUNT_OPENED"
        className={cn(
          "flex size-10 items-center justify-center rounded-pill border-[1.5px] border-ink bg-flame font-display text-xs font-extrabold text-on-accent",
          "transition-all hover:bg-ink hover:text-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame",
        )}
      >
        <span aria-hidden>{initials}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>
          <span className="block truncate text-sm font-semibold text-ink">{user.name}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-smoke">
            {user.verified ? "Verified account" : "Email pending verification"}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account" className="cursor-pointer">
            <UserIcon className="size-4 text-smoke" aria-hidden /> Account overview
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/account/orders" className="cursor-pointer">
            <Package className="size-4 text-smoke" aria-hidden /> Orders
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/account/wishlist" className="cursor-pointer">
            <Heart className="size-4 text-smoke" aria-hidden /> Wishlist
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/account/security" className="cursor-pointer">
            <KeyRound className="size-4 text-smoke" aria-hidden /> Security
          </Link>
        </DropdownMenuItem>
        {isAdmin ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/admin" className="cursor-pointer font-semibold text-flame">
                <Settings2 className="size-4" aria-hidden /> Admin console
              </Link>
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <form action={logoutAction}>
            <button type="submit" className="flex w-full cursor-pointer items-center gap-2 text-danger">
              <LogOut className="size-4" aria-hidden /> Sign out
            </button>
          </form>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
