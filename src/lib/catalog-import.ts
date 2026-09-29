import { productWriteSchema, variantWriteSchema, type ProductWriteInput, type VariantWriteInput } from "@/validations/catalog";

/**
 * Shared gate for a future CSV or supplier import.
 * This is not an importer — it only proves a row must pass the same checks as the admin form.
 */
export function normalizeImportProduct(row: unknown): { ok: true; value: ProductWriteInput } | { ok: false; errors: string[] } {
  const parsed = productWriteSchema.safeParse(row);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((issue) => issue.message) };
  }
  return { ok: true, value: parsed.data };
}

export function normalizeImportVariant(row: unknown): { ok: true; value: VariantWriteInput } | { ok: false; errors: string[] } {
  const parsed = variantWriteSchema.safeParse(row);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((issue) => issue.message) };
  }
  return { ok: true, value: parsed.data };
}
