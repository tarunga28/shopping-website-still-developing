import { Skeleton } from "@/components/ui/skeleton";

/** Section-level placeholder used inside <Suspense> for below-the-fold content. */
export function SectionSkeleton({ rows = 3, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-4">
      <Skeleton className="h-8 w-56" />
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-4 w-full max-w-2xl" />
      ))}
    </div>
  );
}

export function RelatedSkeleton() {
  return (
    <div role="status" aria-label="Loading related products" className="space-y-6">
      <Skeleton className="h-8 w-64" />
      <div className="grid grid-cols-2 gap-x-3 gap-y-8 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="space-y-3">
            <Skeleton className="aspect-[4/5] w-full rounded-card" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Full product-page placeholder: image, title, price, options and content,
 * with the same proportions as the real layout so nothing jumps on load.
 */
export function ProductPageSkeleton() {
  return (
    <div role="status" aria-label="Loading product" aria-busy="true" className="grid gap-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-14">
      <div className="space-y-3">
        <Skeleton className="aspect-[4/5] w-full rounded-card" />
        <div className="flex gap-2">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="size-16 shrink-0 rounded-xl sm:size-20" />
          ))}
        </div>
      </div>
      <div className="space-y-5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-10 w-4/5" />
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-4 w-full max-w-md" />
        <div className="flex gap-3 pt-3">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="size-11 rounded-full" />
          ))}
        </div>
        <div className="flex gap-2">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-11 w-14 rounded-pill" />
          ))}
        </div>
        <Skeleton className="h-13 w-full rounded-pill" />
        <div className="space-y-3 pt-6">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    </div>
  );
}
