import { Section, SectionHeader } from "@/components/layout/section";
import { StorefrontGlyph } from "@/components/storefront/icon";
import { storefrontContent } from "@/content/storefront";

export function WhyUs() {
  const copy = storefrontContent.whyUs;

  return (
    <Section id="why-us" className="bg-cream">
      <SectionHeader
        eyebrow={copy.eyebrow}
        title={
          <>
            {copy.titleLead}
            <br />
            {copy.titleAccent}
            <span className="text-flame">.</span>
          </>
        }
        description={copy.description}
      />

      <ul className="grid grid-cols-1 overflow-hidden rounded-3xl border-[1.5px] border-ink bg-paper sm:grid-cols-2 lg:grid-cols-4">
        {copy.pillars.map((pillar, index) => (
          <li
            key={pillar.title}
            className={
              "flex flex-col gap-4 p-6 sm:p-8 " +
              (index > 0 ? "border-ink max-sm:border-t-[1.5px] sm:border-l-[1.5px] " : "") +
              (index > 1 ? "max-lg:border-t-[1.5px] lg:border-t-0 " : "")
            }
          >
            <span className="flex size-11 items-center justify-center rounded-full border-[1.5px] border-ink bg-cream">
              <StorefrontGlyph name={pillar.icon} className="size-5" />
            </span>
            <h3 className="font-display text-lg font-extrabold uppercase leading-tight">{pillar.title}</h3>
            <p className="text-sm leading-relaxed text-smoke">{pillar.description}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
