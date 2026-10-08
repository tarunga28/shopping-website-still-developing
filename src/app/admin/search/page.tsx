import { AdminShell } from "@/components/layouts/admin-shell";
import { SearchAnalytics } from "@/components/admin/search-analytics";
import { ErrorState } from "@/components/ui/error-state";
import { requireCatalogEditor } from "@/server/auth/catalog-access";
import {
  clickPositions,
  lowClickQueries,
  popularQueries,
  risingQueries,
  searchOverview,
  zeroResultQueries,
} from "@/services/search/analytics.service";
import { indexStatus } from "@/services/search/index.service";
import { listSynonyms, synonymStats } from "@/services/search/synonym.service";
import { lexiconStats } from "@/services/search/lexicon.service";
import { vocabularyStats } from "@/services/search/vocabulary.service";
import { getActiveRankingConfig, listRankingConfigs } from "@/services/search/config.service";
import { assertLayerBalance } from "@/lib/search/ranking";

export const dynamic = "force-dynamic";

/**
 * The search operations dashboard.
 *
 * Data is loaded on the server and handed to one client component for the
 * interactive parts. That keeps the page server-rendered (so it is fast and its
 * numbers are correct on first paint) while still letting the operator switch
 * windows, expand tables, and trigger a reindex without a full reload.
 *
 * Every loader is individually caught. Search analytics is a monitoring surface,
 * and a monitoring surface that fails wholesale when one query is slow is worse
 * than one that shows the eight things it could load.
 */
export default async function AdminSearchPage() {
  await requireCatalogEditor();

  const [
    overview,
    popular,
    rising,
    zeroResults,
    lowClick,
    positions,
    index,
    synonyms,
    synonymList,
    lexicon,
    vocabulary,
    ranking,
    rankingConfigs,
  ] = await Promise.all([
    searchOverview({ windowDays: 30 }).catch(() => null),
    popularQueries({ windowDays: 30, limit: 20 }).catch(() => []),
    risingQueries({ windowDays: 30, limit: 10 }).catch(() => []),
    zeroResultQueries({ windowDays: 30, limit: 30 }).catch(() => []),
    lowClickQueries({ windowDays: 30, limit: 20 }).catch(() => []),
    clickPositions({ windowDays: 30 }).catch(() => []),
    indexStatus().catch(() => null),
    synonymStats().catch(() => null),
    listSynonyms({ includeInactive: true }).catch(() => []),
    lexiconStats().catch(() => null),
    vocabularyStats().catch(() => null),
    getActiveRankingConfig().catch(() => null),
    listRankingConfigs().catch(() => []),
  ]);

  if (!overview && !index) {
    return (
      <AdminShell>
        <ErrorState
          kind="api"
          title="Search analytics didn't load"
          description="Apply the Part 12 search migration (drizzle/0007_search_discovery.sql), then refresh."
        />
      </AdminShell>
    );
  }

  const balanceProblems = ranking ? assertLayerBalance(ranking.weights) : [];

  return (
    <AdminShell>
      <h1 className="font-display text-3xl font-extrabold uppercase">Search</h1>
      <p className="mt-2 max-w-prose text-sm text-smoke">
        Relevance, coverage, and what shoppers search for but cannot find. Ranking version{" "}
        <span className="font-mono">{ranking?.version ?? "unknown"}</span>.
      </p>

      {balanceProblems.length > 0 ? (
        <div className="mt-4 rounded-card border-[1.5px] border-flame bg-flame/5 p-4 text-sm">
          <h2 className="font-bold uppercase tracking-[0.12em]">Ranking is unbalanced</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {balanceProblems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <SearchAnalytics
        overview={overview}
        index={
          index
            ? {
                products: index.products,
                indexedProducts: index.indexedProducts,
                searchableProducts: index.searchableProducts,
                staleProducts: index.staleProducts,
                pendingEvents: index.pendingEvents,
                failedEvents: index.failedEvents,
                // Serialized here, not in the component: a Date that crosses the
                // server/client boundary is a string by the time it is read.
                lastIndexedAt: index.lastIndexedAt ? index.lastIndexedAt.toISOString() : null,
              }
            : null
        }
        popular={popular.map((row) => ({ ...row, lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null }))}
        rising={rising}
        zeroResults={zeroResults.map((row) => ({
          ...row,
          lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
        }))}
        lowClick={lowClick}
        clickPositions={positions}
        synonyms={synonyms}
        synonymList={synonymList.map((row) => ({
          id: row.id,
          term: row.term,
          synonym: row.synonym,
          isBidirectional: row.isBidirectional,
          isActive: row.isActive,
        }))}
        lexicon={lexicon}
        vocabulary={vocabulary}
        ranking={
          ranking
            ? {
                version: ranking.version,
                label: ranking.label,
                outOfStockMode: ranking.outOfStockMode,
                fuzzyThreshold: ranking.fuzzyThreshold,
                maxEditDistance: ranking.maxEditDistance,
                weights: ranking.weights,
              }
            : null
        }
        rankingConfigs={rankingConfigs.map((config) => ({
          version: config.version,
          label: config.label,
          isActive: config.isActive,
          validation: config.validation,
          balance: config.balance,
        }))}
      />
    </AdminShell>
  );
}
