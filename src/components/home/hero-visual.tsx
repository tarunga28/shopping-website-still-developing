import Image from "next/image";
import type { HeroVisualAsset } from "@/content/storefront";

/**
 * Responsive hero composition.
 * Desktop: primary + secondary + accent.
 * Tablet: primary + accent, secondary tucked in.
 * Mobile: primary with a small accent card — no full-bleed background image.
 */
export function HeroVisual({ visuals }: { visuals: readonly HeroVisualAsset[] }) {
  const primary = visuals.find((visual) => visual.slot === "primary");
  const secondary = visuals.find((visual) => visual.slot === "secondary");
  const accent = visuals.find((visual) => visual.slot === "accent");
  if (!primary) return null;

  return (
    <div className="relative mx-auto w-full max-w-[22rem] sm:max-w-md lg:max-w-none">
      <div
        className="pointer-events-none absolute -left-2 top-4 hidden size-24 animate-[spin_18s_linear_infinite] motion-reduce:animate-none md:block lg:-left-6 lg:size-28"
        aria-hidden
      >
        <svg viewBox="0 0 100 100" className="h-full w-full">
          <circle cx="50" cy="50" r="50" className="fill-flame" />
          <path id="stamp-circle" d="M 50,50 m -36,0 a 36,36 0 1,1 72,0 a 36,36 0 1,1 -72,0" fill="none" />
          <text className="fill-ink font-mono text-[8px] font-semibold uppercase tracking-[0.18em]">
            <textPath href="#stamp-circle">Printed after you order · Inkline · </textPath>
          </text>
        </svg>
      </div>

      <div className="relative aspect-[4/5] overflow-hidden rounded-b-[1.75rem] rounded-t-[2.5rem] border-[1.5px] border-ink bg-sand shadow-[6px_6px_0_0_var(--color-flame)] sm:rounded-t-[999px] sm:shadow-[10px_10px_0_0_var(--color-flame)]">
        <Image
          src={primary.src}
          alt={primary.alt}
          fill
          priority
          sizes="(max-width: 640px) 88vw, (max-width: 1024px) 42vw, 32vw"
          className="object-cover object-[center_28%] sm:object-center"
        />
      </div>

      {secondary ? (
        <figure className="absolute -left-2 bottom-8 hidden w-[42%] overflow-hidden rounded-2xl border-[1.5px] border-ink bg-sand shadow-hard-sm md:block lg:-left-10 lg:w-[46%]">
          <div className="relative aspect-[3/4]">
            <Image src={secondary.src} alt={secondary.alt} fill sizes="(max-width: 1280px) 18vw, 220px" className="object-cover" />
          </div>
        </figure>
      ) : null}

      {accent ? (
        <figure className="absolute -right-2 bottom-10 w-[38%] overflow-hidden rounded-2xl border-[1.5px] border-ink bg-paper shadow-hard-sm sm:-right-4 sm:bottom-16 sm:w-[34%] lg:-right-8 lg:w-[40%]">
          <div className="relative aspect-square">
            <Image
              src={accent.src}
              alt={accent.alt}
              fill
              sizes="(max-width: 640px) 32vw, 180px"
              className="object-cover"
            />
          </div>
        </figure>
      ) : null}
    </div>
  );
}
