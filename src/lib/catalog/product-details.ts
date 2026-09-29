import { z } from "zod";
import { plainText } from "@/lib/plain-text";

/**
 * Structured storefront copy stored in `products.details` (jsonb).
 *
 * The column is untrusted JSON: it is validated on write (admin) and again on
 * every read. All strings are collapsed to plain text, so a bad row can never
 * inject HTML into the page, and each field is parsed independently so one
 * malformed field does not hide the rest.
 */

export const DETAIL_LIMITS = {
  features: { items: 12, length: 160 },
  care: { items: 10, length: 160 },
  specs: { items: 20, label: 60, value: 200 },
  materials: 300,
  fit: 300,
  printDetails: 300,
} as const;

const cleanLine = (max: number) =>
  z
    .string()
    .transform((value) => plainText(value, max))
    .pipe(z.string().min(1));

const optionalLine = (max: number) =>
  z
    .string()
    .nullish()
    .transform((value) => (value ? plainText(value, max) : ""))
    .transform((value) => (value.length > 0 ? value : null));

const specSchema = z.object({
  label: cleanLine(DETAIL_LIMITS.specs.label),
  value: cleanLine(DETAIL_LIMITS.specs.value),
});

const featuresSchema = z.array(cleanLine(DETAIL_LIMITS.features.length)).max(DETAIL_LIMITS.features.items);
const careSchema = z.array(cleanLine(DETAIL_LIMITS.care.length)).max(DETAIL_LIMITS.care.items);
const specsSchema = z.array(specSchema).max(DETAIL_LIMITS.specs.items);

/** Strict write-side schema (admin). Rejects instead of truncating. */
export const productDetailsSchema = z.object({
  features: featuresSchema.default([]),
  materials: optionalLine(DETAIL_LIMITS.materials).default(null),
  fit: optionalLine(DETAIL_LIMITS.fit).default(null),
  care: careSchema.default([]),
  printDetails: optionalLine(DETAIL_LIMITS.printDetails).default(null),
  specs: specsSchema.default([]),
});

export type ProductDetails = z.infer<typeof productDetailsSchema>;

export const EMPTY_PRODUCT_DETAILS: ProductDetails = {
  features: [],
  materials: null,
  fit: null,
  care: [],
  printDetails: null,
  specs: [],
};

/** Lenient read-side parser: invalid fields fall back to empty, never throw. */
export function parseProductDetails(raw: unknown): ProductDetails {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...EMPTY_PRODUCT_DETAILS };
  const source = raw as Record<string, unknown>;
  const pick = <T,>(schema: z.ZodType<T>, key: string, fallback: T): T => {
    const parsed = schema.safeParse(source[key]);
    return parsed.success ? parsed.data : fallback;
  };
  return {
    features: pick(featuresSchema, "features", []),
    materials: pick(optionalLine(DETAIL_LIMITS.materials), "materials", null),
    fit: pick(optionalLine(DETAIL_LIMITS.fit), "fit", null),
    care: pick(careSchema, "care", []),
    printDetails: pick(optionalLine(DETAIL_LIMITS.printDetails), "printDetails", null),
    specs: pick(specsSchema, "specs", []),
  };
}

export function hasProductDetails(details: ProductDetails): boolean {
  return (
    details.features.length > 0 ||
    details.care.length > 0 ||
    details.specs.length > 0 ||
    Boolean(details.materials || details.fit || details.printDetails)
  );
}

/** Admin form helpers: one item per line; specs are "Label: Value". */
export function linesToList(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function specsToText(specs: ProductDetails["specs"]): string {
  return specs.map((spec) => `${spec.label}: ${spec.value}`).join("\n");
}

export function textToSpecs(value: string | null | undefined): { label: string; value: string }[] {
  return linesToList(value).flatMap((line) => {
    const index = line.indexOf(":");
    if (index <= 0) return [];
    return [{ label: line.slice(0, index).trim(), value: line.slice(index + 1).trim() }];
  });
}
