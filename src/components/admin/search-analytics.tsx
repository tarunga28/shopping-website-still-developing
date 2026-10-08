"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { RankingWeights } from "@/lib/search/types";

/**
 * The interactive half of the admin search dashboard.
 *
 * Sections are collapsed by default below the fold because the page carries a lot
 * of tables, and an operator who came to look at zero-result queries should not
 * have to scroll past four others to reach them.
 */

interface Overview {
  windowDays: number;
  totalSearches: number;
  uniqueQueries: number;
  averageResultCount: number;
  zeroResultRate: number;
  clickThroughRate: number;
  addToCartRate: number;
  latency: { p50: number; p95: number; p99: number; average: number };
  averageSearchesPerSession: number;
}

interface IndexInfo {
  products: number;
  indexedProducts: number;
  searchableProducts: number;
  staleProducts: number;
  pendingEvents: number;
  failedEvents: number;
  lastIndexedAt: string | null;
}

interface QueryStat {
  query: string;
  searches: number;
  zeroResultSearches: number;
  averageResults: number;
  clicks: number;
  clickThroughRate: number;
  lastSeenAt: string | null;
}

interface SynonymRow {
  id: string;
  term: string;
  synonym: string;
  isBidirectional: boolean;
  isActive: boolean;
}

interface RankingInfo {
  version: string;
  label: string;
  outOfStockMode: string;
  fuzzyThreshold: number;
  maxEditDistance: number;
  weights: RankingWeights;
}

export interface SearchAnalyticsProps {
  overview: Overview | null;
  index: IndexInfo | null;
  popular: QueryStat[];
  rising: Array<{ query: string; recent: number; earlier: number; growth: number }>;
  zeroResults: Array<{ query: string; searches: number; lastSeenAt: string | null; suggestion: string | null }>;
  lowClick: Array<{ query: string; searches: number; clicks: number; clickThroughRate: number }>;
  clickPositions: Array<{ position: number; clicks: number }>;
  synonyms: { total: number; bidirectional: number; inactive: number } | null;
  synonymList: SynonymRow[];
  lexicon: { entries: number; brands: number; categories: number; attributes: number } | null;
  vocabulary: { total: number; bySource: Array<{ source: string; count: number }> } | null;
  ranking: RankingInfo | null;
  rankingConfigs: Array<{
    version: string;
    label: string;
    isActive: boolean;
    validation: string[];
    balance: string[];
  }>;
}

type ReindexKind = "queue" | "all" | "derived";

export function SearchAnalytics(props: SearchAnalyticsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<string | null>(null);
  const [section, setSection] = useState<string>("overview");

  function reindex(kind: ReindexKind) {
    setStatus(null);
    startTransition(async () => {
      try {
        const response = await fetch("/api/admin/search/index", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind }),
        });
        const payload = await response.json();
        if (!response.ok) {
          setStatus(`Failed: ${payload?.error?.message ?? response.statusText}`);
          return;
        }
        setStatus(describeResult(kind, payload.data));
        router.refresh();
      } catch (error) {
        setStatus(`Failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  async function toggleSynonym(row: SynonymRow) {
    setStatus(null);
    try {
      const response = await fetch(`/api/admin/search/synonyms?id=${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isActive: !row.isActive }),
      });
      if (!response.ok) {
        const payload = await response.json();
        setStatus(`Failed: ${payload?.error?.message ?? response.statusText}`);
        return;
      }
      setStatus(`"${row.term}" ${row.isActive ? "deactivated" : "activated"}.`);
      router.refresh();
    } catch (error) {
      setStatus(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return (
    <div className="mt-6 space-y-6">
      {status ? (
        <p role="status" className="rounded-card border-[1.5px] border-clay bg-cream px-4 py-3 text-sm">
          {status}
        </p>
      ) : null}

      <nav aria-label="Sections" className="flex flex-wrap gap-2">
        {SECTIONS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setSection(item.key)}
            aria-current={section === item.key}
            className={cn(
              "min-h-10 rounded-pill border-[1.5px] px-4 text-sm",
              section === item.key ? "border-ink bg-ink text-paper" : "border-clay hover:border-ink",
            )}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {section === "overview" ? (
        <section aria-label="Search overview" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Searches" value={props.overview?.totalSearches.toLocaleString("en-IN") ?? "—"} />
            <Stat label="Unique queries" value={props.overview?.uniqueQueries.toLocaleString("en-IN") ?? "—"} />
            <Stat
              label="Zero-result rate"
              value={props.overview ? `${(props.overview.zeroResultRate * 100).toFixed(1)}%` : "—"}
              alert={props.overview ? props.overview.zeroResultRate > 0.15 : false}
            />
            <Stat
              label="Click-through"
              value={props.overview ? `${(props.overview.clickThroughRate * 100).toFixed(1)}%` : "—"}
            />
            <Stat label="Avg results" value={props.overview?.averageResultCount.toFixed(1) ?? "—"} />
            <Stat
              label="Add-to-cart rate"
              value={props.overview ? `${(props.overview.addToCartRate * 100).toFixed(1)}%` : "—"}
            />
            <Stat label="Latency p50" value={props.overview ? `${props.overview.latency.p50.toFixed(0)} ms` : "—"} />
            <Stat
              label="Latency p95"
              value={props.overview ? `${props.overview.latency.p95.toFixed(0)} ms` : "—"}
              alert={props.overview ? props.overview.latency.p95 > 500 : false}
            />
            <Stat
              label="Latency p99"
              value={props.overview ? `${props.overview.latency.p99.toFixed(0)} ms` : "—"}
              alert={props.overview ? props.overview.latency.p99 > 1500 : false}
            />
            <Stat
              label="Searches / session"
              value={props.overview?.averageSearchesPerSession.toFixed(1) ?? "—"}
            />
          </div>

          <div className="rounded-card border-[1.5px] border-clay p-4">
            <h2 className="font-display text-lg font-bold uppercase">Index health</h2>
            {props.index ? (
              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <Row label="Products" value={props.index.products.toLocaleString("en-IN")} />
                <Row label="Indexed" value={props.index.indexedProducts.toLocaleString("en-IN")} />
                <Row label="Searchable" value={props.index.searchableProducts.toLocaleString("en-IN")} />
                <Row
                  label="Stale"
                  value={props.index.staleProducts.toLocaleString("en-IN")}
                  alert={props.index.staleProducts > 0}
                />
                <Row
                  label="Pending events"
                  value={props.index.pendingEvents.toLocaleString("en-IN")}
                  alert={props.index.pendingEvents > 100}
                />
                <Row
                  label="Failed events"
                  value={props.index.failedEvents.toLocaleString("en-IN")}
                  alert={props.index.failedEvents > 0}
                />
                <Row
                  label="Last indexed"
                  value={
                    props.index.lastIndexedAt
                      ? new Date(props.index.lastIndexedAt).toLocaleString("en-IN")
                      : "never"
                  }
                />
              </dl>
            ) : (
              <p className="mt-2 text-sm text-smoke">Index status unavailable.</p>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={pending} onClick={() => reindex("queue")}>
                Drain event queue
              </Button>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => reindex("derived")}>
                Rebuild vocabulary &amp; suggestions
              </Button>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => reindex("all")}>
                Reindex whole catalog
              </Button>
            </div>
          </div>

          {props.clickPositions.length > 0 ? (
            <div className="rounded-card border-[1.5px] border-clay p-4">
              <h2 className="font-display text-lg font-bold uppercase">Clicks by position</h2>
              <p className="mt-1 text-xs text-smoke">
                A healthy ranking concentrates clicks near the top. A flat line means relevance is not
                separating good matches from bad ones.
              </p>
              <ul className="mt-3 flex flex-wrap items-end gap-1">
                {props.clickPositions.slice(0, 20).map((entry) => {
                  const max = Math.max(...props.clickPositions.map((item) => item.clicks), 1);
                  const height = Math.max(4, Math.round((entry.clicks / max) * 96));
                  return (
                    <li key={entry.position} className="flex w-6 flex-col items-center gap-1">
                      <span
                        className="w-full rounded-t bg-ink/70"
                        style={{ height }}
                        title={`Position ${entry.position}: ${entry.clicks} clicks`}
                      />
                      <span className="text-[9px] text-smoke">{entry.position}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {section === "trending" ? (
        <section aria-label="Trending searches" className="space-y-4">
          <Table
            title="Most searched"
            columns={["Query", "Searches", "Avg results", "Clicks", "CTR"]}
            rows={props.popular.map((row) => [
              row.query,
              row.searches.toLocaleString("en-IN"),
              row.averageResults.toFixed(1),
              row.clicks.toLocaleString("en-IN"),
              `${(row.clickThroughRate * 100).toFixed(1)}%`,
            ])}
          />
          <Table
            title="Rising fastest"
            hint="Compared against the earlier half of the same window."
            columns={["Query", "Recent", "Earlier", "Growth"]}
            rows={props.rising.map((row) => [
              row.query,
              row.recent.toLocaleString("en-IN"),
              row.earlier.toLocaleString("en-IN"),
              `${row.growth > 0 ? "+" : ""}${(row.growth * 100).toFixed(0)}%`,
            ])}
          />
        </section>
      ) : null}

      {section === "zero" ? (
        <section aria-label="Zero-result searches" className="space-y-4">
          <Table
            title="Queries with no results"
            hint="Each of these is either a missing product, a missing synonym, or a spelling the vocabulary does not know."
            columns={["Query", "Searches", "Last seen", "Suggested fix"]}
            rows={props.zeroResults.map((row) => [
              row.query,
              row.searches.toLocaleString("en-IN"),
              row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleDateString("en-IN") : "—",
              row.suggestion ?? "—",
            ])}
          />
        </section>
      ) : null}

      {section === "relevance" ? (
        <section aria-label="Relevance" className="space-y-4">
          <Table
            title="Low click-through"
            hint="Queries that returned results nobody clicked. Usually a ranking problem, not a demand problem."
            columns={["Query", "Searches", "Clicks", "CTR"]}
            rows={props.lowClick.map((row) => [
              row.query,
              row.searches.toLocaleString("en-IN"),
              row.clicks.toLocaleString("en-IN"),
              `${(row.clickThroughRate * 100).toFixed(1)}%`,
            ])}
          />

          {props.ranking ? (
            <div className="rounded-card border-[1.5px] border-clay p-4">
              <h2 className="font-display text-lg font-bold uppercase">
                Ranking {props.ranking.version} — {props.ranking.label}
              </h2>
              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
                <Row label="Out-of-stock mode" value={props.ranking.outOfStockMode} />
                <Row label="Fuzzy threshold" value={props.ranking.fuzzyThreshold.toFixed(2)} />
                <Row label="Max edit distance" value={String(props.ranking.maxEditDistance)} />
              </dl>
              <h3 className="mt-4 font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">Weights</h3>
              <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
                {Object.entries(props.ranking.weights).map(([key, value]) => (
                  <Row key={key} label={key} value={String(value)} />
                ))}
              </dl>
            </div>
          ) : null}

          {props.rankingConfigs.length > 0 ? (
            <div className="rounded-card border-[1.5px] border-clay p-4">
              <h2 className="font-display text-lg font-bold uppercase">Ranking versions</h2>
              <ul className="mt-3 space-y-2 text-sm">
                {props.rankingConfigs.map((config) => (
                  <li key={config.version} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">{config.version}</span>
                    <span className="text-smoke">{config.label}</span>
                    {config.isActive ? (
                      <span className="rounded-full bg-ink px-2 py-0.5 text-[10px] uppercase text-paper">
                        Active
                      </span>
                    ) : null}
                    {config.validation.length > 0 ? (
                      <span className="text-flame">invalid: {config.validation.join("; ")}</span>
                    ) : null}
                    {config.balance.length > 0 ? (
                      <span className="text-flame">unbalanced: {config.balance.join("; ")}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {section === "synonyms" ? (
        <section aria-label="Synonyms" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Synonyms" value={props.synonyms ? String(props.synonyms.total) : "—"} />
            <Stat
              label="Two-way"
              value={props.synonyms ? String(props.synonyms.bidirectional) : "—"}
            />
            <Stat label="Inactive" value={props.synonyms ? String(props.synonyms.inactive) : "—"} />
          </div>

          <p className="text-xs text-smoke">
            A one-way synonym expands the query only. A two-way synonym expands both directions, which
            is stronger and riskier — prefer one-way unless the terms are genuinely interchangeable.
          </p>

          <Table
            title="All synonyms"
            columns={["Term", "Synonym", "Direction", "Active", ""]}
            rows={props.synonymList.map((row) => [
              row.term,
              row.synonym,
              row.isBidirectional ? "two-way" : "one-way",
              row.isActive ? "yes" : "no",
              row.id,
            ])}
            renderLastCell={(value) => {
              const row = props.synonymList.find((entry) => entry.id === value);
              if (!row) return null;
              return (
                <Button size="sm" variant="outline" onClick={() => void toggleSynonym(row)}>
                  {row.isActive ? "Deactivate" : "Activate"}
                </Button>
              );
            }}
          />

          {props.vocabulary ? (
            <div className="rounded-card border-[1.5px] border-clay p-4">
              <h2 className="font-display text-lg font-bold uppercase">
                Correction vocabulary — {props.vocabulary.total.toLocaleString("en-IN")} terms
              </h2>
              <p className="mt-1 text-xs text-smoke">
                Spell correction may only correct to a term in this list, so a typo is fixed against
                words this catalog actually uses.
              </p>
              <ul className="mt-3 flex flex-wrap gap-2 text-xs">
                {props.vocabulary.bySource.map((source) => (
                  <li key={source.source} className="rounded-pill border-[1.5px] border-clay px-3 py-1">
                    {source.source}: {source.count.toLocaleString("en-IN")}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {props.lexicon ? (
            <div className="rounded-card border-[1.5px] border-clay p-4">
              <h2 className="font-display text-lg font-bold uppercase">Entity lexicon</h2>
              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-4">
                <Row label="Entries" value={props.lexicon.entries.toLocaleString("en-IN")} />
                <Row label="Brands" value={props.lexicon.brands.toLocaleString("en-IN")} />
                <Row label="Categories" value={props.lexicon.categories.toLocaleString("en-IN")} />
                <Row label="Attributes" value={props.lexicon.attributes.toLocaleString("en-IN")} />
              </dl>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

const SECTIONS = [
  { key: "overview", label: "Overview" },
  { key: "trending", label: "Trending" },
  { key: "zero", label: "Zero results" },
  { key: "relevance", label: "Relevance" },
  { key: "synonyms", label: "Synonyms" },
] as const;

function describeResult(kind: ReindexKind, data: unknown): string {
  const value = (data ?? {}) as Record<string, unknown>;
  if (kind === "queue") {
    return `Queue drained: ${value.processed ?? 0} indexed, ${value.failed ?? 0} failed, ${value.skipped ?? 0} skipped.`;
  }
  if (kind === "derived") {
    return `Vocabulary rebuilt: ${value.vocabularyTerms ?? 0} terms, ${value.suggestionRows ?? 0} suggestions, ${value.observedTerms ?? 0} observed terms.`;
  }
  return `Reindex complete: ${value.indexed ?? 0} indexed, ${value.failed ?? 0} failed, ${value.pending ?? 0} still pending.`;
}

function Stat({ label, value, alert = false }: { label: string; value: string; alert?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-card border-[1.5px] p-4",
        alert ? "border-flame bg-flame/5" : "border-clay",
      )}
    >
      <dt className="font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">{label}</dt>
      <dd className="mt-1 font-display text-2xl font-extrabold">{value}</dd>
    </div>
  );
}

function Row({ label, value, alert = false }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-smoke">{label}</dt>
      <dd className={cn("font-mono text-sm", alert && "text-flame")}>{value}</dd>
    </div>
  );
}

function Table({
  title,
  hint,
  columns,
  rows,
  renderLastCell,
}: {
  title: string;
  hint?: string;
  columns: string[];
  rows: string[][];
  renderLastCell?: (value: string) => React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-card border-[1.5px] border-clay">
      <div className="border-b border-clay p-4">
        <h2 className="font-display text-lg font-bold uppercase">{title}</h2>
        {hint ? <p className="mt-1 text-xs text-smoke">{hint}</p> : null}
      </div>
      {rows.length === 0 ? (
        <p className="p-4 text-sm text-smoke">Nothing recorded in this window yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-clay text-left">
                {columns.map((column, index) => (
                  <th
                    key={column || index}
                    scope="col"
                    className="px-4 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-smoke"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-clay/60 last:border-0">
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className="px-4 py-2">
                      {renderLastCell && cellIndex === row.length - 1
                        ? renderLastCell(cell)
                        : cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
