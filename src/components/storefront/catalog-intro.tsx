import Image from "next/image";
import { Breadcrumbs, type Crumb } from "@/components/ui/breadcrumbs";
import { Container } from "@/components/ui/container";

export function CatalogIntro({
  eyebrow,
  title,
  description,
  crumbs,
  image,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  crumbs: Crumb[];
  /** Optional banner (category/collection hero). Already validated as a safe src upstream. */
  image?: { src: string; alt: string } | null;
}) {
  return (
    <section className="border-b-[1.5px] border-ink bg-cream">
      <Container className={image ? "grid items-center gap-8 py-10 md:grid-cols-[1fr_minmax(0,22rem)] md:py-16" : "py-10 md:py-16"}>
        <div>
        <Breadcrumbs items={crumbs} />
        {eyebrow ? (
          <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.22em] text-smoke">{eyebrow}</p>
        ) : null}
        <h1 className="mt-3 max-w-4xl font-display text-4xl font-extrabold uppercase leading-[0.95] tracking-tight sm:text-6xl">
          {title}
          <span className="text-flame">.</span>
        </h1>
        {description ? <p className="mt-4 max-w-xl text-base leading-relaxed text-smoke">{description}</p> : null}
        </div>
        {image ? (
          <div className="relative aspect-[4/3] overflow-hidden rounded-card border-[1.5px] border-ink bg-sand">
            <Image src={image.src} alt={image.alt} fill priority sizes="(max-width: 768px) 100vw, 352px" className="object-cover" />
          </div>
        ) : null}
      </Container>
    </section>
  );
}
