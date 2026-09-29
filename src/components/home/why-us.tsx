import { Leaf, Palette, ShieldCheck, Truck } from "lucide-react";
import { Section, SectionHeader } from "@/components/layout/section";

const pillars = [
  {
    icon: Palette,
    title: "Artist-first originals",
    description:
      "Every design starts as real artwork from independent creators — not stock graphics scraped from the internet.",
  },
  {
    icon: Leaf,
    title: "Zero waste by design",
    description:
      "Print-on-demand means we make exactly what's ordered. No overstock, no clearance sales, no landfill fashion.",
  },
  {
    icon: ShieldCheck,
    title: "Premium blanks & inks",
    description:
      "Heavyweight cotton, museum-grade paper and eco-safer inks, quality-checked piece by piece before packing.",
  },
  {
    icon: Truck,
    title: "Made & shipped from India",
    description:
      "Printed locally and shipped pan-India with tracking — faster delivery and a smaller carbon footprint.",
  },
];

export function WhyUs() {
  return (
    <Section className="bg-cream">
      <SectionHeader
        eyebrow="04 — Why Inkline"
        title={
          <>
            Built different,
            <br />
            printed better<span className="text-flame">.</span>
          </>
        }
      />

      <div className="grid grid-cols-1 overflow-hidden rounded-3xl border-[1.5px] border-ink bg-paper sm:grid-cols-2 lg:grid-cols-4">
        {pillars.map((pillar, index) => (
          <article
            key={pillar.title}
            className={
              "group flex flex-col gap-4 p-6 transition-colors duration-300 hover:bg-flame/10 sm:p-8 " +
              (index > 0 ? "border-ink max-sm:border-t-[1.5px] sm:border-l-[1.5px] " : "") +
              (index > 1 ? "max-lg:border-t-[1.5px] lg:border-t-0 " : "") +
              (index === 2 ? "max-lg:sm:border-l-0" : "")
            }
          >
            <span className="flex size-11 items-center justify-center rounded-full border-[1.5px] border-ink bg-cream transition-colors duration-300 group-hover:bg-flame">
              <pillar.icon className="size-5" aria-hidden />
            </span>
            <h3 className="font-display text-lg font-extrabold uppercase leading-tight">{pillar.title}</h3>
            <p className="text-sm leading-relaxed text-smoke">{pillar.description}</p>
            <span className="mt-auto font-mono text-[10px] tracking-[0.2em] text-smoke/60">
              0{index + 1}
            </span>
          </article>
        ))}
      </div>
    </Section>
  );
}
