import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Section } from "@/components/layout/section";
import type { PromoBanner as PromoBannerModel } from "@/content/storefront";
import { isScheduleActive } from "@/lib/schedule";
import { safeHref } from "@/lib/safe-url";

/**
 * Scheduled promotional banner. Renders nothing when inactive or outside
 * its window. No countdown — a timer would need a real configured end.
 */
export function PromoBanner({ banner, now = new Date() }: { banner: PromoBannerModel; now?: Date }) {
  if (!isScheduleActive(banner, now)) return null;
  const href = safeHref(banner.href);

  return (
    <Section className="py-6 md:py-8" aria-label={banner.title}>
      <div className="grid items-center gap-6 overflow-hidden rounded-panel border-[1.5px] border-ink bg-cream md:grid-cols-[1.1fr_0.9fr]">
        <div className="px-6 py-8 sm:px-10">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-smoke">{banner.kind}</p>
          <h2 className="mt-3 font-display text-3xl font-extrabold uppercase leading-[0.95] sm:text-4xl">
            {banner.title}
          </h2>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-smoke">{banner.description}</p>
          <Link
            href={href}
            className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-pill border-[1.5px] border-ink bg-ink px-5 text-[11px] font-semibold uppercase tracking-[0.14em] text-paper transition-colors hover:bg-flame hover:text-on-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame"
          >
            {banner.ctaLabel}
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
        {banner.image ? (
          <div className="relative min-h-48 md:min-h-full">
            <Image
              src={banner.image.src}
              alt={banner.image.alt}
              fill
              sizes="(max-width: 768px) 100vw, 40vw"
              className="object-cover"
            />
          </div>
        ) : null}
      </div>
    </Section>
  );
}

export function PromoBanners({
  banners,
  placement,
  now = new Date(),
}: {
  banners: readonly PromoBannerModel[];
  placement: PromoBannerModel["placement"];
  now?: Date;
}) {
  const active = banners.filter((banner) => banner.placement === placement && isScheduleActive(banner, now));
  if (active.length === 0) return null;
  return (
    <>
      {active.map((banner) => (
        <PromoBanner key={banner.id} banner={banner} now={now} />
      ))}
    </>
  );
}
