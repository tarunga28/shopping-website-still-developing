"use client";

import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { storefrontContent } from "@/content/storefront";
import { clearRecentSearches, rememberSearch, useRecentSearches } from "@/lib/recent-searches";
import { searchPath } from "@/lib/storefront-paths";

export function SearchForm({
  initialQuery = "",
  suggested = storefrontContent.search.suggested,
  popular = storefrontContent.search.popular,
}: {
  initialQuery?: string;
  suggested?: readonly string[];
  popular?: readonly string[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const recent = useRecentSearches();

  function go(next: string) {
    const clean = next.trim();
    if (clean.length < 2) return;
    rememberSearch(clean);
    router.push(searchPath(clean));
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    go(query);
  }

  return (
    <div className="space-y-6">
      <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row" role="search">
        <label htmlFor="store-search" className="sr-only">
          Search the catalogue
        </label>
        <div className="flex min-h-12 flex-1 items-center gap-3 rounded-pill border-[1.5px] border-ink bg-paper px-4">
          <Search className="size-4 shrink-0 text-smoke" aria-hidden />
          <input
            id="store-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={storefrontContent.search.placeholder}
            className="w-full bg-transparent text-base outline-none placeholder:text-smoke/60"
            enterKeyHint="search"
          />
        </div>
        <Button type="submit" size="lg" className="w-full sm:w-auto">
          Search
        </Button>
      </form>

      {recent.length > 0 ? (
        <section aria-label="Recent searches">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">Recent searches</h2>
            <button
              type="button"
              className="min-h-8 text-[10px] uppercase tracking-[0.14em] text-smoke hover:text-ink"
              onClick={() => {
                clearRecentSearches();
              }}
            >
              Clear
            </button>
          </div>
          <ul className="flex flex-wrap gap-2">
            {recent.map((item) => (
              <li key={item}>
                <button
                  type="button"
                  onClick={() => go(item)}
                  className="min-h-10 rounded-pill border-[1.5px] border-clay px-3 text-sm hover:border-ink"
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
                  className="min-h-10 rounded-pill border-[1.5px] border-ink px-3 text-sm hover:bg-ink hover:text-paper"
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
  );
}
