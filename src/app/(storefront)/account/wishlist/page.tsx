import Image from "next/image";
import { redirect } from "next/navigation";
import { ShoppingBag } from "lucide-react";
import { AccountShell } from "@/components/layouts/account-shell";
import { WishlistRemoveButton } from "@/components/account/wishlist-remove-button";
import { ComingSoonDialog } from "@/components/layout/coming-soon-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyWishlist } from "@/components/ui/empty-state";
import { Price } from "@/components/ui/price";
import { loadAccountContext } from "@/server/account-context";
import { listWishlist } from "@/services/wishlist.service";
import { relativeTime } from "@/lib/relative-time";

export default async function WishlistPage() {
  const context = await loadAccountContext();
  if (!context) redirect("/login");

  const items = await listWishlist(context.user.id);

  return (
    <AccountShell
      title="Wishlist"
      description={`${items.length} saved ${items.length === 1 ? "design" : "designs"} — price and availability as of now.`}
      active="wishlist"
      identity={context.identity}
      unreadNotifications={context.unreadNotifications}
    >
      {items.length === 0 ? (
        <EmptyWishlist />
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {items.map((item) => (
            <li
              key={item.itemId}
              className="flex gap-4 rounded-card border-[1.5px] border-clay bg-cream p-4"
            >
              <div className="relative size-24 shrink-0 overflow-hidden rounded-lg border border-clay bg-sand sm:size-28">
                {item.imageUrl ? (
                  <Image
                    src={item.imageUrl}
                    alt={item.productName}
                    fill
                    sizes="112px"
                    className="object-cover"
                  />
                ) : (
                  <ShoppingBag className="absolute inset-0 m-auto size-5 text-smoke" aria-hidden />
                )}
              </div>

              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-display text-sm font-bold leading-tight">{item.productName}</p>
                    <p className="mt-0.5 text-[10px] uppercase tracking-[0.16em] text-smoke">
                      Saved {relativeTime(item.addedAt)}
                    </p>
                  </div>
                  {item.availability === "ARCHIVED" ? (
                    <Badge variant="sold-out">Archived</Badge>
                  ) : (
                    <Badge variant="delivered">In stock</Badge>
                  )}
                </div>

                {item.minPricePaise !== null ? (
                  <Price
                    amount={item.minPricePaise}
                    compareAt={item.compareAtPaise ?? undefined}
                    size="md"
                    className="mt-1.5 font-semibold"
                  />
                ) : (
                  <p className="mt-1.5 font-mono text-xs text-smoke">Price unavailable</p>
                )}

                <div className="mt-auto flex items-center gap-2 pt-3">
                  <ComingSoonDialog
                    feature="Move to cart opens at launch"
                    description="Once checkout is live you can move wishlist items straight into your cart. For now, they're safely saved here."
                    trigger={
                      <Button variant="primary" size="sm" disabled={item.availability === "ARCHIVED"}>
                        <ShoppingBag className="size-3.5" aria-hidden /> Move to cart
                      </Button>
                    }
                  />
                  <WishlistRemoveButton itemId={item.itemId} productName={item.productName} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </AccountShell>
  );
}
