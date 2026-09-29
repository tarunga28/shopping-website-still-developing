import {
  Bell,
  ClipboardList,
  Heart,
  LayoutGrid,
  Package,
  Paintbrush,
  Search,
  ShoppingBag,
  Star,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Empty-state system — every zero-data surface in the product uses this
 * so tone, illustration scale and CTAs stay consistent.
 */

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  /** Optional call-to-action */
  action?: { label: string; href?: string; onClick?: () => void };
  className?: string;
  children?: ReactNode;
}

export function EmptyState({
  icon: Icon = Package,
  title,
  description,
  action,
  className,
  children,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-4 rounded-panel border-[1.5px] border-dashed border-clay bg-cream/40 px-6 py-14 text-center",
        className,
      )}
    >
      <span className="flex size-14 items-center justify-center rounded-pill border-[1.5px] border-ink bg-paper" aria-hidden>
        <Icon className="size-6 text-flame" />
      </span>
      <div className="space-y-1.5">
        <h3 className="font-display text-xl font-bold uppercase tracking-tight">{title}</h3>
        {description ? <p className="mx-auto max-w-sm text-sm leading-relaxed text-smoke">{description}</p> : null}
      </div>
      {action ? (
        <Button
          variant="outline"
          size="md"
          {...(action.href ? { asChild: true } : { onClick: action.onClick })}
        >
          {action.href ? <Link href={action.href}>{action.label}</Link> : action.label}
        </Button>
      ) : null}
      {children}
    </div>
  );
}

/* Presets for the common commerce empty states. */
export function EmptyProducts({ className }: { className?: string }) {
  return (
    <EmptyState
      icon={LayoutGrid}
      title="No products found"
      description="Nothing matches the current selection yet. Try a different category or check back for the next drop."
      className={className}
    />
  );
}

export function EmptySearch({ query, className }: { query?: string; className?: string }) {
  return (
    <EmptyState
      icon={Search}
      title="No search results"
      description={query ? `Nothing matched “${query}”. Check the spelling or try a broader term.` : "Try a different search term."}
      className={className}
    />
  );
}

export function EmptyWishlist({ className }: { className?: string }) {
  return (
    <EmptyState
      icon={Heart}
      title="Your wishlist is empty"
      description="Tap the heart on any design to save it here for later."
      action={{ label: "Explore designs", href: "/#shop" }}
      className={className}
    />
  );
}

export function EmptyCart({ className }: { className?: string }) {
  return (
    <EmptyState
      icon={ShoppingBag}
      title="Your cart is empty"
      description="Original prints are waiting. Find something that feels like you."
      action={{ label: "Continue shopping", href: "/#shop" }}
      className={className}
    />
  );
}

export function EmptyOrders({ className }: { className?: string }) {
  return (
    <EmptyState
      icon={ClipboardList}
      title="No orders yet"
      description="When you place an order it will appear here with live production and shipping status."
      action={{ label: "Start shopping", href: "/#shop" }}
      className={className}
    />
  );
}

export function EmptyNotifications({ className }: { className?: string }) {
  return (
    <EmptyState
      icon={Bell}
      title="No notifications"
      description="Order updates, drop announcements and restocks will show up here."
      className={className}
    />
  );
}

export function EmptyReviews({ className }: { className?: string }) {
  return (
    <EmptyState
      icon={Star}
      title="No reviews yet"
      description="Be the first to share how the print looks and fits in the wild."
      className={className}
    />
  );
}

export function EmptyDesigns({ className }: { className?: string }) {
  return (
    <EmptyState
      icon={Paintbrush}
      title="No designs yet"
      description="Your uploaded artwork will live here, ready to place on products."
      className={className}
    />
  );
}
