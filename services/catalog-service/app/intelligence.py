"""Search, recommendation, and inventory-insight orchestration.

The division of labour this module exists to enforce:

* **PostgreSQL** decides *eligibility* — which products are searchable, in this
  category, in this price band. It has the indexes and the authoritative data.
* **The native engine** decides *ranking* — tokenizing, matching, scoring. It is
  the part worth running natively.
* **This layer** connects them, and falls back to a database-only ranking when
  the native engine is unavailable, so a missing shared library degrades search
  quality rather than breaking the storefront.
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone
from typing import Protocol

from .config import Settings
from .db import CatalogDatabase, DatabaseUnavailable, SearchIndexRow
from .ranking import Document, RankingEngine, RankingEngineUnavailable, SearchOptions
from .schemas import (
    InventoryInsightsResponse,
    LowStockItem,
    QueryInsightsResponse,
    RecommendationRequest,
    RecommendationResponse,
    SearchHitModel,
    SearchRequest,
    SearchResponse,
    SuggestionModel,
    SuggestionResponse,
    ZeroResultQuery,
)

__all__ = ["CatalogIntelligence", "IndexStats"]

logger = logging.getLogger(__name__)


class IndexStats:
    """A snapshot of the native index, for the health endpoint."""

    __slots__ = ("documents", "vocabulary_size", "last_refresh_at", "available", "version")

    def __init__(
        self,
        documents: int = 0,
        vocabulary_size: int = 0,
        last_refresh_at: datetime | None = None,
        available: bool = False,
        version: str | None = None,
    ) -> None:
        self.documents = documents
        self.vocabulary_size = vocabulary_size
        self.last_refresh_at = last_refresh_at
        self.available = available
        self.version = version


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _band(available: int) -> str:
    """Coarse availability band.

    Exact counts are not exposed by the public API: they are trivially scraped
    and give competitors a live inventory feed. Bands are enough for a "only a
    few left" badge.
    """
    if available <= 0:
        return "none"
    if available <= 5:
        return "few"
    if available <= 25:
        return "some"
    return "many"


class CatalogIntelligence:
    """Owns the index lifecycle and serves every read.

    Thread-safe: FastAPI runs handlers on a worker pool, and the index is shared
    process-wide. Refreshes happen under a lock and are skipped if one is
    already in flight, so a burst of concurrent requests triggers one rebuild
    rather than several.
    """

    def __init__(
        self,
        database: CatalogDatabase,
        engine: RankingEngine | None,
        settings: Settings,
    ) -> None:
        self._db = database
        self._engine = engine
        self._settings = settings
        self._refresh_lock = threading.Lock()
        self._refreshing = False
        self._last_refresh_at: datetime | None = None

    # ── index lifecycle ──────────────────────────────────────────────────

    @property
    def engine(self) -> RankingEngine | None:
        return self._engine

    def index_stats(self) -> IndexStats:
        if self._engine is None:
            return IndexStats(available=False, last_refresh_at=self._last_refresh_at)
        try:
            return IndexStats(
                documents=self._engine.document_count,
                vocabulary_size=self._engine.vocabulary_size,
                last_refresh_at=self._last_refresh_at,
                available=True,
                version=self._engine.version,
            )
        except RankingEngineUnavailable:
            logger.warning("ranking engine became unavailable", exc_info=True)
            return IndexStats(available=False, last_refresh_at=self._last_refresh_at)

    def _is_stale(self) -> bool:
        if self._last_refresh_at is None:
            return True
        age = (_utc_now() - self._last_refresh_at).total_seconds()
        return age >= self._settings.index_refresh_seconds

    def refresh_index(self, *, force: bool = False) -> int:
        """Rebuild the in-memory index from PostgreSQL. Returns documents indexed.

        Skips silently when another thread is already refreshing: the goal is a
        fresh-enough index, not exactly-once refreshes.
        """
        if self._engine is None:
            return 0
        if not force and not self._is_stale():
            return self._engine.document_count
        if not self._refresh_lock.acquire(blocking=False):
            self._refreshing = True
            try:
                return self._engine.document_count
            finally:
                self._refreshing = False

        try:
            started = time.perf_counter()
            fresh: list[Document] = []
            cursor: str | None = None
            page_size = 1000
            limit = self._settings.index_max_documents

            while len(fresh) < limit:
                batch = self._db.load_search_documents(limit=page_size, cursor=cursor)
                if not batch:
                    break
                fresh.extend(_to_document(row) for row in batch)
                cursor = batch[-1].product_id

            # Build into the live index and swap by clearing only after the new
            # documents are in hand, so a failure mid-load does not leave the
            # service with an empty index.
            self._engine.clear()
            self._engine.upsert_many(fresh)
            self._last_refresh_at = _utc_now()

            logger.info(
                "ranking index refreshed: %d documents in %.0f ms",
                len(fresh),
                (time.perf_counter() - started) * 1000,
            )
            return len(fresh)
        except DatabaseUnavailable:
            logger.error("could not refresh the ranking index", exc_info=True)
            raise
        finally:
            self._refreshing = False
            self._refresh_lock.release()

    def refresh_if_stale(self) -> None:
        """Refresh when the configured interval has elapsed. Never raises.

        Called at the start of a search so index maintenance does not need a
        separate scheduler, and so one slow refresh cannot fail a request.
        """
        if self._engine is None or not self._is_stale():
            return
        try:
            self.refresh_index()
        except DatabaseUnavailable:
            # Serving a slightly stale index is better than failing the search.
            logger.warning("serving the existing index after a failed refresh")

    # ── search ───────────────────────────────────────────────────────────

    def search(self, request: SearchRequest) -> SearchResponse:
        started = time.perf_counter()
        self.refresh_if_stale()

        eligible = self._db.candidate_ids(
            category_id=request.category_id,
            brand_id=request.brand_id,
            min_price=request.min_price,
            max_price=request.max_price,
            in_stock_only=request.in_stock_only,
        )
        rows = self._db.fetch_search_rows(eligible) if eligible else {}

        ranked = self._rank(request, rows)
        hits = self._to_hits(ranked, rows)

        suggestions: tuple[str, ...] = ()
        if not hits:
            # An empty result page is where a suggestion is worth the most, and
            # the only place it does not add noise.
            suggestions = tuple(self._fallback_suggestions(request.query))

        return SearchResponse(
            query=request.query,
            normalized_query=_normalize(request.query),
            total=len(hits),
            took_ms=(time.perf_counter() - started) * 1000,
            hits=tuple(hits),
            suggestions=suggestions,
            source="native" if self._engine is not None else "database",
        )

    def _rank(
        self, request: SearchRequest, rows: dict[str, SearchIndexRow]
    ) -> list[tuple[str, float, tuple[str, ...], bool]]:
        """Rank the eligible rows. Returns (id, score, fields, fuzzy) tuples.

        Prefers the native engine. Falls back to a lexical ranking over the
        candidate set, which is far weaker but keeps search working.
        """
        if self._engine is not None:
            try:
                options = SearchOptions(
                    prefix_last_term=request.prefix,
                    max_edit_distance=request.max_edit_distance if request.fuzzy else 0,
                    min_fuzzy_length=self._settings.min_fuzzy_length,
                    limit=min(len(rows), self._settings.search_max_limit) or 1,
                    popularity_weight=0.001,
                    rating_weight=0.01,
                )
                hits = self._engine.search(request.query, options)
                # Drop anything the database did not mark eligible: the index can
                # lag behind a product being unpublished, and showing an
                # unpublished product is worse than a slightly stale ranking.
                return [
                    (hit.id, hit.score, hit.matched_fields, hit.fuzzy)
                    for hit in hits
                    if hit.id in rows
                ]
            except RankingEngineUnavailable:
                logger.warning("native ranking failed; falling back", exc_info=True)

        return self._lexical_rank(request.query, rows)

    @staticmethod
    def _lexical_rank(
        query: str, rows: dict[str, SearchIndexRow]
    ) -> list[tuple[str, float, tuple[str, ...], bool]]:
        """A deliberately simple fallback ranking.

        Substring scoring with a name-weighted bonus. It is not competitive with
        the native engine and is not meant to be — it exists so that a missing
        shared library produces worse results rather than no results.
        """
        needle = _normalize(query)
        terms = [term for term in needle.split() if term]
        if not terms:
            return []

        scored: list[tuple[str, float, tuple[str, ...], bool]] = []
        for product_id, row in rows.items():
            haystack_name = _normalize(row.name or "")
            haystack_all = " ".join(
                [
                    haystack_name,
                    _normalize(row.brand_name or ""),
                    _normalize(row.category_path or ""),
                    _normalize(row.tag_text or ""),
                    _normalize(row.attribute_text or ""),
                    _normalize(row.sku_text or ""),
                ]
            )
            score = 0.0
            fields: list[str] = []
            matched_all = True
            for term in terms:
                if term in haystack_name:
                    score += 4.0
                    if "name" not in fields:
                        fields.append("name")
                elif term in haystack_all:
                    score += 1.0
                    if "description" not in fields:
                        fields.append("description")
                else:
                    matched_all = False

            if not matched_all:
                continue
            score += min(float(row.popularity or 0.0), 100.0) * 0.001
            scored.append((product_id, score, tuple(fields), False))

        scored.sort(key=lambda item: (-item[1], item[0]))
        return scored

    def _to_hits(
        self,
        ranked: list[tuple[str, float, tuple[str, ...], bool]],
        rows: dict[str, SearchIndexRow],
    ) -> list[SearchHitModel]:
        hits: list[SearchHitModel] = []
        for product_id, score, fields, fuzzy in ranked:
            row = rows.get(product_id)
            if row is None:
                continue
            hits.append(
                SearchHitModel(
                    id=product_id,
                    slug=row.slug or "",
                    name=row.name or "",
                    brand_name=row.brand_name,
                    category_path=row.category_path,
                    price=int(row.price_paise or 0),
                    compare_at_price=(
                        int(row.compare_at_paise) if row.compare_at_paise is not None else None
                    ),
                    rating_average=(
                        float(row.rating_average) if row.rating_average is not None else None
                    ),
                    rating_count=int(row.rating_count or 0),
                    score=round(score, 4),
                    matched_fields=fields,
                    fuzzy=fuzzy,
                )
            )
        return hits

    def _fallback_suggestions(self, query: str, limit: int = 3) -> list[str]:
        """Terms to offer when nothing matched."""
        prefix = _normalize(query)[:3]
        if not prefix:
            return []
        try:
            from_database = [term for term, _weight in self._db.suggest_terms(prefix, limit)]
        except DatabaseUnavailable:
            from_database = []
        if from_database:
            return from_database[:limit]
        if self._engine is None:
            return []
        try:
            return self._engine.complete(prefix, limit)
        except RankingEngineUnavailable:
            return []

    # ── suggestions ──────────────────────────────────────────────────────

    def suggest(self, prefix: str, limit: int = 10) -> SuggestionResponse:
        started = time.perf_counter()
        normalized = _normalize(prefix)
        suggestions: list[SuggestionModel] = []

        try:
            for term, weight in self._db.suggest_terms(normalized, limit):
                suggestions.append(
                    SuggestionModel(term=term, weight=weight, kind="history")
                )
        except DatabaseUnavailable:
            logger.warning("could not read search history for suggestions")

        # Top up from the engine's vocabulary so a brand-new catalog with no
        # search history still autocompletes.
        if len(suggestions) < limit and self._engine is not None:
            try:
                for term in self._engine.complete(normalized, limit - len(suggestions)):
                    if term not in {item.term for item in suggestions}:
                        suggestions.append(
                            SuggestionModel(term=term, weight=0, kind="vocabulary")
                        )
            except RankingEngineUnavailable:
                logger.warning("ranking engine unavailable for suggestions")

        return SuggestionResponse(
            prefix=prefix,
            suggestions=tuple(suggestions[:limit]),
            took_ms=(time.perf_counter() - started) * 1000,
        )

    # ── recommendations ──────────────────────────────────────────────────

    def recommend(self, request: RecommendationRequest) -> RecommendationResponse:
        started = time.perf_counter()

        if request.product_id and request.seed_ids:
            # Both supplied is ambiguous. Rejecting is better than silently
            # picking one, because the caller's intent differs by strategy.
            raise ValueError("supply either product_id or seed_ids, not both")

        seeds = tuple(
            [request.product_id] if request.product_id else list(request.seed_ids)
        )
        seeds = tuple(seed for seed in seeds if seed)

        if request.strategy == "popular" or not seeds:
            ordered = self._db.popular_ids(request.limit, exclude=seeds)
        elif request.strategy == "complementary":
            ordered = self._complementary(seeds, request.limit)
        else:
            ordered = self._similar(seeds, request.limit)

        rows = self._db.fetch_search_rows(ordered)
        # Preserve the strategy's ordering; fetch_search_rows returns a dict.
        ranked = [
            (product_id, 0.0, (), False) for product_id in ordered if product_id in rows
        ]

        return RecommendationResponse(
            strategy=request.strategy,
            seeds=seeds,
            items=tuple(self._to_hits(ranked, rows)),
            took_ms=(time.perf_counter() - started) * 1000,
        )

    def _complementary(self, seeds: tuple[str, ...], limit: int) -> list[str]:
        """Curated relations first, then popular fill.

        Merchandising-curated "goes well with" links beat anything inferred, so
        they take priority and the remainder is topped up with popularity.
        """
        found: list[str] = []
        for seed in seeds:
            for target in self._db.related_ids(seed, "FREQUENTLY_BOUGHT_TOGETHER", limit):
                if target not in found and target not in seeds:
                    found.append(target)
            if len(found) >= limit:
                break

        if len(found) < limit:
            for target in self._db.popular_ids(limit - len(found), exclude=seeds + tuple(found)):
                if target not in found:
                    found.append(target)
        return found[:limit]

    def _similar(self, seeds: tuple[str, ...], limit: int) -> list[str]:
        """Attribute- and text-similar products.

        Uses the native engine's attribute index when available, and falls back
        to same-category popularity. Same-brand-and-category is a weak signal
        but a cheap one, and it beats returning nothing.
        """
        if not seeds:
            return []

        rows = self._db.fetch_search_rows(seeds)
        seed_row = next((rows[seed] for seed in seeds if seed in rows), None)
        if seed_row is None:
            return []

        found: list[str] = []
        for target in self._db.related_ids(seeds[0], "RELATED", limit):
            if target not in seeds:
                found.append(target)

        if len(found) < limit:
            candidates = self._db.candidate_ids(
                category_id=seed_row.category_id,
                brand_id=seed_row.brand_id,
                limit=200,
            )
            for candidate in candidates:
                if candidate in seeds or candidate in found:
                    continue
                found.append(candidate)
                if len(found) >= limit:
                    break

        # When the engine is available, re-rank the candidates against the seed's
        # own name. This is what makes "similar" mean something beyond "same
        # category".
        if self._engine is not None and found:
            try:
                options = SearchOptions(
                    prefix_last_term=False,
                    max_edit_distance=0,
                    limit=len(found),
                )
                hits = self._engine.search(seed_row.name or "", options)
                ordering = {hit.id: index for index, hit in enumerate(hits)}
                found.sort(key=lambda product_id: ordering.get(product_id, len(ordering)))
            except RankingEngineUnavailable:
                logger.debug("native re-rank unavailable for recommendations")

        return found[:limit]

    # ── inventory insights ───────────────────────────────────────────────

    def inventory_insights(self, limit: int = 50) -> InventoryInsightsResponse:
        low_stock_rows = self._db.low_stock(limit)
        total, out_of_stock, mismatches = self._db.stock_summary()

        if mismatches:
            # This is a data-integrity alarm, not a metric. The Next.js
            # inventory engine guarantees the rollup matches the ledger inside a
            # transaction, so any drift means a writer bypassed it.
            logger.error(
                "inventory rollup disagrees with the ledger for %d products", mismatches
            )

        return InventoryInsightsResponse(
            generated_at=_utc_now(),
            low_stock=tuple(
                LowStockItem(
                    product_id=row.product_id,
                    name=row.name,
                    sku=row.sku,
                    stock_quantity=row.stock_quantity,
                    reserved_quantity=row.reserved_quantity,
                    low_stock_threshold=row.low_stock_threshold,
                    shortfall=row.shortfall,
                )
                for row in low_stock_rows
            ),
            out_of_stock_count=out_of_stock,
            total_tracked_products=total,
            ledger_mismatches=mismatches,
        )

    # ── query insights ───────────────────────────────────────────────────

    def query_insights(self, window_days: int = 30, limit: int = 10) -> QueryInsightsResponse:
        stats = self._db.query_insights(window_days, limit)
        return QueryInsightsResponse(
            generated_at=_utc_now(),
            window_days=window_days,
            total_searches=stats["total"],
            zero_result_rate=round(stats["zero_result_rate"], 4),
            average_took_ms=round(stats["average_took_ms"], 2),
            top_queries=tuple(
                ZeroResultQuery(
                    query=item.query,
                    occurrences=item.occurrences,
                    last_seen_at=item.last_seen_at,
                )
                for item in stats["top"]
            ),
            zero_result_queries=tuple(
                ZeroResultQuery(
                    query=item.query,
                    occurrences=item.occurrences,
                    last_seen_at=item.last_seen_at,
                )
                for item in stats["zero"]
            ),
        )


# ── helpers ───────────────────────────────────────────────────────────────


def _normalize(text: str) -> str:
    """Lowercase and collapse whitespace, matching the tokenizer's first step."""
    return " ".join((text or "").lower().split())


def _to_document(row: SearchIndexRow) -> Document:
    """Map a `product_search_index` row onto an engine document.

    Stock is intentionally absent from the searchable text: "in stock" is a
    filter, and indexing it would let a query for "stock" match everything.
    """
    return Document(
        id=row.product_id,
        name=row.name or "",
        brand=row.brand_name or "",
        category_path=row.category_path or "",
        tags=row.tag_text or "",
        attributes=row.attribute_text or "",
        skus=row.sku_text or "",
        description=row.description_text or "",
        price_minor_units=int(row.price_paise or 0),
        popularity=float(row.popularity or 0.0),
        rating=float(row.rating_average or 0.0),
        rating_count=int(row.rating_count or 0),
    )
