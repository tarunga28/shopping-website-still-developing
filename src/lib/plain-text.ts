/**
 * Collapse untrusted copy into a single plain-text line.
 * Used for metadata, JSON-LD and any surface that must not carry HTML.
 */

const TAGS = /<[^>]*>/g;
const ENTITIES = /&(?:#\d+|#x[\da-f]+|\w+);/gi;
const CONTROLS = /[\u0000-\u001F\u007F]/g;

export function plainText(value: string | null | undefined, max = 180): string {
  if (!value) return "";
  return value
    .replace(TAGS, " ")
    .replace(ENTITIES, " ")
    .replace(CONTROLS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Like `plainText` but keeps paragraph breaks, for long descriptions that are
 * rendered as text nodes (never as HTML).
 */
export function plainParagraphs(value: string | null | undefined, max = 5000): string[] {
  if (!value) return [];
  return value
    .replace(TAGS, " ")
    .replace(ENTITIES, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .slice(0, max)
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** JSON-LD script bodies must not be able to close the script tag. */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
