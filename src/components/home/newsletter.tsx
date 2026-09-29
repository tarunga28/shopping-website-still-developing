import Link from "next/link";
import { NewsletterForm } from "@/components/brand/newsletter-form";
import { Section } from "@/components/layout/section";
import { storefrontContent } from "@/content/storefront";

export function Newsletter() {
  const copy = storefrontContent.newsletter;

  return (
    <Section id="newsletter" className="py-12 md:py-16">
      <div className="relative overflow-hidden rounded-[2rem] border-[1.5px] border-ink bg-flame px-6 py-12 sm:px-10 md:px-16 md:py-16">
        <span
          aria-hidden
          className="pointer-events-none absolute -right-6 -top-10 select-none font-display text-[12rem] font-extrabold leading-none text-ink/10 sm:text-[16rem]"
        >
          ✳
        </span>
        <div className="relative grid grid-cols-1 items-center gap-8 lg:grid-cols-2">
          <div>
            <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-ink/70">{copy.eyebrow}</p>
            <h2 className="mt-3 font-display text-4xl font-extrabold uppercase leading-[0.95] tracking-tight text-ink sm:text-5xl">
              {copy.titleLead}
              <br />
              {copy.titleAccent}
              <span aria-hidden>.</span>
            </h2>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-ink/80 sm:text-base">{copy.description}</p>
            <Link href={copy.privacyHref} className="mt-3 inline-block text-xs text-ink underline decoration-ink/40 underline-offset-4">
              Privacy policy
            </Link>
          </div>
          <NewsletterForm source="homepage" tone="flame" />
        </div>
      </div>
    </Section>
  );
}
