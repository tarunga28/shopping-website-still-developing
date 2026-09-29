/**
 * Allow-listed redirect helper — internal paths only.
 * Exported separately so it can be unit-tested without rendering.
 */
export function safeRedirect(candidate: string | undefined | null, fallback = "/"): string {
  if (!candidate) return fallback;
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("://")) {
    return fallback;
  }
  return candidate.slice(0, 200);
}
