import Image from "next/image";
import { Section, SectionHeader } from "@/components/layout/section";
import { howItWorksSteps } from "@/lib/placeholder-data";
import type { HowItWorksStep } from "@/types";

function StepCard({ step, tone }: { step: HowItWorksStep; tone: number }) {
  return (
    <article className="relative flex flex-col gap-4 rounded-3xl border-[1.5px] border-paper/20 p-6 transition-colors duration-300 hover:border-flame sm:p-8">
      <span className="font-mono text-xs tracking-[0.2em] text-flame">{step.step}</span>
      <h3 className="font-display text-2xl font-extrabold uppercase leading-tight sm:text-3xl">
        {step.title}
      </h3>
      <p className="text-sm leading-relaxed text-paper/65">{step.description}</p>
      <span
        aria-hidden
        className="pointer-events-none absolute -top-5 right-4 font-display text-8xl font-extrabold leading-none text-transparent opacity-30"
        style={{ WebkitTextStroke: "1px var(--color-paper)" }}
      >
        {tone + 1}
      </span>
    </article>
  );
}

export function HowItWorks() {
  return (
    <Section id="how-it-works" className="bg-ink text-paper">
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-12 lg:gap-8">
        <div className="lg:col-span-5">
          <SectionHeader
            tone="paper"
            eyebrow="02 — How print-on-demand works"
            title={
              <>
                Made after
                <br />
                you order<span className="text-flame">.</span>
              </>
            }
            description="Traditional retail prints thousands of pieces and hopes they sell. We do the opposite: your order triggers the print. Better for artists, better for the planet, fresher for you."
          />
          <div className="relative aspect-[4/3] overflow-hidden rounded-3xl border-[1.5px] border-paper/20">
            <Image
              src="/images/studio.jpg"
              alt="Inside the Inkline print studio — screen printing fresh artwork"
              fill
              sizes="(max-width: 1024px) 100vw, 40vw"
              className="object-cover"
            />
            <span className="absolute bottom-3 left-3 rounded-full bg-ink/80 px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-paper backdrop-blur">
              Print floor · Batch 07
            </span>
          </div>
        </div>

        <div className="flex flex-col justify-center gap-4 lg:col-span-7 lg:pl-6">
          {howItWorksSteps.map((step, index) => (
            <StepCard key={step.step} step={step} tone={index} />
          ))}
          <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-paper/45">
            Zero warehouses · Zero overstock · Zero landfill fashion
          </p>
        </div>
      </div>
    </Section>
  );
}
