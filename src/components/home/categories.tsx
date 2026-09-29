import { CategoryCard } from "@/components/cards/category-card";
import { ComingSoonDialog } from "@/components/layout/coming-soon-dialog";
import { Section, SectionHeader } from "@/components/layout/section";
import { sampleCategories } from "@/lib/placeholder-data";

/**
 * Editorial category mosaic. Tiles open an honest "coming soon" dialog
 * until the category routes ship — no dead links.
 */
export function Categories() {
  return (
    <Section id="categories">
      <SectionHeader
        eyebrow="01 — Shop by category"
        title={
          <>
            Pick your
            <br />
            canvas<span className="text-flame">.</span>
          </>
        }
        description="Seven ways to wear, hang, sip and carry original art. Every category is printed on demand, one piece at a time."
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {sampleCategories.map((category, index) => (
          <ComingSoonDialog
            key={category.slug}
            feature={`${category.name} are dropping soon`}
            description={`The ${category.name.toLowerCase()} catalogue is being finalized with our artists right now. Join the waitlist and you'll be first to know when it goes live.`}
            trigger={
              <button
                type="button"
                className={
                  "h-full w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame " +
                  (index === 0 ? "col-span-2 row-span-2" : "")
                }
              >
                <CategoryCard category={category} size={index === 0 ? "feature" : "default"} />
              </button>
            }
          />
        ))}
      </div>
    </Section>
  );
}
