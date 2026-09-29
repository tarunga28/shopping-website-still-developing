import type { Metadata } from "next";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { Container } from "@/components/ui/container";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { faqGroups } from "@/config/faqs";
import { siteConfig } from "@/config/site";
import { buildMetadata } from "@/lib/seo";

export const metadata: Metadata = buildMetadata({
  title: "FAQs",
  description: "Answers about print-on-demand production, shipping, print quality and payments at Inkline.",
  path: "/faqs",
});

export default function FaqsPage() {
  return (
    <Container width="narrow" className="py-16 md:py-24">
      <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "FAQs" }]} />

      <h1 className="mt-8 font-display text-4xl font-extrabold uppercase leading-[0.95] tracking-tight sm:text-6xl">
        Questions,
        <br />
        answered<span className="text-flame">.</span>
      </h1>
      <p className="mt-5 text-base leading-relaxed text-smoke">
        Everything about how print-on-demand works at {siteConfig.name}. Can&apos;t find what
        you need?{" "}
        <a
          href={`mailto:${siteConfig.contact.supportEmail}`}
          className="font-semibold text-ink underline decoration-flame decoration-2 underline-offset-2 hover:text-flame"
        >
          Email us anytime
        </a>
        .
      </p>

      <div className="mt-12 space-y-12">
        {faqGroups.map((group) => (
          <section key={group.title} aria-labelledby={`faq-${group.title.replace(/\W+/g, "-").toLowerCase()}`}>
            <h2
              id={`faq-${group.title.replace(/\W+/g, "-").toLowerCase()}`}
              className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-flame"
            >
              {group.title}
            </h2>
            <Accordion type="single" collapsible className="mt-4 rounded-card border-[1.5px] border-clay bg-cream px-6">
              {group.faqs.map((faq, index) => (
                <AccordionItem key={faq.question} value={`${group.title}-${index}`}>
                  <AccordionTrigger>{faq.question}</AccordionTrigger>
                  <AccordionContent>{faq.answer}</AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </section>
        ))}
      </div>

      <div className="mt-14 flex flex-col items-center gap-4 rounded-panel border-[1.5px] border-ink bg-cream px-6 py-10 text-center">
        <h2 className="font-display text-2xl font-extrabold uppercase tracking-tight">
          Still curious<span className="text-flame">?</span>
        </h2>
        <p className="max-w-md text-sm leading-relaxed text-smoke">
          Our support team replies within two business days — usually much faster.
        </p>
        <Button asChild variant="primary" size="lg">
          <a href={`mailto:${siteConfig.contact.supportEmail}`}>Contact support</a>
        </Button>
      </div>
    </Container>
  );
}
