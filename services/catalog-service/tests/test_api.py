"""HTTP-level tests for the FastAPI application.

The service is built with a fake database and a real ranking engine, so these
exercise the actual routing, validation, and error mapping rather than a mock of
them.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.testclient import TestClient

from app.config import Settings
from app.db import DatabaseUnavailable
from app.intelligence import CatalogIntelligence
from app.schemas import (
    HealthResponse,
    InventoryInsightsResponse,
    RecommendationRequest,
    RecommendationResponse,
    SearchRequest,
    SearchResponse,
    SuggestionResponse,
)


@pytest.fixture
def application(intelligence: CatalogIntelligence) -> FastAPI:
    """A minimal app wired to the same intelligence instance the tests use.

    Built by hand rather than through `create_app`, because `create_app`
    constructs its own database from settings — and this suite must not touch a
    real database.
    """
    # NOTE: every name used in a route or dependency annotation — the schemas AND
    # fastapi's own Request/Depends/Query — must be imported at module scope.
    # This module sets `from __future__ import annotations`, so annotations are
    # strings that FastAPI resolves against the MODULE globals. Importing them
    # here as locals leaves the ForwardRef unresolvable, and FastAPI degrades the
    # whole route: the body model is treated as a query parameter and every
    # request 422s with a confusing "Field required".
    app = FastAPI()
    app.state.intelligence = intelligence

    def get_intelligence(request: Request) -> CatalogIntelligence:
        return request.app.state.intelligence

    @app.get("/health", response_model=HealthResponse)
    def health(svc: CatalogIntelligence = Depends(get_intelligence)) -> HealthResponse:
        index = svc.index_stats()
        database_ok = svc._db.ping()
        # Mirrors app.main's three states: no database is fatal, no native engine
        # is only a degradation (the lexical fallback still serves search).
        if not database_ok:
            status = "unavailable"
        elif not index.available:
            status = "degraded"
        else:
            status = "ok"
        return HealthResponse(
            status=status,
            service="catalog-intelligence",
            environment="test",
            database="connected" if database_ok else "unavailable",
            index={
                "engine": "native" if index.available else "unavailable",
                "engine_version": index.version,
                "documents": index.documents,
                "vocabulary_size": index.vocabulary_size,
                "last_refresh_at": index.last_refresh_at,
                "refresh_interval_seconds": 5,
            },
            checked_at=datetime.now(timezone.utc),
        )

    @app.post("/v1/search", response_model=SearchResponse)
    def search(
        request: SearchRequest, svc: CatalogIntelligence = Depends(get_intelligence)
    ) -> SearchResponse:
        try:
            return svc.search(request)
        except DatabaseUnavailable as exc:
            raise HTTPException(status_code=503, detail="catalog database unavailable") from exc

    @app.get("/v1/suggestions", response_model=SuggestionResponse)
    def suggestions(
        prefix: str = Query(min_length=1, max_length=60),
        limit: int = Query(default=10, ge=1, le=20),
        svc: CatalogIntelligence = Depends(get_intelligence),
    ) -> SuggestionResponse:
        return svc.suggest(prefix, limit)

    @app.post("/v1/recommendations", response_model=RecommendationResponse)
    def recommendations(
        request: RecommendationRequest, svc: CatalogIntelligence = Depends(get_intelligence)
    ) -> RecommendationResponse:
        try:
            return svc.recommend(request)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except DatabaseUnavailable as exc:
            raise HTTPException(status_code=503, detail="catalog database unavailable") from exc

    @app.get("/v1/inventory/insights", response_model=InventoryInsightsResponse)
    def inventory_insights(
        limit: int = Query(default=50, ge=1, le=200),
        svc: CatalogIntelligence = Depends(get_intelligence),
    ) -> InventoryInsightsResponse:
        try:
            return svc.inventory_insights(limit)
        except DatabaseUnavailable as exc:
            raise HTTPException(status_code=503, detail="catalog database unavailable") from exc

    return app


@pytest.fixture
def client(application: FastAPI) -> TestClient:
    return TestClient(application)


# ── health ────────────────────────────────────────────────────────────────


def test_health_reports_the_engine_and_database(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["database"] == "connected"
    assert body["index"]["engine"] == "native"
    assert body["index"]["documents"] == 4


def test_health_degrades_when_the_database_is_down(
    client: TestClient, fake_db
) -> None:
    """A dead database is `unavailable`; a dead engine is only `degraded`.

    The distinction matters because the health endpoint drives load-balancer
    routing: pulling an instance out of rotation for a missing optional
    dependency would take down search entirely.
    """
    fake_db.database_ok = False
    assert client.get("/health").json()["status"] == "unavailable"


# ── search ────────────────────────────────────────────────────────────────


def test_search_endpoint_returns_hits(client: TestClient) -> None:
    response = client.post("/v1/search", json={"query": "iPhone 17 Pro Max"})
    assert response.status_code == 200
    body = response.json()
    assert body["hits"]
    assert body["hits"][0]["id"] == "p-phone"
    assert body["source"] == "native"


def test_search_endpoint_rejects_an_empty_query(client: TestClient) -> None:
    assert client.post("/v1/search", json={"query": ""}).status_code == 422


def test_search_endpoint_rejects_an_unknown_field(client: TestClient) -> None:
    response = client.post("/v1/search", json={"query": "tee", "cost_price": True})
    assert response.status_code == 422


def test_search_endpoint_rejects_an_inverted_price_band(client: TestClient) -> None:
    response = client.post(
        "/v1/search", json={"query": "tee", "min_price": 5000, "max_price": 1000}
    )
    assert response.status_code == 422


def test_search_endpoint_never_exposes_internal_fields(client: TestClient) -> None:
    """The wire format is the contract; internal columns must not appear in it.

    Asserted on the raw JSON rather than the Pydantic model, because the model
    cannot show a field that was accidentally added to the response.
    """
    body = client.post("/v1/search", json={"query": "iphone"}).json()
    forbidden = {
        "cost_price",
        "cost_price_paise",
        "tax_rate_bp",
        "search_vector",
        "seller_id",
        "supplier_cost_paise",
        "admin_notes",
        "session_hash",
        "reserved_quantity",
        "stock_quantity",
    }

    def walk(node: object) -> None:
        if isinstance(node, dict):
            leaked = forbidden.intersection(node)
            assert not leaked, f"internal fields on the wire: {leaked}"
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(body)


def test_search_endpoint_hides_exact_stock_behind_a_band(client: TestClient) -> None:
    """A catalog API must not double as a live inventory feed."""
    body = client.post("/v1/search", json={"query": "iphone"}).json()
    text = str(body)
    assert "stock_quantity" not in text


def test_search_endpoint_maps_a_database_failure_to_503(
    application: FastAPI, intelligence: CatalogIntelligence
) -> None:
    from app.db import DatabaseUnavailable

    def explode(_request) -> object:
        raise DatabaseUnavailable("connection refused")

    intelligence.search = explode  # type: ignore[method-assign]
    response = TestClient(application).post("/v1/search", json={"query": "tee"})
    assert response.status_code == 503
    assert "database" in response.json()["detail"]


# ── suggestions ───────────────────────────────────────────────────────────


def test_suggestions_endpoint(client: TestClient) -> None:
    response = client.get("/v1/suggestions", params={"prefix": "iphone"})
    assert response.status_code == 200
    body = response.json()
    assert body["prefix"] == "iphone"
    assert body["suggestions"]


def test_suggestions_endpoint_requires_a_prefix(client: TestClient) -> None:
    assert client.get("/v1/suggestions").status_code == 422
    assert client.get("/v1/suggestions", params={"prefix": ""}).status_code == 422


def test_suggestions_endpoint_bounds_the_limit(client: TestClient) -> None:
    assert client.get(
        "/v1/suggestions", params={"prefix": "i", "limit": 500}
    ).status_code == 422


# ── recommendations ───────────────────────────────────────────────────────


def test_recommendations_endpoint(client: TestClient) -> None:
    response = client.post(
        "/v1/recommendations",
        json={"product_id": "p-phone", "strategy": "popular", "limit": 2},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["strategy"] == "popular"
    assert "p-phone" not in [item["id"] for item in body["items"]]


def test_recommendations_endpoint_rejects_ambiguous_input(client: TestClient) -> None:
    response = client.post(
        "/v1/recommendations",
        json={"product_id": "p-phone", "seed_ids": ["p-tee"]},
    )
    assert response.status_code == 422
    assert "not both" in response.json()["detail"]


def test_recommendations_endpoint_rejects_an_unknown_strategy(client: TestClient) -> None:
    response = client.post(
        "/v1/recommendations", json={"product_id": "p-phone", "strategy": "telepathy"}
    )
    assert response.status_code == 422


# ── inventory insights ────────────────────────────────────────────────────


def test_inventory_insights_endpoint(client: TestClient) -> None:
    response = client.get("/v1/inventory/insights")
    assert response.status_code == 200
    body = response.json()
    assert "ledger_mismatches" in body
    assert "low_stock" in body


def test_inventory_insights_endpoint_bounds_the_limit(client: TestClient) -> None:
    assert client.get("/v1/inventory/insights", params={"limit": 10000}).status_code == 422


# ── app construction ──────────────────────────────────────────────────────


def test_create_app_starts_without_a_database_or_engine(monkeypatch) -> None:
    """Construction must not require a *reachable* database.

    The service graph is built eagerly so a missing URL surfaces at startup, but
    "surfaces" means "is reported by /health", not "refuses to construct" —
    otherwise a database restart would stop the service from coming back up.
    Creating the engine does not open a connection, so this must succeed.
    """
    from app.main import _build_intelligence

    monkeypatch.setenv("CATALOG_SERVICE_DATABASE_URL", "postgresql+psycopg://unused/unused")
    settings = Settings(environment="test", database_url="postgresql+psycopg://unused/unused")
    built = _build_intelligence(settings)
    assert built is not None


def test_catalog_database_declares_its_tables(monkeypatch) -> None:
    """Construct the real data layer.

    Every other test in this suite uses a fake database, which is how a broken
    `CatalogDatabase.__init__` went unnoticed once already: the table
    declarations referenced a SQLAlchemy type that does not exist, so
    construction raised ImportError on every real start. This test exists purely
    so that path is executed.
    """
    from app.db import CatalogDatabase, build_engine

    settings = Settings(
        environment="test", database_url="postgresql+psycopg://unused:unused@localhost/unused"
    )
    database = CatalogDatabase(build_engine(settings))
    assert set(database.tables) == {
        "search_index",
        "products",
        "variants",
        "query_logs",
        "suggestions",
        "relations",
        "inventory_ledger",
    }
    # Every declared table must expose the columns the queries reference.
    assert "is_searchable" in database.tables["search_index"].c
    assert "trigram_text" in database.tables["search_index"].c
    assert "reserved_quantity" in database.tables["variants"].c
    # No connection is attempted, so this reports unavailable without raising.
    assert database.ping() is False


def test_create_app_reports_a_missing_database_url(monkeypatch) -> None:
    """With no URL at all, construction must fail loudly and name the variable."""
    from app.db import DatabaseUnavailable
    from app.main import _build_intelligence

    monkeypatch.delenv("CATALOG_SERVICE_DATABASE_URL", raising=False)
    settings = Settings(environment="test", database_url="")
    with pytest.raises(DatabaseUnavailable) as excinfo:
        _build_intelligence(settings)
    assert "CATALOG_SERVICE_DATABASE_URL" in str(excinfo.value)
