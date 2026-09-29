import Image from "next/image";
import { Section, SectionHeader } from "@/components/layout/section";
import { StorefrontGlyph } from "@/components/storefront/icon";
import { storefrontContent } from "@/content/storefront";

export function HowItWorks() {
  const copy = storefrontContent.howItWorks;

  return (
    <Section id="how-it-works" className="bg-ink text-paper">
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-12 lg:gap-8">
        <div className="lg:col-span-5">
          <SectionHeader
            tone="paper"
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
          <div className="relative aspect-[4/3] overflow-hidden rounded-3xl border-[1.5px] border-paper/20">
            <Image
              src={copy.image.src}
              alt={copy.image.alt}
              fill
              sizes="(max-width: 1024px) 100vw, 40vw"
              className="object-cover"
            />
          </div>
        </div>

        <ol className="flex flex-col justify-center gap-4 lg:col-span-7 lg:pl-6">
          {copy.steps.map((step) => (
            <li
              key={step.step}
              className="relative flex gap-4 rounded-3xl border-[1.5px] border-paper/20 p-5 transition-colors duration-300 hover:border-flame sm:p-6"
            >
              <span className="flex size-11 shrink-0 items-center justify-center rounded-pill border-[1.5px] border-paper/30 text-flame">
                <StorefrontGlyph name={step.icon} className="size-5" />
              </span>
              <div>
                <p className="font-mono text-[10px] tracking-[0.2em] text-flame">{step.step}</p>
                <h3 className="mt-1 font-display text-2xl font-extrabold uppercase leading-tight">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-paper/70">{step.description}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Section>
  );
}
