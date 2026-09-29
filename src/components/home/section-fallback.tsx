import { Section, SectionHeader } from "@/components/layout/section";

/** Independent section failure. The rest of the page keeps rendering. */
export function SectionFallback({
  id,
  title = "This section didn't load",
  description = "The rest of the page is still here. Refresh to try this section again.",
}: {
  id?: string;
  title?: string;
  description?: string;
}) {
  return (
    <Section id={id}>
      <SectionHeader eyebrow="Temporarily unavailable" title={title} description={description} />
    </Section>
  );
}
