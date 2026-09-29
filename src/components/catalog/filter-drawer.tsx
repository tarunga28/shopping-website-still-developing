"use client";

import { SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Drawer, DrawerClose, DrawerContent, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import { sampleCategories } from "@/lib/placeholder-data";

/**
 * Filter panel UI (drawer on mobile, docked panel-ready on desktop).
 * Controls are presentational for now — real filtering lands with the
 * catalog database and URL-driven filter state.
 */
export function FilterDrawer({ trigger }: { trigger: ReactNode }) {
  return (
    <Drawer>
      <DrawerTrigger asChild>{trigger}</DrawerTrigger>
      <DrawerContent side="right" className="flex w-full flex-col p-6" aria-describedby={undefined}>
        <div className="flex items-center justify-between">
          <DrawerTitle className="flex items-center gap-2 text-xl">
            <SlidersHorizontal className="size-5 text-flame" aria-hidden />
            Filters
          </DrawerTitle>
          <Badge variant="coming-soon">Activates at launch</Badge>
        </div>

        <div className="mt-8 flex-1 space-y-8 overflow-y-auto">
          <fieldset>
            <legend className="text-[11px] font-semibold uppercase tracking-[0.14em] text-smoke">Category</legend>
            <div className="mt-3 space-y-2.5">
              {sampleCategories.map((category) => (
                <label key={category.slug} className="flex cursor-pointer items-center gap-2.5 text-sm text-ink/85">
                  <Checkbox disabled aria-label={category.name} />
                  {category.name}
                  <span className="ml-auto font-mono text-[10px] text-smoke">—</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-[11px] font-semibold uppercase tracking-[0.14em] text-smoke">Price</legend>
            <RadioGroup className="mt-3" aria-label="Price range">
              {["Under ₹500", "₹500 – ₹1,000", "₹1,000 – ₹2,000", "Above ₹2,000"].map((range) => (
                <label key={range} className="flex cursor-pointer items-center gap-2.5 text-sm text-ink/85">
                  <RadioGroupItem value={range} disabled aria-label={range} />
                  {range}
                </label>
              ))}
            </RadioGroup>
          </fieldset>

          <fieldset>
            <legend className="text-[11px] font-semibold uppercase tracking-[0.14em] text-smoke">Availability</legend>
            <div className="mt-3 space-y-2.5">
              {["In stock", "Low stock", "Coming soon"].map((option) => (
                <label key={option} className="flex cursor-pointer items-center gap-2.5 text-sm text-ink/85">
                  <Checkbox disabled aria-label={option} />
                  {option}
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="mt-6 flex gap-3 border-t border-clay pt-5">
          <Button variant="primary" size="md" className="flex-1" disabled>
            Apply filters
          </Button>
          <DrawerClose asChild>
            <Button variant="outline" size="md">
              Close
            </Button>
          </DrawerClose>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
