"""Validation tests for the public schemas.

These are the service's outer boundary, so the cases here are the inputs a
hostile or merely careless caller will actually send.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.schemas import (
    RecommendationRequest,
    SearchHitModel,
    SearchRequest,
)


def test_search_request_accepts_a_plain_query() -> None:
    request = SearchRequest(query="cotton tee")
    assert request.query == "cotton tee"
    assert request.limit == 20
    assert request.prefix is True


def test_search_request_strips_surrounding_whitespace() -> None:
    assert SearchRequest(query="  cotton tee  ").query == "cotton tee"


def test_search_request_rejects_an_empty_query() -> None:
    with pytest.raises(ValidationError):
        SearchRequest(query="")
    with pytest.raises(ValidationError):
        SearchRequest(query="   ")


def test_search_request_rejects_an_oversized_query() -> None:
    # A pasted paragraph is not a search. Letting it through would make the
    # tokenizer and the fuzzy expansion do unbounded work.
    with pytest.raises(ValidationError):
        SearchRequest(query="x" * 500)


def test_search_request_bounds_limit_and_offset() -> None:
    with pytest.raises(ValidationError):
        SearchRequest(query="tee", limit=0)
    with pytest.raises(ValidationError):
        SearchRequest(query="tee", limit=10_000)
    with pytest.raises(ValidationError):
        SearchRequest(query="tee", offset=-1)
    with pytest.raises(ValidationError):
        SearchRequest(query="tee", offset=1_000_000)


def test_search_request_rejects_an_inverted_price_band() -> None:
    with pytest.raises(ValidationError) as excinfo:
        SearchRequest(query="tee", min_price=1000, max_price=500)
    assert "max_price" in str(excinfo.value)


def test_search_request_rejects_a_negative_price() -> None:
    with pytest.raises(ValidationError):
        SearchRequest(query="tee", min_price=-1)


def test_search_request_rejects_unknown_fields() -> None:
    # `extra="forbid"` means a client typo is an error rather than a silently
    # ignored parameter, which is how a filter that never applies goes unnoticed.
    with pytest.raises(ValidationError):
        SearchRequest(query="tee", include_cost_price=True)


def test_search_request_rejects_a_non_hex_session_hash() -> None:
    # The hash is hex-only so the log table cannot be used to store an email
    # address or an IP address by accident.
    with pytest.raises(ValidationError):
        SearchRequest(query="tee", session_hash="user@example.com")
    with pytest.raises(ValidationError):
        SearchRequest(query="tee", session_hash="192.168.0.1")

    request = SearchRequest(query="tee", session_hash="a" * 64)
    assert request.session_hash == "a" * 64


def test_search_request_bounds_edit_distance() -> None:
    with pytest.raises(ValidationError):
        SearchRequest(query="tee", max_edit_distance=9)


def test_recommendation_request_bounds_seeds() -> None:
    with pytest.raises(ValidationError):
        RecommendationRequest(seed_ids=tuple(str(index) for index in range(50)))
    with pytest.raises(ValidationError):
        RecommendationRequest(seed_ids=("a", ""))


def test_recommendation_request_bounds_limit() -> None:
    with pytest.raises(ValidationError):
        RecommendationRequest(limit=0)
    with pytest.raises(ValidationError):
        RecommendationRequest(limit=1000)


def test_search_hit_rejects_an_impossible_rating() -> None:
    with pytest.raises(ValidationError):
        SearchHitModel(
            id="a", slug="a", name="A", price=100, rating_average=9.0
        )
    with pytest.raises(ValidationError):
        SearchHitModel(id="a", slug="a", name="A", price=-1)


def test_search_hit_model_is_immutable() -> None:
    hit = SearchHitModel(id="a", slug="a", name="A", price=100)
    with pytest.raises(ValidationError):
        hit.price = 200  # type: ignore[misc]


def test_search_hit_has_no_internal_price_fields() -> None:
    """The public shape must not grow a cost or supplier field.

    This is a guard on future edits: adding `cost_price` here would leak a
    margin through an internal API, and the field list is the thing to review.
    """
    fields = set(SearchHitModel.model_fields)
    forbidden = {
        "cost_price",
        "cost_price_paise",
        "supplier_cost",
        "margin",
        "search_vector",
        "seller_id",
        "session_hash",
    }
    assert fields.isdisjoint(forbidden), f"internal fields leaked: {fields & forbidden}"
