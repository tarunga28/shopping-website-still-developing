"use client";

import Link from "next/link";
import { SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerClose, DrawerContent, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import { categoryPath } from "@/lib/storefront-paths";

/**
 * Category shortcuts. Price and availability filters are not wired yet,
 * so they are not presented as controls that look like they work.
 */
export function FilterDrawer({
  trigger,
  categories = [],
}: {
  trigger: ReactNode;
  categories?: { slug: string; name: string }[];
}) {
  return (
    <Drawer>
      <DrawerTrigger asChild>{trigger}</DrawerTrigger>
      <DrawerContent side="right" className="flex w-full flex-col p-6" aria-describedby={undefined}>
        <DrawerTitle className="flex items-center gap-2 text-xl">
          <SlidersHorizontal className="size-5 text-flame" aria-hidden />
          Browse
        </DrawerTitle>
        <p className="mt-2 text-sm text-smoke">
          Price and availability filters are not available yet. Categories below are real links.
        </p>

        <nav aria-label="Categories" className="mt-8 flex-1 overflow-y-auto">
          {categories.length === 0 ? (
            <p className="text-sm text-smoke">No categories are published.</p>
          ) : (
            <ul className="space-y-1">
              {categories.map((category) => (
                <li key={category.slug}>
                  <Link
                    href={categoryPath(category.slug)}
                    data-track="CATEGORY_CLICK"
                    data-track-id={category.slug}
                    className="flex min-h-11 items-center rounded-xl px-2 text-sm font-semibold hover:bg-cream focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame"
                  >
                    {category.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </nav>

        <div className="mt-6 border-t border-clay pt-5">
          <DrawerClose asChild>
            <Button variant="outline" size="md" className="w-full">
              Close
            </Button>
          </DrawerClose>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
