import { CategoryCard } from "@/components/cards/category-card";
import { SectionFallback } from "@/components/home/section-fallback";
import { Section, SectionHeader } from "@/components/layout/section";
import { EmptyState } from "@/components/ui/empty-state";
import { storefrontContent } from "@/content/storefront";
import type { StorefrontCategory } from "@/types/storefront";
import type { SectionStatus } from "@/types/storefront";
import { LayoutGrid } from "lucide-react";

export function Categories({
  categories,
  status = "ok",
}: {
  categories: StorefrontCategory[];
  status?: SectionStatus;
}) {
  const copy = storefrontContent.categories;

  if (status === "error") {
    return <SectionFallback id="categories" title="Categories didn't load" />;
  }

  return (
    <Section id="categories">
      <SectionHeader
        eyebrow={copy.eyebrow}
        title={
          <>
            {copy.titleLead}
            <br />
            {copy.titleAccent}
            <span className="text-flame">.</span>
          </>
        }
        description={copy.description}
      />

      {categories.length === 0 ? (
        <EmptyState
          icon={LayoutGrid}
          title="No categories published"
          description="Categories show up here once they have published products. Nothing is invented to fill the grid."
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {categories.map((category, index) => (
            <CategoryCard
              key={category.slug}
              category={category}
              cta={copy.ctaLabel}
              size={index === 0 && categories.length >= 4 ? "feature" : "default"}
              className={index === 0 && categories.length >= 4 ? "col-span-2 lg:row-span-2" : undefined}
            />
          ))}
        </div>
      )}
    </Section>
  );
}
