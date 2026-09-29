import { notFound, redirect } from "next/navigation";
import { parsePublicSlug } from "@/lib/slug";

/** Validate a public slug and canonicalize case. Throws via notFound/redirect. */
export function resolveSlug(raw: string, basePath: string): string {
  const parsed = parsePublicSlug(raw);
  if (!parsed.slug) notFound();
  if (parsed.redirectToLower) redirect(`${basePath}/${parsed.slug}`);
  return parsed.slug;
}
