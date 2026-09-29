import { BadgeCheck, Star } from "lucide-react";
import { Rating } from "@/components/ui/rating";
import { getProductReviews } from "@/services/catalog/product-reviews.service";

const dateFormat = new Intl.DateTimeFormat("en-IN", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

/** Real, approved reviews only. No reviews → an honest empty state. */
export async function ProductReviews({ productId }: { productId: string }) {
  const data = await getProductReviews(productId);

  return (
    <section id="reviews" aria-labelledby="reviews-heading" className="scroll-mt-24">
      <h2 id="reviews-heading" className="font-display text-3xl font-extrabold uppercase">
        Reviews
      </h2>
      {data.count === 0 || data.average === null ? (
        <p className="mt-4 max-w-prose text-sm text-smoke">No reviews yet.</p>
      ) : (
        <div className="mt-6 grid gap-8 md:grid-cols-[minmax(0,18rem)_1fr]">
          <div>
            <p className="font-display text-5xl font-extrabold">{data.average.toFixed(1)}</p>
            <Rating value={data.average} count={data.count} size="md" className="mt-2" />
            <ul className="mt-5 space-y-1.5" aria-label="Rating breakdown">
              {[5, 4, 3, 2, 1].map((stars) => {
                const total = data.distribution[stars - 1] ?? 0;
                const share = data.count > 0 ? Math.round((total / data.count) * 100) : 0;
                return (
                  <li key={stars} className="flex items-center gap-2 text-xs text-smoke">
                    <span className="flex w-8 items-center gap-0.5 font-mono">
                      {stars}
                      <Star className="size-3 fill-flame text-flame" aria-hidden />
                    </span>
                    <span
                      className="h-2 flex-1 overflow-hidden rounded-pill bg-sand"
                      role="img"
                      aria-label={`${total} of ${data.count} reviews gave ${stars} ${stars === 1 ? "star" : "stars"}`}
                    >
                      <span className="block h-full bg-flame" style={{ width: `${share}%` }} />
                    </span>
                    <span className="w-6 text-right font-mono">{total}</span>
                  </li>
                );
              })}
            </ul>
          </div>
          <ul className="divide-y divide-clay/70">
            {data.reviews.map((review) => (
              <li key={review.id} className="py-5 first:pt-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Rating value={review.rating} />
                  {review.verifiedPurchase ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-success">
                      <BadgeCheck className="size-3.5" aria-hidden />
                      Verified purchase
                    </span>
                  ) : null}
                </div>
                {review.title ? <h3 className="mt-2 font-semibold [overflow-wrap:anywhere]">{review.title}</h3> : null}
                {review.body ? (
                  <p className="mt-1 max-w-prose whitespace-pre-line text-sm leading-relaxed text-smoke [overflow-wrap:anywhere]">
                    {review.body}
                  </p>
                ) : null}
                <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-smoke">
                  {review.authorName} · {dateFormat.format(new Date(review.createdAt))}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
