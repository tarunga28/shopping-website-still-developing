"""FastAPI application for the catalog-intelligence service.

Deployment note: this service is an internal dependency of the Next.js
application, not a public API. It binds behind the app server and is not
intended to be reachable from a browser. CORS is therefore empty by default —
`CATALOG_SERVICE_CORS_ORIGINS` exists for local development against the Next.js
dev server, not for production.
"""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware

from .config import Settings, get_settings
from .db import CatalogDatabase, DatabaseUnavailable, build_engine
from .intelligence import CatalogIntelligence, _utc_now
from .ranking import RankingEngineUnavailable, load_engine
from .schemas import (
    HealthResponse,
    InventoryInsightsResponse,
    QueryInsightsResponse,
    RecommendationRequest,
    RecommendationResponse,
    SearchRequest,
    SearchResponse,
    SuggestionResponse,
)

__all__ = ["create_app", "app", "RequestContextMiddleware"]

logger = logging.getLogger(__name__)


# ── request logging ───────────────────────────────────────────────────────


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Attach a request id and log one line per request.

    The id is echoed in `x-request-id` so a log line here can be tied to the
    corresponding line in the Next.js application's log.
    """

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
        request.state.request_id = request_id
        started = time.perf_counter()

        try:
            response = await call_next(request)
        except Exception:
            logger.exception(
                "request failed", extra={"request_id": request_id, "path": request.url.path}
            )
            raise

        response.headers["x-request-id"] = request_id
        logger.info(
            "%s %s -> %d in %.1f ms",
            request.method,
            request.url.path,
            response.status_code,
            (time.perf_counter() - started) * 1000,
            extra={"request_id": request_id},
        )
        return response


# ── dependency wiring ─────────────────────────────────────────────────────


def _build_intelligence(settings: Settings) -> CatalogIntelligence:
    """Construct the service graph, deciding what to do about a missing engine.

    A missing native library is a configuration problem in production and an
    ordinary occurrence on a fresh checkout, so it is logged at the level that
    matches — and the service still starts either way, on the lexical fallback.
    """
    database = CatalogDatabase(build_engine(settings))

    engine = None
    try:
        engine = load_engine()
        logger.info("ranking engine loaded (version %s)", engine.version)
    except RankingEngineUnavailable as exc:
        message = (
            "native ranking engine unavailable; search will use the lexical "
            f"fallback. {exc}"
        )
        if settings.is_production:
            logger.error(message)
        else:
            logger.warning(message)

    return CatalogIntelligence(database, engine, settings)


@asynccontextmanager
async def lifespan(application: FastAPI) -> AsyncIterator[None]:
    settings: Settings = application.state.settings
    intelligence: CatalogIntelligence = application.state.intelligence

    if not intelligence.engine or not settings.database_url:
        # Nothing to warm: either there is no engine to fill or no database to
        # fill it from. Both cases are reported by /health.
        yield
        return

    try:
        intelligence.refresh_index(force=True)
    except DatabaseUnavailable:
        # Starting anyway is deliberate: the storefront gets a degraded search
        # rather than a service that will not boot, and /health reports it.
        logger.error("could not warm the ranking index at startup", exc_info=True)

    yield

    if intelligence.engine is not None:
        intelligence.engine.close()


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    logging.basicConfig(
        level=settings.log_level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    application = FastAPI(
        title="Inkline Catalog Intelligence",
        version="1.0.0",
        description=(
            "Search ranking, recommendations, and catalog insights for the "
            "Inkline storefront. Internal service; not a public API."
        ),
        lifespan=lifespan,
    )
    application.state.settings = settings

    if settings.cors_origins:
        application.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_methods=["GET", "POST"],
            allow_headers=["x-request-id", "content-type"],
        )
    application.add_middleware(RequestContextMiddleware)

    # The engine is built eagerly so a misconfigured database fails at startup
    # rather than on the first request.
    application.state.intelligence = _build_intelligence(settings)

    def get_intelligence(request: Request) -> CatalogIntelligence:
        return request.app.state.intelligence

    # ── routes ───────────────────────────────────────────────────────────

    @application.get("/health", response_model=HealthResponse, tags=["ops"])
    def health(
        intelligence: CatalogIntelligence = Depends(get_intelligence),
    ) -> HealthResponse:
        """Liveness plus the two dependencies this service has.

        Reports `degraded` rather than failing outright when search can still be
        served from the fallback path — a health endpoint that returns 503 would
        pull the instance out of rotation for a problem that does not warrant it.
        """
        database_ok = intelligence._db.ping()
        index = intelligence.index_stats()

        if not database_ok:
            status = "unavailable"
        elif not index.available:
            status = "degraded"
        else:
            status = "ok"

        return HealthResponse(
            status=status,
            service=settings.service_name,
            environment=settings.environment,
            database="connected" if database_ok else "unavailable",
            index={
                "engine": "native" if index.available else "unavailable",
                "engine_version": index.version,
                "documents": index.documents,
                "vocabulary_size": index.vocabulary_size,
                "last_refresh_at": index.last_refresh_at,
                "refresh_interval_seconds": settings.index_refresh_seconds,
            },
            checked_at=_utc_now(),
        )

    @application.post("/v1/search", response_model=SearchResponse, tags=["search"])
    def search(
        request: SearchRequest,
        intelligence: CatalogIntelligence = Depends(get_intelligence),
    ) -> SearchResponse:
        try:
            return intelligence.search(request)
        except DatabaseUnavailable as exc:
            raise HTTPException(status_code=503, detail="catalog database unavailable") from exc

    @application.get("/v1/suggestions", response_model=SuggestionResponse, tags=["search"])
    def suggestions(
        prefix: str = Query(min_length=1, max_length=60),
        limit: int = Query(default=10, ge=1, le=20),
        intelligence: CatalogIntelligence = Depends(get_intelligence),
    ) -> SuggestionResponse:
        return intelligence.suggest(prefix, limit)

    @application.post(
        "/v1/recommendations", response_model=RecommendationResponse, tags=["recommendations"]
    )
    def recommendations(
        request: RecommendationRequest,
        intelligence: CatalogIntelligence = Depends(get_intelligence),
    ) -> RecommendationResponse:
        try:
            return intelligence.recommend(request)
        except ValueError as exc:
            # Ambiguous input is the caller's mistake, not a server fault.
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except DatabaseUnavailable as exc:
            raise HTTPException(status_code=503, detail="catalog database unavailable") from exc

    @application.get(
        "/v1/inventory/insights", response_model=InventoryInsightsResponse, tags=["inventory"]
    )
    def inventory_insights(
        limit: int = Query(default=50, ge=1, le=200),
        intelligence: CatalogIntelligence = Depends(get_intelligence),
    ) -> InventoryInsightsResponse:
        try:
            return intelligence.inventory_insights(limit)
        except DatabaseUnavailable as exc:
            raise HTTPException(status_code=503, detail="catalog database unavailable") from exc

    @application.get(
        "/v1/search/insights", response_model=QueryInsightsResponse, tags=["search"]
    )
    def search_insights(
        window_days: int = Query(default=30, ge=1, le=90),
        limit: int = Query(default=10, ge=1, le=50),
        intelligence: CatalogIntelligence = Depends(get_intelligence),
    ) -> QueryInsightsResponse:
        try:
            return intelligence.query_insights(window_days, limit)
        except DatabaseUnavailable as exc:
            raise HTTPException(status_code=503, detail="catalog database unavailable") from exc

    @application.post("/v1/index/refresh", tags=["ops"])
    def refresh_index(
        intelligence: CatalogIntelligence = Depends(get_intelligence),
    ) -> dict[str, object]:
        """Force a rebuild of the native index.

        Intended for an admin action after a large import, not for routine use —
        the periodic refresh already keeps the index close enough.
        """
        if intelligence.engine is None:
            raise HTTPException(status_code=503, detail="ranking engine unavailable")
        try:
            documents = intelligence.refresh_index(force=True)
        except DatabaseUnavailable as exc:
            raise HTTPException(status_code=503, detail="catalog database unavailable") from exc
        return {
            "documents": documents,
            "refreshed_at": datetime.now(timezone.utc).isoformat(),
        }

    return application


# ── ASGI entry point ──────────────────────────────────────────────────────
#
# `uvicorn app.main:app` needs a module-level `app`, but building the service
# graph at import time would mean merely importing this module requires a
# configured database — which makes the module untestable and turns a missing
# environment variable into an ImportError with a confusing traceback.
#
# PEP 562 module `__getattr__` gives both: the attribute exists when uvicorn
# looks for it, and is built on first access rather than at import.

_app_instance: FastAPI | None = None


def __getattr__(name: str) -> object:
    global _app_instance
    if name != "app":
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    if _app_instance is None:
        _app_instance = create_app()
    return _app_instance


def __dir__() -> list[str]:
    return sorted(set(globals()) | {"app"})
