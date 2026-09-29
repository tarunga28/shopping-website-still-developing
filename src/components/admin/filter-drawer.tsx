"use client";

import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerClose, DrawerContent, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";

function duplicate(node: ReactNode) {
  return Children.map(node, (child) => (isValidElement(child) ? cloneElement(child) : child));
}

/** Mobile admin filters live in a drawer so the product list does not start with a tall form. */
export function AdminFilterDrawer({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="mb-4 md:hidden">
        <Drawer>
          <DrawerTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              <SlidersHorizontal className="size-4" aria-hidden />
              Filters
            </Button>
          </DrawerTrigger>
          <DrawerContent side="bottom" className="p-5" aria-describedby={undefined}>
            <DrawerTitle className="text-lg">Filters</DrawerTitle>
            <div className="mt-4">{duplicate(children)}</div>
            <DrawerClose asChild>
              <Button type="button" variant="ghost" size="sm" className="mt-3">
                Close
              </Button>
            </DrawerClose>
          </DrawerContent>
        </Drawer>
      </div>
      <div className="mb-4 hidden md:block">{duplicate(children)}</div>
    </>
  );
}
