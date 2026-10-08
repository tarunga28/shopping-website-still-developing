"""Guard the hand-declared table metadata against schema drift.

`app/db.py` declares its tables explicitly instead of reflecting them, which is
the right trade-off (no per-table query at startup, and a schema change becomes
a code change) but only if something notices when the two disagree. This test is
that something.

It matters because nothing else would catch it: every other test in this suite
runs against a fake database, so a wrong column name would survive the whole
test run and fail on the first production request.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest
from sqlalchemy import MetaData

from app.db import _declare_tables

SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = SERVICE_ROOT.parents[1]
SCRIPTS = SERVICE_ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from verify_table_metadata import (  # noqa: E402
    SCHEMA_DIR,
    columns_from_schema,
    table_names,
)

TABLE_NAMES = {
    "search_index": "product_search_index",
    "products": "products",
    "variants": "product_variants",
    "query_logs": "search_query_logs",
    "suggestions": "search_suggestions",
    "relations": "product_relations",
    "inventory_ledger": "inventory_ledger",
}


@pytest.fixture(scope="module")
def schema_columns() -> dict[str, set[str]]:
    columns = columns_from_schema()
    # The schema must actually have been found, or every assertion below would
    # vacuously pass against an empty schema.
    assert columns, "no pgTable definitions were parsed from src/db/schema"
    return columns


def test_schema_sources_are_present() -> None:
    """The catalog and catalog-intelligence schema files must exist."""
    assert SCHEMA_DIR.is_dir(), f"missing schema directory: {SCHEMA_DIR}"
    names = {path.name for path in SCHEMA_DIR.glob("*.ts")}
    for expected in ("catalog.ts", "catalog-intelligence.ts"):
        assert expected in names, f"missing schema file: {expected}"


def test_parser_reads_columns_from_the_typescript_schema() -> None:
    """Guard the parser itself.

    It reads a specific indentation (four spaces inside pgTable). If the codebase
    is ever reformatted, this catches the parser silently returning empty column
    sets — which would make every downstream check vacuous.
    """
    columns = columns_from_schema()
    assert len(columns.get("products", set())) > 20, "products parsed with too few columns"
    assert "slug" in columns.get("products", set())
    assert "sku" in columns.get("product_variants", set())
    # Spread helpers must expand, or id/created_at go missing everywhere.
    assert "id" in columns.get("products", set())
    assert "created_at" in columns.get("products", set())


def test_parser_handles_multiline_column_definitions() -> None:
    """A column whose modifiers continue on following lines must still be read.

    Drizzle commonly formats a foreign key as:

        productId: uuid("product_id")
          .notNull()
          .references(() => products.id, { onDelete: "cascade" }),

    The column name is on the first line, so a parser that required the whole
    definition on one line would miss it. This pins that behaviour against the
    real schema rather than a synthetic fixture.
    """
    columns = columns_from_schema()
    relations = columns.get("product_relations", set())
    assert "product_id" in relations
    assert "related_product_id" in relations


@pytest.mark.parametrize("key", sorted(TABLE_NAMES))
def test_every_declared_column_exists(key: str, schema_columns: dict[str, set[str]]) -> None:
    real_name = TABLE_NAMES[key]
    actual = schema_columns.get(real_name)
    assert actual is not None, f"{real_name} was not found in any migration"

    declared = {column.name for column in _declare_tables(MetaData())[key].columns}
    missing = sorted(declared - actual)
    assert not missing, (
        f"{real_name} declares columns that do not exist in the schema: {missing}. "
        f"The schema has: {sorted(actual)}"
    )


def test_no_declared_table_is_empty() -> None:
    """A table declared with zero columns would make every query invalid."""
    for key, table in _declare_tables(MetaData()).items():
        assert len(table.columns) > 0, f"{key} declares no columns"


def test_relation_types_used_by_the_service_are_in_the_enum() -> None:
    """The service asks for relation types by string; the enum is the contract.

    `product_relation_type` is RELATED | UPSELL | CROSS_SELL |
    FREQUENTLY_BOUGHT_TOGETHER | ACCESSORY. Querying a type that is not a member
    returns nothing forever and looks like "no merchandising data".
    """
    enums_path = REPO_ROOT / "src" / "db" / "schema" / "enums.ts"
    source = enums_path.read_text()
    block = re.search(r"productRelationTypeEnum = pgEnum\([^,]+,\s*\[(.*?)\]", source, re.S)
    assert block, "could not find productRelationTypeEnum in enums.ts"
    members = set(re.findall(r'"([A-Z_]+)"', block.group(1)))
    assert members, "productRelationTypeEnum parsed as empty"

    service_source = (SERVICE_ROOT / "app" / "intelligence.py").read_text()
    used = set(re.findall(r'related_ids\([^,]+,\s*"([A-Z_]+)"', service_source))
    assert used, "expected the service to query at least one relation type"
    unknown = used - members
    assert not unknown, f"service queries relation types absent from the enum: {unknown}"
