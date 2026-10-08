"""Runtime configuration.

Every value comes from the environment, with a default that is safe for local
development. Nothing secret has a default: `database_url` is required, so a
misconfigured deployment fails at startup instead of quietly connecting to the
wrong database.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

__all__ = ["Settings", "get_settings"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="CATALOG_SERVICE_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ── service ──────────────────────────────────────────────────────────
    service_name: str = "catalog-intelligence"
    environment: str = Field(default="development", description="development | test | production")
    log_level: str = "INFO"
    # Origins allowed to call this service. Empty means "deny all cross-origin",
    # which is the correct default: the Next.js server calls it server-to-server.
    cors_origins: list[str] = Field(default_factory=list)

    # ── database ─────────────────────────────────────────────────────────
    # The same PostgreSQL instance the Next.js app uses. This service reads the
    # catalog and writes only to its own tables; it never owns catalog data.
    database_url: str = Field(default="", description="postgresql+psycopg://...")
    database_pool_size: int = 5
    database_max_overflow: int = 10
    database_pool_timeout_seconds: int = 30

    # ── ranking engine ───────────────────────────────────────────────────
    # Path to libcppsearch.so. Empty means "search the usual places", which is
    # what local development wants.
    cppsearch_library: str = ""
    # Rebuild the in-memory index this often, in seconds. The index is a
    # read-through cache of PostgreSQL: it can be stale, but never for long.
    index_refresh_seconds: int = 300
    # Largest catalog to hold in memory. Beyond this the service should rank a
    # database-narrowed candidate set instead of the whole catalog.
    index_max_documents: int = 500_000

    # ── search tuning ────────────────────────────────────────────────────
    search_default_limit: int = 20
    search_max_limit: int = 100
    max_edit_distance: int = 1
    min_fuzzy_length: int = 4

    # ── recommendations ──────────────────────────────────────────────────
    recommendations_default_limit: int = 8
    recommendations_max_limit: int = 24

    @field_validator("environment")
    @classmethod
    def _check_environment(cls, value: str) -> str:
        allowed = {"development", "test", "production"}
        if value not in allowed:
            raise ValueError(f"environment must be one of {sorted(allowed)}")
        return value

    @field_validator("log_level")
    @classmethod
    def _uppercase_log_level(cls, value: str) -> str:
        return value.upper()

    @field_validator("index_refresh_seconds")
    @classmethod
    def _check_refresh(cls, value: int) -> int:
        if value < 5:
            # Anything shorter turns the refresh into a permanent background load
            # for no user-visible benefit.
            raise ValueError("index_refresh_seconds must be at least 5")
        return value

    @field_validator("search_default_limit", "recommendations_default_limit")
    @classmethod
    def _positive(cls, value: int) -> int:
        if value <= 0:
            raise ValueError("limit must be positive")
        return value

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide settings, parsed once.

    Cached so that a request never pays for re-reading the environment, and so
    that a misconfiguration surfaces on the first call rather than randomly
    later.
    """
    return Settings()
