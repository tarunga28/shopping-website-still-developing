"""Tests for the orchestration layer.

The point of these is the *division of labour*: eligibility comes from the
database, ranking comes from the engine, and a missing engine degrades rather
than breaks. Each test names the behaviour it is protecting.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.db import LowStockRow
from app.intelligence import CatalogIntelligence, _band, _normalize
from app.schemas import RecommendationRequest, SearchRequest


# ── search ────────────────────────────────────────────────────────────────


def test_search_returns_ranked_hits(intelligence: CatalogIntelligence) -> None:
    response = intelligence.search(SearchRequest(query="iPhone 17 Pro Max 256GB"))
    assert response.source == "native"
    assert response.hits
    assert response.hits[0].id == "p-phone"
    # Scores are comparable within one response; the top hit must lead.
    assert all(hit.score <= response.hits[0].score for hit in response.hits)


def test_search_reports_a_normalized_query(intelligence: CatalogIntelligence) -> None:
    response = intelligence.search(SearchRequest(query="  Cotton   TEE "))
    assert response.normalized_query == "cotton tee"


def test_search_measures_its_own_latency(intelligence: CatalogIntelligence) -> None:
    response = intelligence.search(SearchRequest(query="tee"))
    assert response.took_ms >= 0


def test_search_narrows_candidates_in_the_database(
    intelligence: CatalogIntelligence, fake_db
) -> None:
    """Filtering must happen in SQL, not after ranking.

    Ranking the whole catalog and throwing away the mismatches would be both
    slow and wrong: an out-of-stock product could occupy a top slot and then
    disappear, leaving a short page.
    """
    intelligence.search(
        SearchRequest(query="phone", category_id="c-phones", min_price=100000)
    )
    assert fake_db.candidate_calls, "eligibility was never pushed to the database"
    call = fake_db.candidate_calls[-1]
    assert call["category_id"] == "c-phones"
    assert call["min_price"] == 100000


def test_search_excludes_ineligible_products_even_when_the_engine_returns_them(
    intelligence: CatalogIntelligence, populated_engine
) -> None:
    """The native index can lag a product being unpublished.

    The engine will happily rank a stale document; the database is the authority
    on eligibility, so a stale hit must be dropped rather than shown.
    """
    populated_engine.upsert(
        __import__("app.ranking", fromlist=["Document"]).Document(
            id="p-removed", name="Unpublished iPhone Pro", popularity=99.0
        )
    )
    response = intelligence.search(SearchRequest(query="iphone pro"))
    assert all(hit.id != "p-removed" for hit in response.hits)


def test_search_offers_suggestions_only_when_nothing_matched(
    intelligence: CatalogIntelligence,
) -> None:
    # Prefix/fuzzy off, so "iphonezzz" matches nothing but its first three
    # characters still line up with real search history.
    empty = intelligence.search(
        SearchRequest(query="iphonezzz", prefix=False, fuzzy=False)
    )
    assert empty.hits == ()
    assert empty.suggestions, "an empty result page should offer a way forward"
    assert empty.suggestions[0].startswith("iphone")

    found = intelligence.search(SearchRequest(query="tee"))
    assert found.hits
    assert found.suggestions == ()


def test_search_does_not_suggest_unrelated_history(
    intelligence: CatalogIntelligence,
) -> None:
    """A suggestion must share a prefix with the query.

    Offering "iphone case" for a query that has nothing to do with it is worse
    than offering nothing, so an unrelated zero-result query stays silent.
    """
    empty = intelligence.search(
        SearchRequest(query="zzzzzzzzz", prefix=False, fuzzy=False)
    )
    assert empty.hits == ()
    assert empty.suggestions == ()


def test_search_works_without_the_native_engine(
    intelligence_without_engine: CatalogIntelligence,
) -> None:
    """A missing shared library must degrade search, not break it."""
    response = intelligence_without_engine.search(SearchRequest(query="cotton tee"))
    assert response.source == "database"
    assert response.hits
    assert response.hits[0].id == "p-tee"


def test_fallback_ranking_still_requires_every_term(
    intelligence_without_engine: CatalogIntelligence,
) -> None:
    response = intelligence_without_engine.search(SearchRequest(query="cotton refrigerator"))
    assert response.hits == ()


def test_fallback_ranking_prefers_a_name_match(
    intelligence_without_engine: CatalogIntelligence,
) -> None:
    response = intelligence_without_engine.search(SearchRequest(query="iphone"))
    names = [hit.name for hit in response.hits]
    assert "Apple iPhone 17 Pro Max 256GB" in names


# ── index lifecycle ───────────────────────────────────────────────────────


def test_refresh_index_loads_every_sample_row(
    intelligence: CatalogIntelligence, populated_engine
) -> None:
    documents = intelligence.refresh_index(force=True)
    assert documents == 4
    assert populated_engine.document_count == 4


def test_refresh_is_skipped_while_the_interval_has_not_elapsed(
    intelligence: CatalogIntelligence, fake_db
) -> None:
    intelligence.refresh_index(force=True)
    calls_before = len(fake_db.candidate_calls)

    # Not forced, and the 5-second interval has not passed.
    intelligence.refresh_if_stale()
    assert len(fake_db.candidate_calls) == calls_before


def test_index_stats_report_the_engine_state(intelligence: CatalogIntelligence) -> None:
    intelligence.refresh_index(force=True)
    stats = intelligence.index_stats()
    assert stats.available is True
    assert stats.documents == 4
    assert stats.version
    assert stats.last_refresh_at is not None


def test_index_stats_report_unavailable_when_there_is_no_engine(
    intelligence_without_engine: CatalogIntelligence,
) -> None:
    stats = intelligence_without_engine.index_stats()
    assert stats.available is False
    assert stats.documents == 0


def test_a_failed_refresh_serves_the_existing_index(
    intelligence: CatalogIntelligence, fake_db, populated_engine
) -> None:
    """A database blip must not empty the index.

    Emptying it would turn a transient error into a storefront-wide "no results"
    page, which is far worse than serving results that are a few minutes old.
    """
    from app.db import DatabaseUnavailable

    intelligence.refresh_index(force=True)
    assert populated_engine.document_count == 4

    intelligence._last_refresh_at = None  # force staleness

    def explode(**_kwargs) -> list:
        raise DatabaseUnavailable("connection reset")

    fake_db.load_search_documents = explode  # type: ignore[method-assign]
    intelligence.refresh_if_stale()  # must not raise

    assert populated_engine.document_count == 4


# ── suggestions ───────────────────────────────────────────────────────────


def test_suggest_prefers_observed_history(intelligence: CatalogIntelligence) -> None:
    response = intelligence.suggest("iphone")
    assert response.suggestions
    assert response.suggestions[0].kind == "history"
    assert response.suggestions[0].weight > 0


def test_suggest_falls_back_to_the_vocabulary(
    intelligence: CatalogIntelligence, fake_db
) -> None:
    fake_db.suggestions = []  # a brand-new catalog has no search history
    response = intelligence.suggest("cot")
    assert any(item.kind == "vocabulary" for item in response.suggestions)


def test_suggest_never_exceeds_the_limit(intelligence: CatalogIntelligence) -> None:
    assert len(intelligence.suggest("i", limit=2).suggestions) <= 2


# ── recommendations ───────────────────────────────────────────────────────


def test_recommend_rejects_both_a_product_and_seeds(
    intelligence: CatalogIntelligence,
) -> None:
    with pytest.raises(ValueError, match="not both"):
        intelligence.recommend(
            RecommendationRequest(product_id="p-phone", seed_ids=("p-tee",))
        )


def test_recommend_popular_excludes_the_seeds(intelligence: CatalogIntelligence) -> None:
    response = intelligence.recommend(
        RecommendationRequest(product_id="p-phone", strategy="popular", limit=3)
    )
    assert response.strategy == "popular"
    assert "p-phone" not in [item.id for item in response.items]


def test_recommend_uses_curated_relations_first(
    intelligence: CatalogIntelligence, fake_db
) -> None:
    fake_db.related["FREQUENTLY_BOUGHT_TOGETHER:p-phone"] = ["p-case"]
    response = intelligence.recommend(
        RecommendationRequest(product_id="p-phone", strategy="complementary", limit=3)
    )
    assert response.items
    assert response.items[0].id == "p-case"


def test_recommend_similar_stays_in_the_same_category(
    intelligence: CatalogIntelligence,
) -> None:
    response = intelligence.recommend(
        RecommendationRequest(product_id="p-tee", strategy="similar", limit=5)
    )
    ids = [item.id for item in response.items]
    assert "p-tee" not in ids
    # The only other apparel item is the mug? No — the mug is `home`. So the
    # category filter should leave nothing, and that is the correct answer.
    assert all(item.category_path is None or "apparel" in (item.category_path or "")
               for item in response.items)


def test_recommend_similar_for_an_unknown_product_returns_nothing(
    intelligence: CatalogIntelligence,
) -> None:
    response = intelligence.recommend(
        RecommendationRequest(product_id="does-not-exist", strategy="similar")
    )
    assert response.items == ()


# ── inventory insights ────────────────────────────────────────────────────


def test_inventory_insights_reports_low_stock_and_mismatches(
    intelligence: CatalogIntelligence, fake_db
) -> None:
    fake_db.low_stock_rows = [
        LowStockRow(
            product_id="p-tee",
            name="Organic Cotton Tee",
            sku="INK-TEE-ORG",
            stock_quantity=2,
            reserved_quantity=1,
            low_stock_threshold=5,
        )
    ]
    fake_db.stock_summary_values = (4, 1, 2)

    response = intelligence.inventory_insights()
    assert response.out_of_stock_count == 1
    assert response.total_tracked_products == 4
    # A non-zero mismatch count is surfaced rather than swallowed: it means a
    # writer bypassed the transactional inventory engine.
    assert response.ledger_mismatches == 2
    assert response.low_stock[0].shortfall == 5 - (2 - 1)


def test_inventory_insights_handles_an_empty_catalog(
    intelligence: CatalogIntelligence, fake_db
) -> None:
    fake_db.stock_summary_values = (0, 0, 0)
    response = intelligence.inventory_insights()
    assert response.low_stock == ()
    assert response.ledger_mismatches == 0


# ── query insights ────────────────────────────────────────────────────────


def test_query_insights_shapes_the_aggregates(intelligence: CatalogIntelligence) -> None:
    response = intelligence.query_insights(window_days=7)
    assert response.window_days == 7
    assert response.total_searches == 100
    assert 0 <= response.zero_result_rate <= 1
    assert response.top_queries[0].query == "iphone"
    assert response.zero_result_queries[0].query == "definitely not a thing"


# ── helpers ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("available", "expected"),
    [(0, "none"), (1, "few"), (5, "few"), (6, "some"), (25, "some"), (26, "many")],
)
def test_availability_bands(available: int, expected: str) -> None:
    """Exact counts are never exposed; the band boundaries are the contract."""
    assert _band(available) == expected


def test_band_never_returns_a_negative_availability() -> None:
    # A reserved count exceeding stock is impossible by schema, but the band
    # function must still not produce a nonsense value.
    assert _band(-3) == "none"


def test_normalize_collapses_whitespace_and_case() -> None:
    assert _normalize("  Cotton   TEE ") == "cotton tee"
    assert _normalize("") == ""
    assert _normalize(None) == ""  # type: ignore[arg-type]
