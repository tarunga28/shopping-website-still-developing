import { jsonLdScript } from "@/lib/plain-text";

/** Structured data. Callers must pass already-sanitized objects — never raw HTML. */
export function JsonLd({ data }: { data: unknown }) {
  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(data) }} />
  );
}
