import { EmptyState } from "@/components/ui/empty-state";
import { LayoutGrid, Package, SearchX } from "lucide-react";
import type { ListingScope } from "@/services/catalog/listing.service";

/** The four distinct "nothing to show" situations, each with its own honest copy. */
export function CatalogEmpty({
  scope,
  scopeIsEmpty,
  clearHref,
}: {
  scope: ListingScope;
  scopeIsEmpty: boolean;
  clearHref: string;
}) {
  if (!scopeIsEmpty) {
    return (
      <EmptyState
        icon={SearchX}
        title="No products match your selected filters."
        description="Try removing a filter or widening the price range."
        action={{ label: "Clear Filters", href: clearHref }}
      />
    );
  }
  if (scope.kind === "category") {
    return (
      <EmptyState
        icon={LayoutGrid}
        title="No products available in this category yet."
        description="New designs are added regularly."
        action={{ label: "Browse All Products", href: "/shop" }}
      />
    );
  }
  if (scope.kind === "collection") {
    return (
      <EmptyState
        icon={LayoutGrid}
        title="No products in this collection yet."
        description="Check back soon, or explore the rest of the store."
        action={{ label: "Browse All Products", href: "/shop" }}
      />
    );
  }
  return (
    <EmptyState
      icon={Package}
      title="Our store is getting ready."
      description="New designs are coming soon."
      action={{ label: "Return Home", href: "/" }}
    />
  );
}
