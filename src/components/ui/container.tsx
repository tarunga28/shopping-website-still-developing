import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * Container system — consistent horizontal rhythm and max widths so
 * content never stretches awkwardly on wide monitors.
 *
 *   narrow  → forms, legal copy            (48rem)
 *   default → every standard section       (90rem)
 *   wide    → full-bleed commerce grids    (100rem)
 */
const widths = {
  narrow: "max-w-3xl",
  default: "max-w-[90rem]",
  wide: "max-w-[100rem]",
} as const;

export interface ContainerProps extends HTMLAttributes<HTMLDivElement> {
  width?: keyof typeof widths;
}

export function Container({ width = "default", className, ...props }: ContainerProps) {
  return (
    <div
      className={cn("mx-auto w-full px-5 sm:px-8 lg:px-12", widths[width], className)}
      {...props}
    />
  );
}
