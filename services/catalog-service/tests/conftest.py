"""Shared fixtures.

No PostgreSQL is needed to run this suite: `CatalogDatabase` is replaced with a
fake that implements the same read methods over in-memory rows. That keeps the
tests fast and, more importantly, keeps them testing *this service's* logic
rather than whatever the local database happens to contain.

The native ranking engine is real — `libcppsearch.so` is loaded and exercised —
because the ctypes boundary is exactly the kind of thing a fake would hide a bug
in.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

# Make `app` importable when pytest is invoked from the service directory.
SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from app.config import Settings  # noqa: E402
from app.db import LowStockRow, QueryStat, SearchIndexRow  # noqa: E402
from app.intelligence import CatalogIntelligence  # noqa: E402
from app.ranking import RankingEngine, load_engine  # noqa: E402


def _row(
    product_id: str,
    name: str,
    **overrides: Any,
) -> SearchIndexRow:
    """Build a search-index row with sensible defaults."""
    values: dict[str, Any] = {
        "product_id": product_id,
        "slug": overrides.pop("slug", name.lower().replace(" ", "-")),
        "name": name,
        "brand_name": overrides.pop("brand_name", None),
        "brand_id": overrides.pop("brand_id", None),
        "category_id": overrides.pop("category_id", None),
        "category_path": overrides.pop("category_path", None),
        "sku_text": overrides.pop("sku_text", ""),
        "tag_text": overrides.pop("tag_text", ""),
        "attribute_text": overrides.pop("attribute_text", ""),
        "description_text": overrides.pop("description_text", ""),
        "price_paise": overrides.pop("price_paise", 49900),
        "compare_at_paise": overrides.pop("compare_at_paise", None),
        "rating_average": overrides.pop("rating_average", None),
        "rating_count": overrides.pop("rating_count", 0),
        "popularity": overrides.pop("popularity", 0.0),
    }
    values.update(overrides)
    return SearchIndexRow(**values)


@pytest.fixture(scope="session")
def sample_rows() -> list[SearchIndexRow]:
    """A small catalog covering the cases the ranking tests care about."""
    return [
        _row(
            "p-phone",
            "Apple iPhone 17 Pro Max 256GB",
            brand_name="Apple",
            brand_id="b-apple",
            category_id="c-phones",
            category_path="electronics phones",
            sku_text="APH-17PM-256",
            tag_text="flagship smartphone 5g",
            attribute_text="storage 256gb color titanium",
            description_text="Titanium frame with the A19 Pro chip.",
            price_paise=13490000,
            compare_at_paise=14990000,
            rating_average=4.7,
            rating_count=212,
            popularity=88.0,
        ),
        _row(
            "p-case",
            "Silicone Case for iPhone 17",
            brand_name="Inkline",
            brand_id="b-inkline",
            category_id="c-accessories",
            category_path="electronics accessories cases",
            sku_text="INK-CASE-17",
            tag_text="protective cover",
            attribute_text="color black material silicone",
            description_text="A soft-touch cover with raised edges.",
            price_paise=79900,
            rating_average=4.2,
            rating_count=31,
            popularity=41.0,
        ),
        _row(
            "p-tee",
            "Organic Cotton Tee",
            brand_name="Inkline",
            brand_id="b-inkline",
            category_id="c-apparel",
            category_path="apparel t-shirts",
            sku_text="INK-TEE-ORG",
            tag_text="unisex gift organic",
            attribute_text="size m color white material cotton",
            description_text="Heavyweight combed cotton, pre-shrunk.",
            price_paise=89900,
            compare_at_paise=119900,
            rating_average=4.5,
            rating_count=88,
            popularity=63.0,
        ),
        _row(
            "p-mug",
            "Ceramic Mug 350ml",
            brand_name="Inkline",
            brand_id="b-inkline",
            category_id="c-home",
            category_path="home kitchen",
            sku_text="INK-MUG-350",
            tag_text="gift dishwasher safe",
            attribute_text="capacity 350ml",
            description_text="Stoneware with a matte glaze.",
            price_paise=34900,
            rating_average=4.0,
            rating_count=12,
            popularity=25.0,
        ),
    ]


@pytest.fixture(scope="session")
def engine() -> RankingEngine:
    """A real native engine, loaded once for the whole session."""
    loaded = load_engine()
    yield loaded
    loaded.close()


@pytest.fixture
def populated_engine(engine: RankingEngine, sample_rows: list[SearchIndexRow]) -> RankingEngine:
    """The real engine holding the sample catalog.

    Rebuilt per test: `clear()` is cheap and isolation between tests is worth
    more than the few milliseconds saved by sharing state.
    """
    engine.clear()
    from app.intelligence import _to_document

    engine.upsert_many(_to_document(row) for row in sample_rows)
    return engine


class FakeCatalogDatabase:
    """Stands in for `CatalogDatabase`.

    Implements the read methods `CatalogIntelligence` calls, over the sample
    rows. Records the arguments it was called with so tests can assert on
    eligibility narrowing, which is the part of the contract most likely to
    regress silently.
    """

    def __init__(self, rows: list[SearchIndexRow]) -> None:
        self.rows = {row.product_id: row for row in rows}
        self.candidate_calls: list[dict[str, Any]] = []
        self.suggestions: list[tuple[str, int]] = [("iphone case", 40), ("iphone 17", 12)]
        self.related: dict[str, list[str]] = {}
        self.low_stock_rows: list[LowStockRow] = []
        self.stock_summary_values: tuple[int, int, int] = (4, 0, 0)
        self.query_stats: dict[str, Any] = {
            "total": 100,
            "zero_result_rate": 0.1,
            "average_took_ms": 12.5,
            "top": [QueryStat("iphone", 30, _now())],
            "zero": [QueryStat("definitely not a thing", 3, _now())],
        }
        self.database_ok = True

    def ping(self) -> bool:
        return self.database_ok

    def load_search_documents(
        self, *, limit: int, cursor: str | None = None
    ) -> list[SearchIndexRow]:
        ordered = sorted(self.rows.values(), key=lambda row: row.product_id)
        if cursor is not None:
            ordered = [row for row in ordered if row.product_id > cursor]
        return ordered[:limit]

    def fetch_search_rows(self, product_ids) -> dict[str, SearchIndexRow]:
        return {
            product_id: self.rows[product_id]
            for product_id in product_ids
            if product_id in self.rows
        }

    def candidate_ids(self, **filters: Any) -> list[str]:
        self.candidate_calls.append(filters)
        selected = list(self.rows.values())

        category_id = filters.get("category_id")
        if category_id:
            selected = [row for row in selected if row.category_id == category_id]
        brand_id = filters.get("brand_id")
        if brand_id:
            selected = [row for row in selected if row.brand_id == brand_id]
        min_price = filters.get("min_price")
        if min_price is not None:
            selected = [row for row in selected if row.price_paise >= min_price]
        max_price = filters.get("max_price")
        if max_price is not None:
            selected = [row for row in selected if row.price_paise <= max_price]

        return [row.product_id for row in selected][: filters.get("limit", 5000)]

    def suggest_terms(self, prefix: str, limit: int = 10) -> list[tuple[str, int]]:
        return [
            (term, weight)
            for term, weight in self.suggestions
            if term.startswith(prefix.lower())
        ][:limit]

    def related_ids(self, source_id: str, relation_type: str, limit: int) -> list[str]:
        return self.related.get(f"{relation_type}:{source_id}", [])[:limit]

    def popular_ids(self, limit: int, exclude=()) -> list[str]:
        ordered = sorted(
            self.rows.values(), key=lambda row: -(row.popularity or 0.0)
        )
        return [
            row.product_id
            for row in ordered
            if row.product_id not in set(exclude)
        ][:limit]

    def low_stock(self, limit: int = 50) -> list[LowStockRow]:
        return self.low_stock_rows[:limit]

    def stock_summary(self) -> tuple[int, int, int]:
        return self.stock_summary_values

    def query_insights(self, window_days: int, top_limit: int = 10) -> dict[str, Any]:
        return dict(self.query_stats)


def _now() -> datetime:
    return datetime.now(timezone.utc)


@pytest.fixture
def fake_db(sample_rows: list[SearchIndexRow]) -> FakeCatalogDatabase:
    return FakeCatalogDatabase(sample_rows)


@pytest.fixture
def settings() -> Settings:
    """Settings with no database URL, so nothing can reach a real database."""
    return Settings(
        environment="test",
        database_url="",
        index_refresh_seconds=5,
        cppsearch_library="",
    )


@pytest.fixture
def intelligence(
    fake_db: FakeCatalogDatabase, populated_engine: RankingEngine, settings: Settings
) -> CatalogIntelligence:
    """A fully wired service with a real engine and a fake database."""
    return CatalogIntelligence(fake_db, populated_engine, settings)


@pytest.fixture
def intelligence_without_engine(
    fake_db: FakeCatalogDatabase, settings: Settings
) -> CatalogIntelligence:
    """The same service with no native engine, exercising the fallback path."""
    return CatalogIntelligence(fake_db, None, settings)
