"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Search, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Price } from "@/components/ui/price";
import { storefrontContent } from "@/content/storefront";
import { trackStorefrontEvent, STOREFRONT_EVENTS } from "@/lib/analytics";
import { clearRecentSearches, rememberSearch, useRecentSearches } from "@/lib/recent-searches";
import { productPath, searchPath } from "@/lib/storefront-paths";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
interface SearchHit {
  id: string;
  slug: string;
  name: string;
  pricePaise: number;
  imageUrl: string | null;
  imageAlt: string | null;
  categoryName: string | null;
}

/**
 * Search entry. Suggestions come from the catalog API, not a preloaded catalog.
 * Recent searches stay on this device. Popular searches render only when real queries are supplied.
 */
export function SearchDialog({
  trigger,
  suggested = storefrontContent.search.suggested,
  popular = storefrontContent.search.popular,
}: {
  trigger: ReactNode;
  suggested?: readonly string[];
  popular?: readonly string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searchError, setSearchError] = useState(false);
  const recent = useRecentSearches();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    trackStorefrontEvent({ name: STOREFRONT_EVENTS.SEARCH_OPENED, consent: "analytics" });
    const id = window.setTimeout(() => inputRef.current?.focus(), 80);
    return () => window.clearTimeout(id);
  }, [open]);

  const trimmedQuery = query.trim();
  const visibleResults = trimmedQuery.length < 2 ? [] : results;

  useEffect(() => {
    if (trimmedQuery.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: trimmedQuery, pageSize: "20", sort: "newest" });
      fetch(`/api/catalog/products?${params.toString()}`, { signal: controller.signal })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error("search"))))
        .then((body: { ok?: boolean; data?: { items?: SearchHit[] } }) => {
          setSearchError(false);
          setResults(body.data?.items?.slice(0, 8) ?? []);
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setSearchError(true);
          setResults([]);
        });
    }, 180);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [trimmedQuery]);

  function go(next: string) {
    const clean = next.trim();
    if (clean.length < 2) return;
    rememberSearch(clean);
    setOpen(false);
    router.push(searchPath(clean));
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="top-[8%] max-h-[80vh] -translate-y-0 overflow-hidden p-0 sm:max-w-xl" aria-describedby={undefined}>
        <VisuallyHidden.Root>
          <DialogTitle>Search the catalogue</DialogTitle>
        </VisuallyHidden.Root>

        <form
          className="flex items-center gap-3 border-b-[1.5px] border-ink px-5 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            go(query);
          }}
        >
          <Search className="size-4 shrink-0 text-smoke" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={storefrontContent.search.placeholder}
            className="w-full bg-transparent text-base outline-none placeholder:text-smoke/60"
            aria-label="Search the catalogue"
            enterKeyHint="search"
          />
          <button type="submit" className="sr-only">
            Search
          </button>
          <kbd className="hidden shrink-0 rounded-md border border-clay bg-cream px-1.5 py-0.5 font-mono text-[10px] text-smoke sm:block">
            ESC
          </kbd>
        </form>

        <div className="max-h-[54vh] overflow-y-auto p-3">
          {query.trim().length < 2 ? (
            <div className="space-y-5 px-2 py-2">
              {recent.length > 0 ? (
                <section aria-label="Recent searches">
                  <div className="mb-2 flex items-center justify-between">
                    <h2 className="font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">Recent searches</h2>
                    <button
                      type="button"
                      className="inline-flex min-h-8 items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-smoke hover:text-ink"
                      onClick={() => {
                        clearRecentSearches();
                      }}
                    >
                      <X className="size-3" aria-hidden /> Clear
                    </button>
                  </div>
                  <ul className="flex flex-wrap gap-2">
                    {recent.map((item) => (
                      <li key={item}>
                        <button
                          type="button"
                          onClick={() => go(item)}
                          className="min-h-10 rounded-pill border-[1.5px] border-clay px-3 text-sm hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame"
                        >
                          {item}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {suggested.length > 0 ? (
                <section aria-label="Suggested searches">
                  <h2 className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">Suggested</h2>
                  <ul className="flex flex-wrap gap-2">
                    {suggested.map((item) => (
                      <li key={item}>
                        <button
                          type="button"
                          onClick={() => go(item)}
                          className="min-h-10 rounded-pill border-[1.5px] border-ink px-3 text-sm hover:bg-ink hover:text-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame"
                        >
                          {item}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {popular.length > 0 ? (
                <section aria-label="Popular searches">
                  <h2 className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">Popular searches</h2>
                  <ul className="flex flex-wrap gap-2">
                    {popular.map((item) => (
                      <li key={item}>
                        <button type="button" onClick={() => go(item)} className="min-h-10 rounded-pill bg-cream px-3 text-sm">
                          {item}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

            </div>
          ) : searchError ? (
            <p className="px-3 py-8 text-center text-sm text-smoke">Search did not load. Try the search page.</p>
          ) : visibleResults.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-smoke">No published product matches “{query.trim()}”.</p>
          ) : (
            <ul className="divide-y divide-clay/60">
              {visibleResults.map((product) => (
                <li key={product.id}>
                  <Link
                    href={productPath(product.slug)}
                    data-track="PRODUCT_CLICK"
                    data-track-id={product.slug}
                    onClick={() => {
                      rememberSearch(query);
                      setOpen(false);
                    }}
                    className="flex items-center gap-4 rounded-xl px-3 py-3 transition-colors hover:bg-cream focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame"
                  >
                    <span className="relative size-12 shrink-0 overflow-hidden rounded-lg border border-clay">
                      {product.imageUrl ? (
                        <Image src={product.imageUrl} alt="" fill sizes="48px" className="object-cover" />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{product.name}</span>
                      <span className="block text-[10px] uppercase tracking-[0.16em] text-smoke">{product.categoryName || "Inkline"}</span>
                    </span>
                    <Price amount={product.pricePaise} size="sm" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between border-t-[1.5px] border-clay bg-cream px-5 py-3">
          <Link
            href={query.trim().length >= 2 ? searchPath(query.trim()) : "/search"}
            onClick={() => {
              if (query.trim().length >= 2) rememberSearch(query);
              setOpen(false);
            }}
            className="inline-flex min-h-10 items-center gap-1 font-mono text-[10px] uppercase tracking-[0.16em] text-ink underline decoration-flame underline-offset-4"
          >
            {query.trim().length >= 2 ? "View all results" : "Open search"}
            <ArrowUpRight className="size-3.5" aria-hidden />
          </Link>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-smoke">
            {results.length} shown
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
