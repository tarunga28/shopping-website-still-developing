"use client";

import Image from "next/image";
import { ArrowUpRight, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Price } from "@/components/ui/price";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import type { ProductSummary } from "@/types";

/**
 * Catalogue search — filters the live active catalog (server-provided).
 * When full-text search ships, this swaps its source without UX changes.
 */
export function SearchDialog({ trigger, products }: { trigger: ReactNode; products: ProductSummary[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      // Wait for the dialog animation before focusing.
      const id = window.setTimeout(() => inputRef.current?.focus(), 80);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) => p.title.toLowerCase().includes(q) || p.category.toLowerCase().includes(q),
    );
  }, [query, products]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        className="top-[12%] max-h-[76vh] -translate-y-0 overflow-hidden p-0 sm:max-w-xl"
        aria-describedby={undefined}
      >
        <VisuallyHidden.Root>
          <DialogTitle>Search the catalogue</DialogTitle>
        </VisuallyHidden.Root>

        <div className="flex items-center gap-3 border-b-[1.5px] border-ink px-5 py-4">
          <Search className="size-4 shrink-0 text-smoke" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tees, hoodies, mugs…"
            className="w-full bg-transparent text-base outline-none placeholder:text-smoke/60"
            aria-label="Search the catalogue"
          />
          <kbd className="hidden shrink-0 rounded-md border border-clay bg-cream px-1.5 py-0.5 font-mono text-[10px] text-smoke sm:block">
            ESC
          </kbd>
        </div>

        <div className="max-h-[52vh] overflow-y-auto p-2.5">
          {results.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-smoke">
              Nothing matches “{query}” in the preview catalogue.
            </p>
          ) : (
            <ul className="divide-y divide-clay/60">
              {results.map((product) => (
                <li key={product.id} className="flex items-center gap-4 rounded-xl px-3 py-3 transition-colors hover:bg-cream">
                  <span className="relative size-12 shrink-0 overflow-hidden rounded-lg border border-clay">
                    <Image src={product.image} alt="" fill sizes="48px" className="object-cover" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{product.title}</span>
                    <span className="block text-[10px] uppercase tracking-[0.16em] text-smoke">
                      {product.category}
                    </span>
                  </span>
                  <Price amount={product.pricePaise} size="sm" />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between border-t-[1.5px] border-clay bg-cream px-5 py-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">
            Live catalogue — {results.length} of {products.length} shown
          </p>
          <ArrowUpRight className="size-3.5 text-smoke" aria-hidden />
        </div>
      </DialogContent>
    </Dialog>
  );
}
