import Link from "next/link";
import { ArrowDown, ArrowRight } from "lucide-react";
import { HeroVisual } from "@/components/home/hero-visual";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { storefrontContent } from "@/content/storefront";
import { safeHref } from "@/lib/safe-url";

/** Homepage hero. Server-rendered; tracking is a data attribute, not a client island. */
export function Hero() {
  const hero = storefrontContent.hero;
  const primary = safeHref(hero.primaryCta.href);
  const secondary = safeHref(hero.secondaryCta.href);

  return (
    <section className="relative overflow-hidden border-b-[1.5px] border-ink" aria-labelledby="home-hero-title">
      <span
        aria-hidden
        className="pointer-events-none absolute -bottom-4 left-1/2 hidden -translate-x-1/2 select-none whitespace-nowrap font-display text-[18vw] font-extrabold uppercase leading-none text-transparent opacity-[0.05] sm:block"
        style={{ WebkitTextStroke: "1.5px var(--color-ink)" }}
      >
        Inkline
      </span>

      <div className="mx-auto grid w-full max-w-[90rem] grid-cols-1 items-center gap-10 px-5 pb-14 pt-8 sm:px-8 sm:pb-16 sm:pt-12 lg:grid-cols-12 lg:gap-8 lg:px-12 lg:pb-20 lg:pt-16">
        <div className="relative z-10 flex flex-col justify-center lg:col-span-7">
          <Badge variant="soft">{hero.eyebrow}</Badge>

          <h1
            id="home-hero-title"
            className="mt-5 font-display text-[2.55rem] font-extrabold uppercase leading-[0.9] tracking-tight text-ink min-[380px]:text-5xl sm:text-6xl lg:text-7xl xl:text-8xl"
          >
            {hero.headline[0]}
            <br />
            <span className="text-transparent" style={{ WebkitTextStroke: "1.5px var(--color-ink)" }}>
              {hero.headline[1]}
            </span>
            <span className="text-flame">.</span>
          </h1>

          <p className="mt-5 max-w-xl text-base leading-relaxed text-smoke sm:text-lg">{hero.supporting}</p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <Button asChild size="lg" variant="primary" className="w-full sm:w-auto">
              <Link
                href={primary}
                data-track={hero.primaryCta.event}
                data-track-label={hero.primaryCta.label}
              >
                {hero.primaryCta.label}
                <ArrowRight className="size-4" aria-hidden />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="w-full sm:w-auto">
              <Link
                href={secondary}
                data-track={hero.secondaryCta.event}
                data-track-label={hero.secondaryCta.label}
              >
                {hero.secondaryCta.label}
                <ArrowDown className="size-4" aria-hidden />
              </Link>
            </Button>
          </div>

          <ul className="mt-8 flex flex-wrap gap-x-4 gap-y-2 font-mono text-[10px] uppercase tracking-[0.16em] text-smoke">
            {hero.notes.map((item) => (
              <li key={item} className="flex items-center gap-1.5">
                <span className="text-flame" aria-hidden>
                  ✳
                </span>
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div className="relative z-10 lg:col-span-5">
          <HeroVisual visuals={hero.visuals} />
        </div>
      </div>
    </section>
  );
}
