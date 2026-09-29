/** Canonical public paths. Slugs only — no database ids. */

export function categoryPath(slug: string): string {
  return `/category/${slug}`;
}

export function collectionPath(slug: string): string {
  return `/collection/${slug}`;
}

export function productPath(slug: string): string {
  return `/product/${slug}`;
}

export function searchPath(query?: string): string {
  if (!query) return "/search";
  return `/search?q=${encodeURIComponent(query)}`;
}

export function loginPath(redirectTo?: string): string {
  if (!redirectTo) return "/login";
  return `/login?redirect=${encodeURIComponent(redirectTo)}`;
}
