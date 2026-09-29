/** Public storefront slugs and search queries. Never reflect raw input into HTML. */

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parsePublicSlug(value: string): { slug: string | null; redirectToLower: boolean } {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return { slug: null, redirectToLower: false };
  }

  const trimmed = decoded.trim();
  if (!trimmed || trimmed.length > 80 || trimmed.includes("/") || trimmed.includes("\\")) {
    return { slug: null, redirectToLower: false };
  }

  const lower = trimmed.toLowerCase();
  if (!SLUG.test(lower)) return { slug: null, redirectToLower: false };
  return { slug: lower, redirectToLower: trimmed !== lower };
}

export function sanitizeSearchQuery(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/** Strip LIKE wildcards so a query cannot widen into a full-table scan pattern. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "");
}
