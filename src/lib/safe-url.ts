/**
 * Allow-list for storefront links.
 * Relative paths stay on-site. External links must be https.
 * Rejects protocol-relative URLs, javascript:, data: and open redirects.
 */

const MAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isSafeImageSrc(src: string | null | undefined): src is string {
  if (!src) return false;
  if (src.startsWith("/") && !src.startsWith("//") && !src.includes("\\") && !src.includes("://")) {
    return true;
  }
  try {
    const url = new URL(src);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

export function safeHref(href: string | null | undefined, fallback = "/"): string {
  if (!href) return fallback;
  const value = href.trim();

  if (value.startsWith("mailto:")) {
    const address = value.slice("mailto:".length).split("?")[0] ?? "";
    return MAIL.test(address) ? value : fallback;
  }

  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") && !value.includes("://")) {
    return value.slice(0, 300);
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return fallback;
    if (!url.hostname || url.username || url.password) return fallback;
    return url.toString();
  } catch {
    return fallback;
  }
}

export function isExternalHref(href: string): boolean {
  return href.startsWith("https://") || href.startsWith("mailto:");
}
