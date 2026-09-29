import Image from "next/image";
import { ArrowUpRight } from "lucide-react";
import { Section } from "@/components/layout/section";
import { InstagramIcon } from "@/components/ui/social-icons";
import { siteConfig } from "@/config/site";

const frames = [
  { src: "/images/studio.jpg", caption: "Ink mixing, batch 07" },
  { src: "/images/products/tee.jpg", caption: "Fresh off the flash dryer" },
  { src: "/images/hero.jpg", caption: "Drop 001 lookbook" },
  { src: "/images/products/hoodie.jpg", caption: "Fleece season loading" },
  { src: "/images/products/poster.jpg", caption: "Gallery proofs" },
  { src: "/images/products/tote.jpg", caption: "Canvas runs" },
];

/** Horizontal scroll strip — social/behind-the-scenes preview. */
export function StudioStrip() {
  return (
    <Section className="pb-8 pt-0 md:pb-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-smoke">
            From the studio floor
          </p>
          <h2 className="mt-2 font-display text-3xl font-extrabold uppercase tracking-tight sm:text-4xl">
            Behind the ink<span className="text-flame">.</span>
          </h2>
        </div>
        <a
          href={siteConfig.social.instagram}
          target="_blank"
          rel="noopener noreferrer"
          className="group inline-flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-ink transition-colors hover:text-flame"
        >
          <InstagramIcon className="size-4" />
          Follow @inkline.in
          <ArrowUpRight className="size-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden />
        </a>
      </div>

      <div className="-mx-5 mt-8 overflow-x-auto px-5 pb-2 sm:-mx-8 sm:px-8 lg:-mx-12 lg:px-12 [scrollbar-width:thin]">
        <ul className="flex w-max gap-4">
          {frames.map((frame, index) => (
            <li key={frame.caption} className="group w-52 shrink-0 sm:w-60">
              <div className="relative aspect-[4/5] overflow-hidden rounded-2xl border-[1.5px] border-ink bg-sand">
                <Image
                  src={frame.src}
                  alt={frame.caption}
                  fill
                  sizes="240px"
                  className="object-cover transition-transform duration-700 group-hover:scale-[1.06]"
                />
              </div>
              <p className="mt-2 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.18em] text-smoke">
                <span className="text-flame">0{index + 1}</span> {frame.caption}
              </p>
            </li>
          ))}
          <li className="flex w-52 shrink-0 items-center justify-center rounded-2xl border-[1.5px] border-dashed border-clay sm:w-60">
            <a
              href={siteConfig.social.instagram}
              target="_blank"
              rel="noopener noreferrer"
              className="flex flex-col items-center gap-2 p-6 text-center text-smoke transition-colors hover:text-flame"
            >
              <InstagramIcon className="size-6" />
              <span className="font-mono text-[10px] uppercase tracking-[0.18em]">
                More on Instagram
              </span>
            </a>
          </li>
        </ul>
      </div>
    </Section>
  );
}
