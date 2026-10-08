"""Database access.

This service shares the Next.js application's PostgreSQL instance but owns none
of its tables. The access pattern is deliberately narrow:

* **Reads** of the catalog, through a small hand-written set of queries. No ORM
  identity map and no lazy loading — every read is one explicit statement.
* **No writes** to catalog tables. Recommendations, insights, and search
  suggestions are computed and returned, not persisted. The only writes this
  service performs are to `search_query_logs`, which it owns, and those go
  through the Next.js app's own writer so the schema stays single-owned.

That asymmetry is what keeps two runtimes sharing one database safe: only one of
them can change the catalog, so there is no question of who wins.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import MetaData, Table, create_engine, func, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from .config import Settings

__all__ = [
    "DatabaseUnavailable",
    "CatalogDatabase",
    "SearchIndexRow",
    "LowStockRow",
    "QueryStat",
    "build_engine",
]

logger = logging.getLogger(__name__)


class DatabaseUnavailable(RuntimeError):
    """The catalog database could not be reached."""


# ── table metadata ────────────────────────────────────────────────────────
#
# Declared explicitly rather than reflected: reflection issues a query per table
# at startup and silently tracks whatever the database happens to contain,
# including a half-applied migration. Naming the columns means a schema change
# shows up as a code change.

def _declare_tables(meta: MetaData) -> dict[str, Table]:
    """Declare the tables this service reads, and return them by name."""
    # Imported here rather than at module scope only to keep the (long) column
    # list readable; SQLAlchemy has no `Real` — `Float` is the portable type and
    # maps to PostgreSQL `real`/`double precision` as needed.
    from sqlalchemy import Boolean, Column, DateTime, Float, Integer, String, Text

    search_index = Table(
        "product_search_index",
        meta,
        Column("product_id", String(36), primary_key=True),
        Column("slug", Text, nullable=False),
        Column("name", Text, nullable=False),
        Column("brand_name", Text),
        Column("brand_id", String(36)),
        Column("category_id", String(36)),
        Column("category_path", Text),
        Column("seller_id", String(36)),
        Column("sku_text", Text, nullable=False),
        Column("tag_text", Text, nullable=False),
        Column("attribute_text", Text, nullable=False),
        Column("description_text", Text, nullable=False),
        Column("trigram_text", Text, nullable=False),
        Column("price_paise", Integer, nullable=False),
        Column("compare_at_paise", Integer),
        Column("status", Text, nullable=False),
        Column("is_searchable", Boolean, nullable=False),
        Column("rating_average", Float),
        Column("rating_count", Integer, nullable=False),
        Column("popularity", Float, nullable=False),
        Column("indexed_at", DateTime(timezone=True), nullable=False),
    )

    products = Table(
        "products",
        meta,
        Column("id", String(36), primary_key=True),
        Column("name", Text, nullable=False),
        Column("slug", Text, nullable=False),
        # There is no products.sku — the SKU lives on the variant. `barcode` is
        # the product-level identifier that does exist.
        Column("barcode", Text),
        Column("status", Text, nullable=False),
        Column("visibility", Text, nullable=False),
        Column("stock_quantity", Integer, nullable=False),
        Column("low_stock_threshold", Integer, nullable=False),
        Column("base_price", Integer, nullable=False),
        Column("compare_at_price", Integer),
    )

    variants = Table(
        "product_variants",
        meta,
        Column("id", String(36), primary_key=True),
        Column("product_id", String(36), nullable=False),
        Column("sku", Text),
        Column("stock_quantity", Integer, nullable=False),
        Column("reserved_quantity", Integer, nullable=False),
        Column("is_active", Boolean, nullable=False),
    )

    query_logs = Table(
        "search_query_logs",
        meta,
        Column("id", String(36), primary_key=True),
        Column("query", Text, nullable=False),
        Column("normalized_query", Text, nullable=False),
        Column("result_count", Integer, nullable=False),
        Column("took_ms", Float, nullable=False),
        Column("session_hash", Text),
        Column("created_at", DateTime(timezone=True), nullable=False),
    )

    suggestions = Table(
        "search_suggestions",
        meta,
        Column("id", String(36), primary_key=True),
        Column("term", Text, nullable=False),
        Column("kind", Text, nullable=False),
        Column("weight", Integer, nullable=False),
        Column("is_active", Boolean, nullable=False),
    )

    relations = Table(
        "product_relations",
        meta,
        Column("id", String(36), primary_key=True),
        Column("product_id", String(36), nullable=False),
        Column("related_product_id", String(36), nullable=False),
        Column("relation_type", Text, nullable=False),
        # Ranking signals rather than a manual position: `score` is the curated
        # or computed strength, `co_occurrence_count` is observed evidence.
        Column("score", Float, nullable=False),
        Column("is_manual", Boolean, nullable=False),
        Column("co_occurrence_count", Integer, nullable=False),
    )

    inventory_ledger = Table(
        "inventory_ledger",
        meta,
        Column("id", String(36), primary_key=True),
        Column("product_id", String(36), nullable=False),
        Column("variant_id", String(36), nullable=False),
        Column("previous_quantity", Integer, nullable=False),
        Column("quantity_changed", Integer, nullable=False),
        Column("new_quantity", Integer, nullable=False),
        Column("operation", Text, nullable=False),
        Column("created_at", DateTime(timezone=True), nullable=False),
    )

    return {
        "search_index": search_index,
        "products": products,
        "variants": variants,
        "query_logs": query_logs,
        "suggestions": suggestions,
        "relations": relations,
        "inventory_ledger": inventory_ledger,
    }


# ── row shapes ────────────────────────────────────────────────────────────


class SearchIndexRow:
    """One row of `product_search_index`, as attributes.

    A plain class rather than a Pydantic model: this is an internal carrier on
    the hot path, and validating 50k rows per index rebuild would be pure
    overhead. The public schemas validate on the way out.
    """

    __slots__ = (
        "product_id",
        "slug",
        "name",
        "brand_name",
        "brand_id",
        "category_id",
        "category_path",
        "sku_text",
        "tag_text",
        "attribute_text",
        "description_text",
        "price_paise",
        "compare_at_paise",
        "rating_average",
        "rating_count",
        "popularity",
        "stock_quantity",
    )

    def __init__(self, **values: Any) -> None:
        for slot in self.__slots__:
            setattr(self, slot, values.get(slot))


class LowStockRow:
    __slots__ = (
        "product_id",
        "name",
        "sku",
        "stock_quantity",
        "reserved_quantity",
        "low_stock_threshold",
    )

    def __init__(self, **values: Any) -> None:
        for slot in self.__slots__:
            setattr(self, slot, values.get(slot))

    @property
    def available(self) -> int:
        return max(0, self.stock_quantity - self.reserved_quantity)

    @property
    def shortfall(self) -> int:
        return self.low_stock_threshold - self.available


class QueryStat:
    __slots__ = ("query", "occurrences", "last_seen_at")

    def __init__(self, query: str, occurrences: int, last_seen_at: datetime | None) -> None:
        self.query = query
        self.occurrences = occurrences
        self.last_seen_at = last_seen_at


# ── engine ────────────────────────────────────────────────────────────────


def build_engine(settings: Settings) -> Engine:
    """Create the SQLAlchemy engine.

    Raises rather than returning a broken engine: a service that starts without
    a database answers every request with a confusing error later.
    """
    if not settings.database_url:
        raise DatabaseUnavailable(
            "CATALOG_SERVICE_DATABASE_URL is not set. Point it at the same "
            "PostgreSQL instance the Next.js application uses."
        )

    return create_engine(
        settings.database_url,
        pool_size=settings.database_pool_size,
        max_overflow=settings.database_max_overflow,
        pool_timeout=settings.database_pool_timeout_seconds,
        pool_pre_ping=True,  # a dropped connection is retried, not surfaced
        future=True,
    )


class CatalogDatabase:
    """The whole of this service's data access."""

    def __init__(self, engine: Engine) -> None:
        self._engine = engine
        self._tables = _declare_tables(MetaData())
        self._session_factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

    @property
    def tables(self) -> dict[str, Table]:
        return self._tables

    @contextmanager
    def session(self) -> Iterator[Session]:
        """A session that rolls back on any exception.

        Read-only work never commits, so the rollback is the only path that
        matters; being explicit about it means a future write cannot leak a
        half-applied transaction.
        """
        session = self._session_factory()
        try:
            yield session
        except SQLAlchemyError as exc:
            session.rollback()
            raise DatabaseUnavailable(str(exc)) from exc
        finally:
            session.close()

    def ping(self) -> bool:
        try:
            with self._engine.connect() as connection:
                connection.execute(text("SELECT 1"))
            return True
        except SQLAlchemyError:
            logger.warning("catalog database is unreachable", exc_info=True)
            return False

    # ── search ───────────────────────────────────────────────────────────

    def load_search_documents(
        self, *, limit: int, cursor: str | None = None
    ) -> list[SearchIndexRow]:
        """A page of searchable products, ordered by product id.

        Keyset pagination on the primary key rather than OFFSET: rebuilding the
        index walks the whole table, and OFFSET would make each page
        progressively more expensive.
        """
        table = self._tables["search_index"]
        statement = select(table).where(table.c.is_searchable.is_(True))
        if cursor is not None:
            statement = statement.where(table.c.product_id > cursor)
        statement = statement.order_by(table.c.product_id).limit(limit)

        with self.session() as session:
            rows = session.execute(statement).mappings().all()

        return [SearchIndexRow(**dict(row)) for row in rows]

    def fetch_search_rows(self, product_ids: Sequence[str]) -> dict[str, SearchIndexRow]:
        """Rows for a specific set of ids, keyed by id.

        This is how a native ranking is hydrated: the engine returns ids in
        ranked order, and the display data comes from here.
        """
        if not product_ids:
            return {}
        table = self._tables["search_index"]
        statement = select(table).where(
            table.c.product_id.in_(list(product_ids)),
            table.c.is_searchable.is_(True),
        )
        with self.session() as session:
            rows = session.execute(statement).mappings().all()

        return {row["product_id"]: SearchIndexRow(**dict(row)) for row in rows}

    # ── candidates ───────────────────────────────────────────────────────
    #
    # Eligibility lives in SQL. The native engine ranks whatever it is handed,
    # so narrowing by category, brand, price, and stock happens here where the
    # indexes are — never by ranking everything and filtering afterwards.

    def candidate_ids(
        self,
        *,
        category_id: str | None = None,
        brand_id: str | None = None,
        min_price: int | None = None,
        max_price: int | None = None,
        in_stock_only: bool = False,
        limit: int = 5000,
    ) -> list[str]:
        table = self._tables["search_index"]
        products = self._tables["products"]
        statement = select(table.c.product_id).where(table.c.is_searchable.is_(True))

        if category_id:
            statement = statement.where(table.c.category_id == category_id)
        if brand_id:
            statement = statement.where(table.c.brand_id == brand_id)
        if min_price is not None:
            statement = statement.where(table.c.price_paise >= min_price)
        if max_price is not None:
            statement = statement.where(table.c.price_paise <= max_price)
        if in_stock_only:
            statement = statement.join(
                products, products.c.id == table.c.product_id
            ).where(products.c.stock_quantity > 0)

        statement = statement.limit(limit)
        with self.session() as session:
            return [row[0] for row in session.execute(statement).all()]

    # ── suggestions ──────────────────────────────────────────────────────

    def suggest_terms(self, prefix: str, limit: int = 10) -> list[tuple[str, int]]:
        """Historical search terms starting with `prefix`, most-used first."""
        table = self._tables["suggestions"]
        # Terms are stored as typed, so the prefix match lowercases both sides.
        # A functional index on lower(term) would be better at scale; this is
        # correct first.
        statement = (
            select(table.c.term, table.c.weight)
            .where(
                table.c.is_active.is_(True),
                func.lower(table.c.term).like(f"{prefix.lower()}%"),
            )
            .order_by(table.c.weight.desc(), table.c.term.asc())
            .limit(limit)
        )
        with self.session() as session:
            return [(row[0], int(row[1])) for row in session.execute(statement).all()]

    # ── recommendations ──────────────────────────────────────────────────

    def related_ids(self, source_id: str, relation_type: str, limit: int) -> list[str]:
        table = self._tables["relations"]
        statement = (
            select(table.c.related_product_id)
            .where(
                table.c.product_id == source_id,
                table.c.relation_type == relation_type,
            )
            # Manually curated links outrank inferred ones at equal score, and
            # observed co-occurrence breaks the remaining ties.
            .order_by(
                table.c.score.desc(),
                table.c.is_manual.desc(),
                table.c.co_occurrence_count.desc(),
            )
            .limit(limit)
        )
        with self.session() as session:
            return [row[0] for row in session.execute(statement).all()]

    def popular_ids(self, limit: int, exclude: Sequence[str] = ()) -> list[str]:
        table = self._tables["search_index"]
        statement = select(table.c.product_id).where(table.c.is_searchable.is_(True))
        if exclude:
            statement = statement.where(table.c.product_id.notin_(list(exclude)))
        statement = statement.order_by(
            table.c.popularity.desc(), table.c.rating_average.desc()
        ).limit(limit)
        with self.session() as session:
            return [row[0] for row in session.execute(statement).all()]

    # ── inventory insights ───────────────────────────────────────────────

    def low_stock(self, limit: int = 50) -> list[LowStockRow]:
        """Products at or below their threshold, worst first.

        The threshold comparison happens in SQL so the database can use the
        partial index on low stock rather than shipping the whole catalog here.
        """
        products = self._tables["products"]
        statement = (
            select(
                products.c.id,
                products.c.name,
                products.c.barcode,
                products.c.stock_quantity,
                products.c.low_stock_threshold,
            )
            .where(
                products.c.status == "ACTIVE",
                products.c.visibility == "PUBLIC",
                products.c.stock_quantity <= products.c.low_stock_threshold,
            )
            .order_by((products.c.stock_quantity - products.c.low_stock_threshold).asc())
            .limit(limit)
        )

        with self.session() as session:
            rows = session.execute(statement).all()

        # Reserved units are read in a second pass so the main query can use the
        # low-stock index unimpeded.
        result: list[LowStockRow] = []
        for row in rows:
            item = LowStockRow(
                product_id=row[0],
                name=row[1],
                sku=row[2],
                stock_quantity=int(row[3]),
                reserved_quantity=self._reserved_for(row[0]),
                low_stock_threshold=int(row[4]),
            )
            result.append(item)
        return result

    def _reserved_for(self, product_id: str) -> int:
        variants = self._tables["variants"]
        statement = select(variants.c.reserved_quantity).where(
            variants.c.product_id == product_id, variants.c.is_active.is_(True)
        )
        with self.session() as session:
            return sum(int(value or 0) for value in session.execute(statement).scalars().all())

    def stock_summary(self) -> tuple[int, int, int]:
        """(total tracked products, out-of-stock count, ledger mismatches)."""
        with self.session() as session:
            total = int(
                session.execute(
                    text("SELECT count(*) FROM products WHERE visibility = 'PUBLIC'")
                ).scalar_one()
            )
            out_of_stock = int(
                session.execute(
                    text(
                        "SELECT count(*) FROM products "
                        "WHERE visibility = 'PUBLIC' AND stock_quantity <= 0"
                    )
                ).scalar_one()
            )
            # The cached stock column must equal the sum of ledger movements.
            # Any disagreement means a transaction wrote one without the other.
            mismatches = int(
                session.execute(
                    text(
                        """
                        SELECT count(*) FROM (
                          SELECT v.product_id,
                                 sum(v.stock_quantity) AS cached,
                                 coalesce(sum(l.quantity_changed), 0) AS derived
                          FROM product_variants v
                          LEFT JOIN inventory_ledger l ON l.variant_id = v.id
                          WHERE v.is_active
                          GROUP BY v.product_id
                        ) AS rolled
                        WHERE rolled.cached <> rolled.derived
                        """
                    )
                ).scalar_one()
            )
        return total, out_of_stock, mismatches

    # ── query insights ───────────────────────────────────────────────────

    def query_insights(self, window_days: int, top_limit: int = 10) -> dict[str, Any]:
        """Search-performance facts for a period.

        Aggregated in SQL. The raw log is never shipped here: it can be large,
        and the only interesting facts are counts.
        """
        since = datetime.now(timezone.utc) - timedelta(days=window_days)
        with self.session() as session:
            totals = session.execute(
                text(
                    """
                    SELECT count(*)                                            AS total,
                           count(*) FILTER (WHERE result_count = 0)             AS zero_results,
                           coalesce(avg(took_ms), 0)                            AS average_took_ms
                    FROM search_query_logs
                    WHERE created_at >= :since
                    """
                ),
                {"since": since},
            ).one()

            top_rows = session.execute(
                text(
                    """
                    SELECT normalized_query, count(*) AS occurrences, max(created_at) AS last_seen
                    FROM search_query_logs
                    WHERE created_at >= :since
                    GROUP BY normalized_query
                    ORDER BY occurrences DESC, normalized_query ASC
                    LIMIT :limit
                    """
                ),
                {"since": since, "limit": top_limit},
            ).all()

            zero_rows = session.execute(
                text(
                    """
                    SELECT normalized_query, count(*) AS occurrences, max(created_at) AS last_seen
                    FROM search_query_logs
                    WHERE created_at >= :since AND result_count = 0
                    GROUP BY normalized_query
                    ORDER BY occurrences DESC, normalized_query ASC
                    LIMIT :limit
                    """
                ),
                {"since": since, "limit": top_limit},
            ).all()

        total = int(totals[0] or 0)
        zero = int(totals[1] or 0)
        return {
            "total": total,
            "zero_result_rate": (zero / total) if total else 0.0,
            "average_took_ms": float(totals[2] or 0.0),
            "top": [
                QueryStat(row[0], int(row[1]), row[2]) for row in top_rows
            ],
            "zero": [
                QueryStat(row[0], int(row[1]), row[2]) for row in zero_rows
            ],
        }
