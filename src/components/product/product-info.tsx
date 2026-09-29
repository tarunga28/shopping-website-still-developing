import Link from "next/link";
import { Mail, Printer } from "lucide-react";
import type { ReactNode } from "react";
import { siteConfig } from "@/config/site";
import type { PdpProductDTO } from "@/lib/catalog/pdp-dto";

/**
 * Long-form product content. Server-rendered: there is no JS here. Every
 * section renders only when real data exists, and every string is rendered
 * as a text node (never as HTML).
 */

function Section({ id, title, open = false, children }: { id: string; title: string; open?: boolean; children: ReactNode }) {
  return (
    <details open={open} className="group border-t-[1.5px] border-clay py-4 last:border-b-[1.5px]" id={id}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-md font-display text-lg font-extrabold uppercase focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame [&::-webkit-details-marker]:hidden">
        <h2 className="text-lg">{title}</h2>
        <span aria-hidden className="font-mono text-xl leading-none transition-transform group-open:rotate-45">+</span>
      </summary>
      <div className="pt-4 text-sm leading-relaxed text-smoke">{children}</div>
    </details>
  );
}

export function ProductInfoSections({ product }: { product: PdpProductDTO }) {
  const { details } = product;
  const paragraphs = product.description ? product.description.split("\n\n") : [];
  const hasSpecs = Boolean(details.materials || details.fit || details.printDetails || details.specs.length > 0);
  const shipping = siteConfig.commerce.shipping;
  const shippingFacts = [
    shipping.processingTime ? ["Production", shipping.processingTime] : null,
    shipping.deliveryEstimate ? ["Delivery", shipping.deliveryEstimate] : null,
    shipping.regions ? ["Ships to", shipping.regions] : null,
  ].filter((row): row is string[] => row !== null);

  return (
    <div className="mt-10" data-testid="product-info">
      {paragraphs.length > 0 || details.features.length > 0 ? (
        <Section id="description" title="Description" open>
          <div className="space-y-3">
            {paragraphs.map((paragraph, index) => (
              <p key={index} className="max-w-prose whitespace-pre-line [overflow-wrap:anywhere]">
                {paragraph}
              </p>
            ))}
          </div>
          {details.features.length > 0 ? (
            <ul className="mt-4 list-disc space-y-1.5 pl-5 marker:text-flame">
              {details.features.map((feature, index) => (
                <li key={index}>{feature}</li>
              ))}
            </ul>
          ) : null}
        </Section>
      ) : null}

      {hasSpecs ? (
        <Section id="details" title="Product details">
          <dl className="divide-y divide-clay/70 rounded-xl border-[1.5px] border-clay bg-white/40">
            {details.materials ? <Row label="Materials" value={details.materials} /> : null}
            {details.fit ? <Row label="Fit" value={details.fit} /> : null}
            {details.printDetails ? <Row label="Print" value={details.printDetails} /> : null}
            {details.specs.map((spec, index) => (
              <Row key={`${spec.label}-${index}`} label={spec.label} value={spec.value} />
            ))}
          </dl>
        </Section>
      ) : null}

      {details.care.length > 0 ? (
        <Section id="care" title="Care">
          <ul className="list-disc space-y-1.5 pl-5 marker:text-flame">
            {details.care.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      {product.designs.length > 0 ? (
        <Section id="design" title="The design">
          <ul className="space-y-2">
            {product.designs.map((design, index) => (
              <li key={`${design.name}-${index}`}>
                <span className="font-semibold text-ink [overflow-wrap:anywhere]">{design.name}</span>
                <span> · {design.placements.join(", ")}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section id="shipping" title="Shipping & returns">
        <p>
          <Printer className="mr-2 inline size-4 align-text-bottom text-ink" aria-hidden />
          Every piece is printed after you order it.
        </p>
        {shippingFacts.length > 0 ? (
          <dl className="mt-3 divide-y divide-clay/70 rounded-xl border-[1.5px] border-clay bg-white/40">
            {shippingFacts.map(([label, value]) => (
              <Row key={label} label={label!} value={value!} />
            ))}
          </dl>
        ) : null}
        <p className="mt-3">
          Read our{" "}
          <Link href="/legal/shipping" className="font-semibold text-ink underline decoration-flame decoration-2 underline-offset-4">
            shipping &amp; delivery policy
          </Link>{" "}
          and{" "}
          <Link href="/legal/refunds" className="font-semibold text-ink underline decoration-flame decoration-2 underline-offset-4">
            returns &amp; refunds policy
          </Link>
          .
        </p>
      </Section>

      <TrustNote />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[minmax(6rem,9rem)_1fr] gap-3 px-4 py-2.5">
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-smoke">{label}</dt>
      <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}

/** Restrained trust note: facts that are true today, and ways to reach a person. */
function TrustNote() {
  return (
    <p className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-relaxed text-smoke">
      <Mail className="size-3.5 shrink-0" aria-hidden />
      <span>Questions about this product?</span>
      <a
        href={`mailto:${siteConfig.contact.supportEmail}`}
        className="font-semibold text-ink underline decoration-flame decoration-2 underline-offset-4"
      >
        Email support
      </a>
    </p>
  );
}
