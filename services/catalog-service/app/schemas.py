"""Pydantic schemas — the public contract of this service.

Two rules shape everything here:

1. **Every input is bounded.** A limit of 10000 or a 10 MB query string is a
   denial-of-service vector, not a feature. Field constraints reject it before
   any handler runs.

2. **No internal fields leave.** This service returns what a shopper-facing or
   merchandising-facing client needs: ids, names, prices, scores. Cost prices,
   supplier references, seller internals, and session hashes stay in the
   database.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

__all__ = [
    "SearchRequest",
    "SearchHitModel",
    "SearchResponse",
    "SuggestionModel",
    "SuggestionResponse",
    "RecommendationRequest",
    "RecommendationResponse",
    "InventorySignal",
    "LowStockItem",
    "InventoryInsightsResponse",
    "QueryInsightsResponse",
    "ZeroResultQuery",
    "IndexStats",
    "HealthResponse",
]

# A query longer than this is not a search, it is a paste. The Next.js layer
# enforces the same bound, and having it here too means a direct caller cannot
# bypass it.
MAX_QUERY_LENGTH = 120

# Money is integer minor units (paise) end to end. Floats never appear in a
# price field, because a price that renders as 498.99999 is a bug users notice.
PriceMinor = int


class _Model(BaseModel):
    """Shared config: forbid unknown fields so a typo in a client is an error."""

    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)


class SearchRequest(_Model):
    """A search request.

    `filters` are applied by the caller's own data layer before ranking: this
    service ranks, it does not decide which products are eligible.
    """

    query: str = Field(min_length=1, max_length=MAX_QUERY_LENGTH)
    limit: int = Field(default=20, ge=1, le=100)
    offset: int = Field(default=0, ge=0, le=10_000)
    # Prefix expansion is right for a live search box and wrong for a submitted
    # search, where "shoe" should not also return "shoelace".
    prefix: bool = True
    fuzzy: bool = True
    max_edit_distance: int = Field(default=1, ge=0, le=3)
    category_id: str | None = Field(default=None, max_length=36)
    brand_id: str | None = Field(default=None, max_length=36)
    min_price: PriceMinor | None = Field(default=None, ge=0)
    max_price: PriceMinor | None = Field(default=None, ge=0)
    in_stock_only: bool = False
    # An opaque per-visitor value used to group queries for insight reporting.
    # Must be a hash: this service never receives or stores a raw IP or user id.
    session_hash: str | None = Field(default=None, max_length=64)

    @field_validator("max_price")
    @classmethod
    def _bounds_are_sane(cls, value: int | None, info) -> int | None:
        minimum = info.data.get("min_price")
        if value is not None and minimum is not None and value < minimum:
            raise ValueError("max_price must not be below min_price")
        return value

    @field_validator("session_hash")
    @classmethod
    def _session_hash_is_hex(cls, value: str | None) -> str | None:
        if value is None:
            return None
        # Hex-only keeps this field unusable as a place to smuggle an email
        # address or an IP address into the log table.
        try:
            bytes.fromhex(value)
        except ValueError as exc:
            raise ValueError("session_hash must be a hex digest") from exc
        return value


class SearchHitModel(_Model):
    """One ranked result.

    Only what a client needs to render a card. Prices are minor units; the
    client formats them, because currency presentation is a storefront concern.
    """

    id: str
    slug: str
    name: str
    brand_name: str | None = None
    category_path: str | None = None
    price: PriceMinor = Field(ge=0, description="Minor units (paise); never a float")
    compare_at_price: PriceMinor | None = Field(default=None, ge=0)
    rating_average: float | None = Field(default=None, ge=0, le=5)
    rating_count: int = Field(default=0, ge=0)
    score: float = Field(
        default=0.0,
        description=(
            "Relevance score, comparable within one response only. Defaults to 0 "
            "because recommendations are ordered by a strategy rather than by a "
            "text-relevance score."
        ),
    )
    matched_fields: tuple[str, ...] = ()
    fuzzy: bool = Field(default=False, description="At least one term matched only approximately")


class SearchResponse(_Model):
    query: str
    """The normalized query, so a client can display what was actually searched. """
    normalized_query: str
    total: int = Field(ge=0)
    took_ms: float = Field(ge=0)
    hits: tuple[SearchHitModel, ...] = ()
    suggestions: tuple[str, ...] = Field(
        default=(), description="Corrections offered when the exact query matched nothing"
    )
    source: Literal["native", "database"] = Field(
        description="Which engine produced the ranking"
    )


class SuggestionModel(_Model):
    term: str
    weight: int = Field(ge=0, description="How often this term has been searched")
    kind: Literal["history", "vocabulary"] = Field(
        description="history = observed queries, vocabulary = terms in the index"
    )


class SuggestionResponse(_Model):
    prefix: str
    suggestions: tuple[SuggestionModel, ...] = ()
    took_ms: float = Field(ge=0)


class RecommendationRequest(_Model):
    """Recommendations for one product, or for a basket.

    Exactly one of `product_id` / `seed_ids` must be supplied. Sending both is
    ambiguous, so it is rejected rather than guessed at.
    """

    product_id: str | None = Field(default=None, max_length=36)
    seed_ids: tuple[str, ...] = Field(default=(), max_length=20)
    limit: int = Field(default=8, ge=1, le=24)
    strategy: Literal["similar", "complementary", "popular"] = "similar"
    category_id: str | None = Field(default=None, max_length=36)

    @field_validator("seed_ids")
    @classmethod
    def _no_empty_seeds(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if any(not seed for seed in value):
            raise ValueError("seed_ids must not contain empty strings")
        return value


class RecommendationResponse(_Model):
    strategy: Literal["similar", "complementary", "popular"]
    seeds: tuple[str, ...] = ()
    items: tuple[SearchHitModel, ...] = ()
    took_ms: float = Field(ge=0)


class InventorySignal(_Model):
    """What the inventory engine can say about one product, safely.

    Exact stock counts are deliberately absent: exposing them turns a catalog
    API into a stock-scraping endpoint. `available` is a coarse band instead.
    """

    product_id: str
    status: Literal["in_stock", "low_stock", "out_of_stock"]
    available_band: Literal["none", "few", "some", "many"]
    reserved: int = Field(ge=0, description="Units held against open orders")
    last_movement_at: datetime | None = None


class LowStockItem(_Model):
    product_id: str
    name: str
    sku: str | None = None
    stock_quantity: int = Field(ge=0)
    reserved_quantity: int = Field(ge=0)
    low_stock_threshold: int = Field(ge=0)
    # Negative is meaningful: it means the threshold was crossed some time ago.
    shortfall: int = Field(description="threshold - available; positive means below threshold")


class InventoryInsightsResponse(_Model):
    generated_at: datetime
    low_stock: tuple[LowStockItem, ...] = ()
    out_of_stock_count: int = Field(ge=0)
    total_tracked_products: int = Field(ge=0)
    ledger_mismatches: int = Field(
        ge=0,
        description="Products whose cached stock disagrees with the ledger; must be 0",
    )


class ZeroResultQuery(_Model):
    """A query that returned nothing — the merchandising team's to-do list."""

    query: str
    occurrences: int = Field(ge=1)
    last_seen_at: datetime | None = None


class QueryInsightsResponse(_Model):
    generated_at: datetime
    window_days: int = Field(ge=1, le=90)
    total_searches: int = Field(ge=0)
    zero_result_rate: float = Field(ge=0, le=1, description="Fraction of searches with no hits")
    average_took_ms: float = Field(ge=0)
    top_queries: tuple[ZeroResultQuery, ...] = ()
    zero_result_queries: tuple[ZeroResultQuery, ...] = ()


class IndexStats(_Model):
    """Health of the native ranking index."""

    engine: Literal["native", "unavailable"]
    engine_version: str | None = None
    documents: int = Field(ge=0)
    vocabulary_size: int = Field(ge=0)
    last_refresh_at: datetime | None = None
    refresh_interval_seconds: int = Field(ge=0)


class HealthResponse(_Model):
    status: Literal["ok", "degraded", "unavailable"]
    service: str
    environment: str
    database: Literal["connected", "unavailable"]
    index: IndexStats
    checked_at: datetime
