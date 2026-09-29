import { Breadcrumbs, type Crumb } from "@/components/ui/breadcrumbs";
import { Container } from "@/components/ui/container";

export function CatalogIntro({
  eyebrow,
  title,
  description,
  crumbs,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  crumbs: Crumb[];
}) {
  return (
    <section className="border-b-[1.5px] border-ink bg-cream">
      <Container className="py-10 md:py-16">
        <Breadcrumbs items={crumbs} />
        {eyebrow ? (
          <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.22em] text-smoke">{eyebrow}</p>
        ) : null}
        <h1 className="mt-3 max-w-4xl font-display text-4xl font-extrabold uppercase leading-[0.95] tracking-tight sm:text-6xl">
          {title}
          <span className="text-flame">.</span>
        </h1>
        {description ? <p className="mt-4 max-w-xl text-base leading-relaxed text-smoke">{description}</p> : null}
      </Container>
    </section>
  );
}
