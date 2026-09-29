import { ReviewCard } from "@/components/cards/review-card";
import { Section, SectionHeader } from "@/components/layout/section";
import { Badge } from "@/components/ui/badge";
import { sampleTestimonials } from "@/lib/placeholder-data";

/**
 * Social proof — UI system for future verified reviews.
 * Currently renders clearly-labeled demo styling content.
 */
export function Testimonials() {
  return (
    <Section id="reviews">
      <div className="flex flex-col items-center gap-3">
        <Badge variant="soft">Demo content — real reviews arrive with the store</Badge>
      </div>
      <SectionHeader
        eyebrow="05 — Worn by real people"
        align="center"
        title={
          <>
            Early ink,
            <br />
            honest words<span className="text-flame">.</span>
          </>
        }
        description="Design preview of the review system. Verified customer reviews launch together with the store."
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3 md:gap-5">
        {sampleTestimonials.map((testimonial, index) => (
          <ReviewCard
            key={testimonial.id}
            review={testimonial}
            className={
              index === 1
                ? "md:-translate-y-4 md:rotate-[0.5deg]"
                : index === 2
                  ? "md:rotate-[-0.5deg]"
                  : ""
            }
          />
        ))}
      </div>
    </Section>
  );
}
