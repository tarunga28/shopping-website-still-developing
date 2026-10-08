"""Verify that the Python service's hand-declared table metadata matches the real DDL.

The catalog-intelligence service declares its tables by hand (see app/db.py)
rather than reflecting them, so a schema change would not be caught by the
compiler. This script is that check: it reads the column names out of the
generated migration SQL and compares them with what the Python service declares.

Run: .venv/bin/python scripts/verify_table_metadata.py   (from services/catalog-service)
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = SERVICE_ROOT.parents[1]
sys.path.insert(0, str(SERVICE_ROOT))

from app.db import _declare_tables  # noqa: E402
from sqlalchemy import MetaData  # noqa: E402

# Every SQL file that contributes catalog DDL, in application order. The base
# snapshot lives outside drizzle/ because it was generated for the parity check.
# The authoritative source is the tracked Drizzle schema, not generated SQL.
#
# An earlier version of this script parsed a generated baseline migration that
# lived in an untracked scratch directory. That directory does not persist, so
# the script silently lost the pre-Part-11 tables and reported phantom drift.
# Reading `src/db/schema/*.ts` directly removes the dependency on anything
# generated, and it checks the thing the ORM actually uses.
SCHEMA_DIR = REPO_ROOT / "src" / "db" / "schema"

CREATE_TABLE = re.compile(r'CREATE TABLE (?:IF NOT EXISTS )?"?([a-z_0-9]+)"?\s*\((.*?)\n\);', re.S)
# Part 11 adds most of its columns to pre-existing tables, so a CREATE-only
# parser would report those tables as missing entirely.
# ALTER TABLE statements are matched whole, then their clauses scanned, because
# PostgreSQL allows several ADD COLUMN clauses in one statement:
#
#   ALTER TABLE products
#     ADD COLUMN IF NOT EXISTS barcode text,
#     ADD COLUMN IF NOT EXISTS stock_quantity integer NOT NULL DEFAULT 0;
#
# A regex anchored on "ALTER TABLE ... ADD COLUMN" only sees the first one and
# silently under-reports the table, which is exactly the failure this script
# exists to catch.
ALTER_STATEMENT = re.compile(r"ALTER TABLE (?:IF EXISTS )?\"?([a-z_0-9]+)\"?\s+(.*?);", re.S | re.I)
ADD_CLAUSE = re.compile(r"ADD COLUMN (?:IF NOT EXISTS )?\"?([a-z_0-9]+)\"?", re.I)
DROP_CLAUSE = re.compile(r"DROP COLUMN (?:IF EXISTS )?\"?([a-z_0-9]+)\"?", re.I)


# Matches `export const x = pgTable("table_name", {`
PG_TABLE = re.compile(r"pgTable\(\s*\n?\s*\"([a-z_0-9]+)\"\s*,\s*\{")
# Matches a column definition line: `    camelName: builder("snake_name")`.
# Indentation inside pgTable() is four spaces; matching a fixed two would find
# nothing and silently report every table as empty.
COLUMN_DEF = re.compile(r"^\s+[a-zA-Z][a-zA-Z0-9]*:\s*[a-zA-Z_]\w*\s*\(?\s*\"([a-z_0-9]+)\"")
# Spread helpers that inject standard columns.
SPREAD_HELPERS = {
    "idColumn": {"id"},
    "timestamps": {"created_at", "updated_at"},
    "timestampsNoUpdate": {"created_at"},
}


def columns_from_schema() -> dict[str, set[str]]:
    """Table name -> set of column names, parsed from the Drizzle schema source.

    Only the column-name string literal is read, which is exactly what the
    database sees; the TypeScript property names are irrelevant here.
    """
    found: dict[str, set[str]] = {}

    for path in sorted(SCHEMA_DIR.glob("*.ts")):
        source = path.read_text()

        for match in PG_TABLE.finditer(source):
            table = match.group(1)
            # Take the body up to the closing of the column object. Drizzle table
            # definitions end the column block with `\n  },` before the index
            # callback, so slicing there is enough to isolate column lines.
            body = source[match.end():]
            # Two-space `},` closes the column object; columns themselves are at
            # four spaces, so this boundary cannot be confused with a column line.
            cut = body.find("\n  },")
            if cut != -1:
                body = body[:cut]

            columns = found.setdefault(table, set())
            for line in body.split("\n"):
                column = COLUMN_DEF.match(line)
                if column:
                    columns.add(column.group(1))
                    continue
                for helper, helper_columns in SPREAD_HELPERS.items():
                    if re.match(rf"^\s+\.\.\.{helper}\s*,?\s*$", line):
                        columns.update(helper_columns)

    return found


# The service's short table names mapped to the real SQL table names.
table_names: dict[str, str] = {
    "search_index": "product_search_index",
    "products": "products",
    "variants": "product_variants",
    "query_logs": "search_query_logs",
    "suggestions": "search_suggestions",
    "relations": "product_relations",
    "inventory_ledger": "inventory_ledger",
}


def main() -> int:
    declared = _declare_tables(MetaData())
    real = columns_from_schema()

    failures = 0
    for key, real_name in table_names.items():
        table = declared[key]
        declared_columns = {column.name for column in table.columns}
        actual = real.get(real_name)
        if actual is None:
            print(f"FAIL  {real_name}: not found in src/db/schema")
            failures += 1
            continue
        missing = sorted(declared_columns - actual)
        if missing:
            print(f"FAIL  {real_name}: declares columns absent from the schema: {missing}")
            print(f"      schema has: {sorted(actual)}")
            failures += 1
        else:
            print(f"ok    {real_name}: all {len(declared_columns)} declared columns exist")

    print()
    if failures:
        print(f"{failures} table(s) drifted from the schema")
        return 1
    print("all declared table metadata matches src/db/schema")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
