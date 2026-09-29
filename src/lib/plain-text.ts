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

/** JSON-LD script bodies must not be able to close the script tag. */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
