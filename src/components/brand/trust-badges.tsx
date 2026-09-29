import Link from "next/link";
import { storefrontContent, type TrustItem } from "@/content/storefront";
import { StorefrontGlyph } from "@/components/storefront/icon";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";

const statusLabel: Record<TrustItem["status"], string> = {
  live: "Available",
  upcoming: "Not open yet",
  model: "How orders work",
};

/**
 * Trust indicators. Each item is labeled with whether it is live, the
 * business model, or still upcoming — no unsupported guarantees.
 */
export function TrustIndicators({
  variant = "row",
  className,
  items = storefrontContent.trust,
}: {
  variant?: "row" | "grid";
  className?: string;
  items?: readonly TrustItem[];
}) {
  return (
    <ul
      className={cn(
        variant === "grid" ? "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" : "flex flex-wrap gap-x-6 gap-y-3",
        className,
      )}
    >
      {items.map((item) => (
        <li
          key={item.id}
          className={cn(
            "flex items-start gap-2.5",
            variant === "grid" && "rounded-card border-[1.5px] border-clay bg-cream p-4",
          )}
        >
          <StorefrontGlyph name={item.icon} className="mt-0.5 size-4 shrink-0 text-flame" />
          <span>
            <span className="block text-xs font-semibold uppercase tracking-[0.1em]">
              {item.label}
              <span className="ml-2 font-mono text-[9px] font-normal tracking-[0.14em] text-smoke">
                {statusLabel[item.status]}
              </span>
            </span>
            {variant === "grid" ? (
              <span className="mt-1 block text-[11px] leading-snug text-smoke">
                {item.id === "support" ? (
                  <>
                    {item.description}{" "}
                    <Link href={`mailto:${siteConfig.contact.supportEmail}`} className="underline decoration-flame underline-offset-2">
                      {siteConfig.contact.supportEmail}
                    </Link>
                  </>
                ) : (
                  item.description
                )}
              </span>
            ) : (
              <span className="sr-only">{item.description}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
