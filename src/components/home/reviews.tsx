import Image from "next/image";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Rating } from "@/components/ui/rating";
import { Section, SectionHeader } from "@/components/layout/section";
import { SectionFallback } from "@/components/home/section-fallback";
import { storefrontContent } from "@/content/storefront";
import type { SectionStatus, StorefrontReview } from "@/types/storefront";

function ReviewFigure({ review }: { review: StorefrontReview }) {
  return (
    <figure className="flex h-full flex-col gap-4 rounded-card border-[1.5px] border-ink bg-cream p-6">
      <div className="flex items-center justify-between gap-3">
        <Rating value={review.rating} count={undefined} />
        {review.verifiedPurchase ? <Badge variant="soft">Verified purchase</Badge> : <Badge variant="outline">Review</Badge>}
      </div>
      {review.title ? <h3 className="font-display text-lg font-bold uppercase">{review.title}</h3> : null}
      <blockquote className="text-sm leading-relaxed text-ink/85">“{review.quote}”</blockquote>
      {review.image ? (
        <div className="relative aspect-[4/3] overflow-hidden rounded-xl border border-clay">
          <Image src={review.image} alt={review.imageAlt || ""} fill sizes="320px" className="object-cover" />
        </div>
      ) : null}
      <figcaption className="mt-auto border-t border-clay pt-4 text-sm">
        <p className="font-display text-sm font-bold uppercase">{review.authorName}</p>
        {review.productHref ? (
          <Link href={review.productHref} className="mt-1 inline-block text-xs text-smoke underline decoration-flame underline-offset-4">
            {review.productLabel}
          </Link>
        ) : (
          <p className="mt-1 text-xs text-smoke">{review.productLabel}</p>
        )}
      </figcaption>
    </figure>
  );
}

/**
 * Social proof. Renders approved reviews only.
 * When none exist, shows an empty invitation — never sample quotes.
 */
export function Reviews({
  reviews,
  status = "ok",
}: {
  reviews: StorefrontReview[];
  status?: SectionStatus;
}) {
  const copy = storefrontContent.reviews;

  if (status === "error") {
    return <SectionFallback id="reviews" title="Reviews didn't load" />;
  }

  return (
    <Section id="reviews">
      <SectionHeader
        eyebrow={copy.eyebrow}
        align="center"
        title={
          reviews.length > 0 ? (
            <>
              From people
              <br />
              who ordered<span className="text-flame">.</span>
            </>
          ) : (
            <>
              {copy.titleLead}
              <br />
              {copy.titleAccent}
              <span className="text-flame">.</span>
            </>
          )
        }
        description={reviews.length > 0 ? "Approved reviews from verified purchases." : copy.emptyDescription}
      />

      {reviews.length === 0 ? (
        <div className="mx-auto max-w-lg rounded-panel border-[1.5px] border-dashed border-clay bg-cream/50 px-6 py-12 text-center">
          <p className="font-display text-2xl font-extrabold uppercase">{copy.emptyTitle}</p>
          <p className="mt-3 text-sm leading-relaxed text-smoke">{copy.emptyDescription}</p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {reviews.map((review) => (
            <li key={review.id}>
              <ReviewFigure review={review} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
