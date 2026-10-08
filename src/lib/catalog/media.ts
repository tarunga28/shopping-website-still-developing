/**
 * Media architecture — pure rules for product/variant/category media.
 *
 * Everything here is synchronous and side-effect free, so it is testable without
 * a database and reusable from both the server and the admin UI.
 *
 * The two rules this module exists to enforce:
 *
 * 1. **No local filesystem paths.** Media lives in object storage behind a CDN.
 *    A `url` is either an absolute http(s) URL or a storage key resolved by a
 *    base URL — never `/var/www/...` and never a `file:` URL.
 * 2. **A predictable shape for the storefront.** Gallery, main, thumbnail,
 *    variant, video, and 360 media are all rows in one table; this module turns
 *    them into the fixed shape the PDP and cards expect, so the UI never has to
 *    guess.
 */

import type { MediaKind } from "@/db/schema/enums";

export const MAX_MEDIA_PER_PRODUCT = 40;
export const MAX_MEDIA_PER_VARIANT = 8;
export const MAX_ALT_TEXT_LENGTH = 250;
export const MAX_SPIN_FRAMES = 72;

/** Image roles, mirroring `imageRoleEnum`. */
export const IMAGE_ROLES = [
  "PRIMARY",
  "GALLERY",
  "HOVER",
  "THUMBNAIL",
  "MOBILE",
  "SOCIAL",
] as const;
export type ImageRole = (typeof IMAGE_ROLES)[number];

/** Media kinds, mirroring `mediaKindEnum`. */
export const MEDIA_KINDS: readonly MediaKind[] = ["IMAGE", "VIDEO", "SPIN_360"];

const ABSOLUTE_HTTPS = /^https:\/\/[^\s/?#]+\.[^\s/?#]+/i;
const ABSOLUTE_HTTP = /^http:\/\/[^\s/?#]+\.[^\s/?#]+/i;
/** A storage key: no scheme, no leading slash, no traversal. */
const STORAGE_KEY = /^[a-z0-9][a-z0-9._\-/]{0,511}$/i;

export interface MediaInput {
  url: string;
  storageKey?: string | null;
  thumbnailUrl?: string | null;
  externalUrl?: string | null;
  altText?: string | null;
  mediaKind?: MediaKind | null;
  format?: string | null;
  width?: number | null;
  height?: number | null;
  fileSizeBytes?: number | null;
  durationMs?: number | null;
  frameCount?: number | null;
  role?: ImageRole | null;
  sortOrder?: number | null;
  productId?: string | null;
  variantId?: string | null;
}

export interface NormalizedMedia {
  url: string;
  storageKey: string | null;
  thumbnailUrl: string | null;
  externalUrl: string | null;
  altText: string;
  mediaKind: MediaKind;
  format: string | null;
  width: number | null;
  height: number | null;
  fileSizeBytes: number | null;
  durationMs: number | null;
  frameCount: number | null;
  role: ImageRole;
  sortOrder: number;
  productId: string | null;
  variantId: string | null;
}

export interface MediaValidationIssue {
  field: string;
  code:
    | "missing_url"
    | "invalid_url"
    | "local_path"
    | "invalid_alt_text"
    | "invalid_dimensions"
    | "invalid_size"
    | "invalid_duration"
    | "invalid_frame_count"
    | "missing_thumbnail"
    | "too_many_media";
  message: string;
}

/**
 * Is this a reference to object storage or a CDN, rather than a local file?
 *
 * Rejecting local paths is a security control, not a style preference: a URL
 * that reaches the browser straight from an admin form is a stored-XSS and
 * SSRF vector if `javascript:` or `file:` slips through.
 */
export function isRemoteMediaReference(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (ABSOLUTE_HTTPS.test(trimmed)) return true;
  if (ABSOLUTE_HTTP.test(trimmed)) return true;
  // A bare storage key is acceptable — the caller resolves it against a base
  // URL — but only if it cannot be mistaken for a scheme or a local path.
  if (trimmed.includes("://")) return false;
  if (trimmed.startsWith("/") || trimmed.startsWith("\\")) return false;
  if (trimmed.includes("..")) return false;
  return STORAGE_KEY.test(trimmed);
}

/** Join a storage base URL and a key without doubling or dropping a slash. */
export function resolveMediaUrl(baseUrl: string, keyOrUrl: string): string {
  const trimmed = keyOrUrl.trim();
  if (ABSOLUTE_HTTPS.test(trimmed) || ABSOLUTE_HTTP.test(trimmed)) return trimmed;
  if (!baseUrl) return trimmed;
  const base = baseUrl.replace(/\/+$/, "");
  const key = trimmed.replace(/^\/+/, "");
  return `${base}/${key}`;
}

/** Aspect ratio, or null when dimensions are unknown or degenerate. */
export function aspectRatio(
  width: number | null | undefined,
  height: number | null | undefined,
): number | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  return width / height;
}

export function validateMedia(
  input: MediaInput,
  options: { index?: number } = {},
): MediaValidationIssue[] {
  const issues: MediaValidationIssue[] = [];
  const at = options.index === undefined ? "" : ` [${options.index}]`;
  const kind: MediaKind = input.mediaKind ?? "IMAGE";

  const url = (input.url ?? "").trim();
  if (!url) {
    issues.push({
      field: `url${at}`,
      code: "missing_url",
      message: "Media needs a URL or a storage key.",
    });
  } else if (!isRemoteMediaReference(url)) {
    // Named separately from a malformed URL because the fix differs: this one
    // usually means a local upload path was pasted in.
    const isLocal =
      url.startsWith("/") || url.startsWith("file:") || url.includes("..");
    issues.push({
      field: `url${at}`,
      code: isLocal ? "local_path" : "invalid_url",
      message: isLocal
        ? "Media must be served from object storage or a CDN, not a local path."
        : "Media URL must be an absolute http(s) URL or a storage key.",
    });
  }

  for (const field of ["thumbnailUrl", "externalUrl"] as const) {
    const value = input[field];
    if (!value) continue;
    if (!isRemoteMediaReference(value)) {
      issues.push({
        field: `${field}${at}`,
        code: "invalid_url",
        message: `${field} must be an absolute http(s) URL or a storage key.`,
      });
    }
  }

  const alt = input.altText ?? "";
  if (alt.length > MAX_ALT_TEXT_LENGTH) {
    issues.push({
      field: `altText${at}`,
      code: "invalid_alt_text",
      message: `Alt text must be at most ${MAX_ALT_TEXT_LENGTH} characters.`,
    });
  }

  for (const field of ["width", "height"] as const) {
    const value = input[field];
    if (value === null || value === undefined) continue;
    if (!Number.isInteger(value) || value <= 0 || value > 20000) {
      issues.push({
        field: `${field}${at}`,
        code: "invalid_dimensions",
        message: `${field} must be a whole number between 1 and 20000.`,
      });
    }
  }

  if (
    input.fileSizeBytes !== null &&
    input.fileSizeBytes !== undefined &&
    (!Number.isInteger(input.fileSizeBytes) || input.fileSizeBytes < 0)
  ) {
    issues.push({
      field: `fileSizeBytes${at}`,
      code: "invalid_size",
      message: "fileSizeBytes must be a non-negative whole number.",
    });
  }

  if (
    input.durationMs !== null &&
    input.durationMs !== undefined &&
    (!Number.isInteger(input.durationMs) || input.durationMs < 0)
  ) {
    issues.push({
      field: `durationMs${at}`,
      code: "invalid_duration",
      message: "durationMs must be a non-negative whole number.",
    });
  }

  if (kind === "SPIN_360") {
    const frames = input.frameCount ?? null;
    if (frames === null || !Number.isInteger(frames) || frames < 2 || frames > MAX_SPIN_FRAMES) {
      issues.push({
        field: `frameCount${at}`,
        code: "invalid_frame_count",
        message: `A 360 set needs between 2 and ${MAX_SPIN_FRAMES} frames.`,
      });
    }
  } else if (input.frameCount !== null && input.frameCount !== undefined) {
    issues.push({
      field: `frameCount${at}`,
      code: "invalid_frame_count",
      message: "frameCount only applies to 360 media.",
    });
  }

  if (kind === "VIDEO" && !input.thumbnailUrl && !input.externalUrl) {
    // A video with no poster renders as a black rectangle in every grid.
    issues.push({
      field: `thumbnailUrl${at}`,
      code: "missing_thumbnail",
      message: "Video media needs a poster image.",
    });
  }

  if (input.role && !IMAGE_ROLES.includes(input.role)) {
    issues.push({
      field: `role${at}`,
      code: "invalid_url",
      message: `role must be one of ${IMAGE_ROLES.join(", ")}.`,
    });
  }

  return issues;
}

export function normalizeMedia(input: MediaInput): NormalizedMedia {
  return {
    url: input.url.trim(),
    storageKey: input.storageKey?.trim() || null,
    thumbnailUrl: input.thumbnailUrl?.trim() || null,
    externalUrl: input.externalUrl?.trim() || null,
    altText: (input.altText ?? "").trim().slice(0, MAX_ALT_TEXT_LENGTH),
    mediaKind: input.mediaKind ?? "IMAGE",
    format: input.format?.trim().toLowerCase() || null,
    width: input.width ?? null,
    height: input.height ?? null,
    fileSizeBytes: input.fileSizeBytes ?? null,
    durationMs: input.durationMs ?? null,
    frameCount: input.frameCount ?? null,
    role: input.role ?? "GALLERY",
    sortOrder: Number.isInteger(input.sortOrder) ? (input.sortOrder as number) : 0,
    productId: input.productId ?? null,
    variantId: input.variantId ?? null,
  };
}

/**
 * The fixed shape the storefront consumes.
 *
 * Grouping is a pure function of the rows, so the PDP, the product cards, and
 * the admin preview all agree without duplicating the ordering rules.
 */
export interface MediaGroup {
  /** The one image used in listings and as the default PDP frame. */
  main: NormalizedMedia | null;
  /** Everything shown in the PDP gallery, ordered. */
  gallery: NormalizedMedia[];
  thumbnail: NormalizedMedia | null;
  hover: NormalizedMedia | null;
  mobile: NormalizedMedia | null;
  social: NormalizedMedia | null;
  videos: NormalizedMedia[];
  spins: NormalizedMedia[];
  /** Keyed by variant id, for the variant selector. */
  byVariant: Record<string, NormalizedMedia[]>;
}

export function groupMedia(media: readonly NormalizedMedia[]): MediaGroup {
  const sorted = [...media].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.url.localeCompare(b.url),
  );

  const stills = sorted.filter((item) => item.mediaKind === "IMAGE");
  const byVariant: Record<string, NormalizedMedia[]> = {};
  for (const item of sorted) {
    if (!item.variantId) continue;
    (byVariant[item.variantId] ??= []).push(item);
  }

  // A variant image must not become the product's main image: it shows one
  // colourway, and picking it would misrepresent the product in listings.
  const productStills = stills.filter((item) => !item.variantId);

  const pick = (role: ImageRole): NormalizedMedia | null =>
    productStills.find((item) => item.role === role) ?? null;

  const main =
    pick("PRIMARY") ?? productStills[0] ?? stills[0] ?? null;

  const gallery = productStills.filter((item) => item !== main);
  // The main image leads the gallery so the PDP strip starts where the listing
  // left off, rather than jumping to a different frame.
  const galleryOrdered = main ? [main, ...gallery] : gallery;

  return {
    main,
    gallery: galleryOrdered,
    thumbnail: pick("THUMBNAIL") ?? main,
    hover: pick("HOVER"),
    mobile: pick("MOBILE"),
    social: pick("SOCIAL") ?? main,
    videos: sorted.filter((item) => item.mediaKind === "VIDEO"),
    spins: sorted.filter((item) => item.mediaKind === "SPIN_360"),
    byVariant,
  };
}

/**
 * Re-sequence `sortOrder` to a dense 0..n-1 after a reorder or a deletion.
 *
 * Returning new values rather than mutating keeps the caller in control of when
 * the change is written, which matters inside a transaction.
 */
export function reorderMedia(
  media: readonly NormalizedMedia[],
  orderedIds: readonly string[],
): Map<string, number> {
  const next = new Map<string, number>();
  orderedIds.forEach((id, index) => next.set(id, index * 10));
  // Anything not named in the ordering keeps its relative place at the end, so
  // a partial reorder request cannot silently drop media.
  const remaining = media
    .filter((item) => !next.has(item.url))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  let cursor = orderedIds.length * 10;
  for (const item of remaining) {
    next.set(item.url, cursor);
    cursor += 10;
  }
  return next;
}

/** OpenGraph image payload: the platform prefers a square-ish social crop. */
export function socialImage(group: MediaGroup): { url: string; alt: string } | null {
  const chosen = group.social ?? group.main;
  if (!chosen) return null;
  return { url: chosen.url, alt: chosen.altText };
}
