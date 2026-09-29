"use client";

import { Ruler } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { STOREFRONT_EVENTS, trackStorefrontEvent } from "@/lib/analytics";
import type { SizeChart } from "@/lib/catalog/size-chart";

/**
 * Size guide. The chart is real data for this product type (see
 * `size_charts`); with no chart nothing is rendered, so there is never a
 * button that opens an empty or invented table.
 */
export function SizeGuide({ chart, productSlug }: { chart: SizeChart | null; productSlug: string }) {
  if (!chart) return null;
  return (
    <Dialog
      onOpenChange={(open) => {
        if (open) {
          trackStorefrontEvent({ name: STOREFRONT_EVENTS.SIZE_GUIDE_OPENED, consent: "analytics", payload: { slug: productSlug } });
        }
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] underline decoration-flame decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame"
        >
          <Ruler className="size-3.5" aria-hidden />
          Size guide
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogTitle className="pr-8">{chart.title}</DialogTitle>
        <DialogDescription className="pt-1 text-smoke">
          Measurements are in {chart.unit === "cm" ? "centimetres" : "inches"}.
        </DialogDescription>
        <div className="mt-4 max-h-[60vh] overflow-auto rounded-xl border-[1.5px] border-clay">
          <table className="w-full min-w-[20rem] border-collapse text-left text-sm">
            <caption className="sr-only">{chart.title}</caption>
            <thead className="sticky top-0 bg-sand">
              <tr>
                {chart.columns.map((column, index) => (
                  <th
                    key={`${column}-${index}`}
                    scope="col"
                    className="whitespace-nowrap px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-smoke"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {chart.rows.map((row, rowIndex) => (
                <tr key={`${row[0]}-${rowIndex}`} className="border-t border-clay/70">
                  {row.map((value, cellIndex) =>
                    cellIndex === 0 ? (
                      <th key={cellIndex} scope="row" className="whitespace-nowrap px-4 py-2.5 font-semibold">
                        {value}
                      </th>
                    ) : (
                      <td key={cellIndex} className="whitespace-nowrap px-4 py-2.5 tabular-nums">
                        {value}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {chart.notes ? <p className="mt-3 text-xs leading-relaxed text-smoke">{chart.notes}</p> : null}
      </DialogContent>
    </Dialog>
  );
}
