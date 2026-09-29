import { Asterisk } from "lucide-react";
import type { LegalDocument } from "@/config/legal-content";

/** Shared layout for policy pages — semantic, readable, print-friendly. */
export function LegalPage({ doc }: { doc: LegalDocument }) {
  return (
    <article className="px-5 py-16 sm:px-8 md:py-24 lg:px-12">
      <div className="mx-auto max-w-3xl">
        <p className="flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-flame">
          <Asterisk className="size-3.5" aria-hidden />
          Legal
        </p>
        <h1 className="mt-4 font-display text-4xl font-extrabold uppercase leading-[0.95] tracking-tight sm:text-5xl">
          {doc.title}
          <span className="text-flame">.</span>
        </h1>
        <p className="mt-4 max-w-xl text-base leading-relaxed text-smoke">{doc.summary}</p>
        <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.18em] text-smoke/70">
          Last updated: January 2026
        </p>

        <div className="mt-12 space-y-10 border-t-[1.5px] border-ink pt-10">
          {doc.sections.map((section, index) => (
            <section key={section.heading} aria-labelledby={`legal-${index}`}>
              <h2
                id={`legal-${index}`}
                className="flex items-baseline gap-3 font-display text-xl font-extrabold uppercase tracking-tight"
              >
                <span className="font-mono text-xs font-normal text-flame">0{index + 1}</span>
                {section.heading}
              </h2>
              <div className="mt-4 space-y-4 pl-7 text-[15px] leading-relaxed text-ink/80">
                {section.paragraphs.map((paragraph, pIndex) => (
                  <p key={pIndex}>{paragraph}</p>
                ))}
              </div>
            </section>
          ))}
        </div>

        <p className="mt-12 rounded-2xl border-[1.5px] border-clay bg-cream p-5 text-sm leading-relaxed text-smoke">
          Questions about this policy? Write to{" "}
          <a href="mailto:support@inkline.in" className="font-semibold text-ink underline decoration-flame decoration-2 underline-offset-2 hover:text-flame">
            support@inkline.in
          </a>{" "}
          and we&apos;ll get back to you within two business days.
        </p>
      </div>
    </article>
  );
}
