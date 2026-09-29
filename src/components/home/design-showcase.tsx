import Image from "next/image";
import { Section, SectionHeader } from "@/components/layout/section";
import { storefrontContent } from "@/content/storefront";

/**
 * Artwork gallery. Capped and lazy-loaded — it does not request a large set
 * on first paint, and it is not presented as customer photography.
 */
export function DesignShowcase() {
  const copy = storefrontContent.showcase;
  const items = copy.items.slice(0, copy.limit);

  if (items.length === 0) return null;

  return (
    <Section id="designs">
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

      <ul className="columns-1 gap-4 sm:columns-2 lg:columns-3">
        {items.map((item, index) => (
          <li key={item.id} className="mb-4 break-inside-avoid">
            <figure className="overflow-hidden rounded-card border-[1.5px] border-ink bg-sand">
              <div className={index % 3 === 0 ? "relative aspect-[4/5]" : "relative aspect-[5/4]"}>
                <Image
                  src={item.src}
                  alt={item.alt}
                  fill
                  sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                  className="object-cover"
                />
              </div>
              <figcaption className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-smoke">{item.caption}</span>
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-smoke/70">{item.kind}</span>
              </figcaption>
            </figure>
          </li>
        ))}
      </ul>
    </Section>
  );
}
