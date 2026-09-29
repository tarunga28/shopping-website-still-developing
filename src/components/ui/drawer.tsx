"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Drawer — a dialog that slides in from a screen edge.
 * Built on Radix primitives: focus trap, scroll lock and ESC handling
 * come for free, keeping it fully keyboard accessible.
 */

export const Drawer = DialogPrimitive.Root;
export const DrawerTrigger = DialogPrimitive.Trigger;
export const DrawerClose = DialogPrimitive.Close;

const sideStyles = {
  left: "left-0 top-0 h-full w-[88vw] max-w-sm border-r-[1.5px] data-[state=open]:slide-in-from-left",
  right: "right-0 top-0 h-full w-[88vw] max-w-md border-l-[1.5px] data-[state=open]:slide-in-from-right",
  bottom: "bottom-0 left-0 w-full max-h-[85vh] rounded-t-3xl border-t-[1.5px] data-[state=open]:slide-in-from-bottom",
} as const;

export interface DrawerContentProps
  extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  side?: keyof typeof sideStyles;
}

export const DrawerContent = forwardRef<ElementRef<typeof DialogPrimitive.Content>, DrawerContentProps>(
  ({ className, children, side = "left", ...props }, ref) => (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          "fixed inset-0 z-[80] bg-ink/60 backdrop-blur-sm",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
        )}
      />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed z-[90] border-ink bg-paper shadow-xl focus:outline-none",
          "data-[state=open]:animate-in data-[state=open]:duration-300",
          sideStyles[side],
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          className="absolute right-4 top-4 rounded-full p-2 text-ink transition-colors hover:bg-sand focus-visible:outline-2 focus-visible:outline-flame"
          aria-label="Close panel"
        >
          <X className="size-5" aria-hidden />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  ),
);
DrawerContent.displayName = "DrawerContent";

export const DrawerTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("font-display text-2xl font-extrabold uppercase tracking-tight", className)}
    {...props}
  />
));
DrawerTitle.displayName = "DrawerTitle";

export const DrawerDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-sm text-smoke", className)} {...props} />
));
DrawerDescription.displayName = "DrawerDescription";
