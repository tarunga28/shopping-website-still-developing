import { z } from "zod";
import { plainText } from "@/lib/plain-text";

/**
 * Product-type-specific size measurements. Rows are real data entered by
 * staff; with no valid chart the storefront hides the size-guide button.
 */

export const SIZE_CHART_UNITS = ["cm", "in"] as const;

const cell = z
  .string()
  .transform((value) => plainText(value, 40))
  .pipe(z.string().min(1));

export const sizeChartSchema = z
  .object({
    title: z
      .string()
      .transform((value) => plainText(value, 80))
      .pipe(z.string().min(1)),
    unit: z.enum(SIZE_CHART_UNITS),
    columns: z.array(cell).min(2).max(8),
    rows: z.array(z.array(cell).min(2).max(8)).min(1).max(20),
    notes: z
      .string()
      .nullish()
      .transform((value) => (value ? plainText(value, 400) : "") || null),
  })
  .refine((chart) => chart.rows.every((row) => row.length === chart.columns.length), {
    message: "Every row must have one value per column.",
  });

export type SizeChart = z.infer<typeof sizeChartSchema>;

/** Read-side: null (button hidden) unless the stored chart is fully valid. */
export function parseSizeChart(raw: unknown): SizeChart | null {
  const parsed = sizeChartSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
