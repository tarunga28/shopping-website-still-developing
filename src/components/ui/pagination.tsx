import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";
import type { AnchorHTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

/**
 * Stateless pagination primitives — the parent supplies URLs, this renders
 * accessible navigation. Ready for catalog/search result pages.
 */

export function Pagination({ className, ...props }: React.ComponentProps<"nav">) {
  return (
    <nav role="navigation" aria-label="Pagination" className={cn("flex justify-center", className)} {...props} />
  );
}

export function PaginationContent({ className, ...props }: React.ComponentProps<"ul">) {
  return <ul className={cn("flex items-center gap-1.5", className)} {...props} />;
}

export function PaginationItem({ className, ...props }: React.ComponentProps<"li">) {
  return <li className={cn(className)} {...props} />;
}

export interface PaginationLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  isActive?: boolean;
}

export function PaginationLink({ className, isActive, ...props }: PaginationLinkProps) {
  return (
    <a
      aria-current={isActive ? "page" : undefined}
      className={cn(
        buttonVariants({ variant: isActive ? "primary" : "ghost", size: "icon" }),
        "text-xs",
        className,
      )}
      {...props}
    />
  );
}

export function PaginationPrevious({ className, ...props }: PaginationLinkProps) {
  return (
    <PaginationLink aria-label="Go to previous page" className={cn("w-auto gap-1 px-4", className)} {...props}>
      <ChevronLeft className="size-4" aria-hidden />
      <span className="hidden sm:inline">Prev</span>
    </PaginationLink>
  );
}

export function PaginationNext({ className, ...props }: PaginationLinkProps) {
  return (
    <PaginationLink aria-label="Go to next page" className={cn("w-auto gap-1 px-4", className)} {...props}>
      <span className="hidden sm:inline">Next</span>
      <ChevronRight className="size-4" aria-hidden />
    </PaginationLink>
  );
}

export function PaginationEllipsis({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span aria-hidden className={cn("flex size-11 items-center justify-center text-smoke", className)} {...props}>
      <MoreHorizontal className="size-4" />
      <span className="sr-only">More pages</span>
    </span>
  );
}
