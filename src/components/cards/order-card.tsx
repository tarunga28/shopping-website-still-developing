import Image from "next/image";
import { ChevronRight } from "lucide-react";
import { StatusBadge, type OrderStatus } from "@/components/ui/badge";
import { Price } from "@/components/ui/price";

/**
 * Order card — account order-list rows and admin order previews.
 * Contract mirrors the future `orders` aggregate root.
 */
export function OrderCard({
  order,
  action,
}: {
  order: {
    id: string;
    number: string;
    placedAt: string;
    status: OrderStatus;
    itemsCount: number;
    totalPaise: number;
    thumbnails: string[];
  };
  /** Optional trailing action (e.g. "Track", "View details"). */
  action?: React.ReactNode;
}) {
  return (
    <article className="flex flex-col gap-4 rounded-card border-[1.5px] border-clay bg-cream p-5 sm:flex-row sm:items-center">
      <div className="flex items-center gap-3">
        <div className="flex -space-x-3">
          {order.thumbnails.slice(0, 3).map((src, index) => (
            <span key={index} className="relative size-12 overflow-hidden rounded-lg border-[1.5px] border-ink bg-sand">
              <Image src={src} alt={`Item ${index + 1} of ${order.number}`} fill sizes="48px" className="object-cover" />
            </span>
          ))}
        </div>
        <div>
          <p className="font-mono text-xs font-semibold text-ink">{order.number}</p>
          <p className="mt-0.5 text-[11px] text-smoke">
            {order.placedAt} · {order.itemsCount} {order.itemsCount === 1 ? "item" : "items"}
          </p>
        </div>
      </div>

      <div className="flex flex-1 items-center justify-between gap-3 sm:justify-end sm:gap-5">
        <StatusBadge status={order.status} />
        <Price amount={order.totalPaise} size="md" className="font-semibold" />
        {action ?? (
          <span aria-hidden className="flex size-8 items-center justify-center rounded-pill border-[1.5px] border-clay text-smoke">
            <ChevronRight className="size-4" />
          </span>
        )}
      </div>
    </article>
  );
}
