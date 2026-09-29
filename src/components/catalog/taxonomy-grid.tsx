import Image from "next/image";
import Link from "next/link";
import { isSafeImageSrc } from "@/lib/safe-url";

export interface TaxonomyCard {
  href: string;
  name: string;
  description: string;
  count: number;
  image: { url: string; alt: string } | null;
}

/** Category / collection tiles. Counts are real; a missing image degrades to a text tile. */
export function TaxonomyGrid({ items }: { items: TaxonomyCard[] }) {
  return (
    <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <li key={item.href}>
          <Link
            href={item.href}
            className="group block h-full overflow-hidden rounded-card border-[1.5px] border-ink bg-paper transition-colors hover:border-flame focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame"
          >
            <div className="relative aspect-[4/3] bg-sand">
              {item.image && isSafeImageSrc(item.image.url) ? (
                <Image
                  src={item.image.url}
                  alt={item.image.alt || item.name}
                  fill
                  sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                  className="object-cover transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
                />
              ) : null}
            </div>
            <div className="space-y-1 p-4">
              <h2 className="font-display text-xl font-extrabold uppercase leading-tight">{item.name}</h2>
              {item.description ? <p className="line-clamp-2 text-sm text-smoke">{item.description}</p> : null}
              <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-smoke">
                {item.count} {item.count === 1 ? "product" : "products"}
              </p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
