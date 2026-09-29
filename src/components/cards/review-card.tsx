import { Quote } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Rating } from "@/components/ui/rating";
import { cn } from "@/lib/utils";
import type { Testimonial } from "@/types";

/** Reusable review/testimonial card — will render DB reviews later. */
export function ReviewCard({
  review,
  className,
}: {
  review: Testimonial;
  className?: string;
}) {
  return (
    <figure
      className={cn(
        "flex flex-col gap-5 rounded-card border-[1.5px] border-ink bg-cream p-6 sm:p-8",
        className,
      )}
    >
      <div className="flex items-center justify-between">
        <Rating value={review.rating} />
        <Quote className="size-5 text-clay" aria-hidden />
      </div>
      <blockquote className="text-base leading-relaxed text-ink/85">“{review.quote}”</blockquote>
      <figcaption className="mt-auto flex items-center justify-between gap-3 border-t border-clay pt-4">
        <div>
          <p className="font-display text-sm font-bold uppercase">{review.name}</p>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-smoke">{review.location}</p>
        </div>
        <Badge variant="soft" className="text-[9px]">
          {review.productLabel}
        </Badge>
      </figcaption>
    </figure>
  );
}
