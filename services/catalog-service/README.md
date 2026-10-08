# Catalog-intelligence service

A FastAPI service that sits beside the Next.js application and answers the
questions that are awkward in SQL: ranked search over a large catalog,
autocomplete, recommendations, and inventory signals.

It is **read-only**. It issues no `INSERT`, `UPDATE` or `DELETE` — every write to
catalog data goes through the Next.js service layer, which owns the
transactions, the event outbox and the audit trail. This service can therefore
be given a read-replica connection string without anyone having to reason about
write conflicts.

```
services/catalog-service/
  app/
    config.py       Settings, all under the CATALOG_SERVICE_ prefix
    db.py           SQLAlchemy engine + the read queries
    ranking.py      ctypes binding to the native ranking engine
    intelligence.py Connects PostgreSQL to the ranking engine
    schemas.py      Pydantic request/response models
    main.py         ASGI app factory and routes
  scripts/
    verify_table_metadata.py   Guards against schema drift
  tests/
  Makefile
  requirements.txt
  .env.example
```

## What it is for, and what it is not

The Next.js app already does full-text search in PostgreSQL (see
`src/services/catalog/search.service.ts` and `docs/SEARCH.md`). This service
exists for the cases where that stops being enough:

- **Ranking at catalog scale.** The native BM25 engine in `native/cpp-search`
  scores a candidate set far cheaper than a SQL relevance expression can, and it
  keeps its own in-memory index and vocabulary.
- **Recommendations and inventory signals.** These want to look at the catalog
  as a whole rather than at one page of results.
- **A place to grow ML-shaped logic** without making the web process carry a
  numerical stack.

It is not a second source of truth. PostgreSQL decides *eligibility* (what is
published, what is in stock, what the price is); the native engine decides
*ordering*. `intelligence.py` is where those two meet, and it falls back to a
simple lexical ranking when the native library is missing, so the service starts
and serves traffic either way.

## Quick start

```bash
cd services/catalog-service

make install     # create .venv and install requirements
make build       # build native/cpp-search (libcppsearch.so)
make test        # pytest — no database required
make dev         # uvicorn with reload on 0.0.0.0:8100
make lint        # byte-compile every module
make clean       # remove .venv, caches and build output
```

`make test` needs no database: the fixtures exercise the schemas, the ranking
binding and the route handlers against a stubbed data layer.

For a run against real data, copy `.env.example` to `.env` and set
`CATALOG_SERVICE_DATABASE_URL`. Note the driver prefix — SQLAlchemy wants
`postgresql+psycopg://…`, not the plain `postgresql://…` the Next.js app uses
for the same server.

## Configuration

Every variable is prefixed `CATALOG_SERVICE_` so this `.env` can sit next to the
application's without colliding. `.env.example` is the complete list and is
commented; the ones worth knowing:

| Variable | Meaning |
| --- | --- |
| `CATALOG_SERVICE_DATABASE_URL` | Same PostgreSQL server as the app. **Required.** |
| `CATALOG_SERVICE_CPPSEARCH_LIBRARY` | Absolute path to `libcppsearch.so`. Empty means "search the usual places". |
| `CATALOG_SERVICE_INDEX_REFRESH_SECONDS` | Minimum interval between in-memory index rebuilds. |
| `CATALOG_SERVICE_INDEX_MAX_DOCUMENTS` | Ceiling on what gets indexed. |
| `CATALOG_SERVICE_CORS_ORIGINS` | Leave empty in production — the app calls this service server-to-server. |

`CATALOG_SERVICE_CPPSEARCH_LIBRARY` takes precedence, then the unprefixed
`CPPSEARCH_LIBRARY` (documented in the repository-root `.env.example` for the
Next.js process), then `native/cpp-search/build/` inside the repo, then the
loader's own search path.

## Routes

| Method & path | Purpose |
| --- | --- |
| `GET /health` | Liveness, plus database and index state |
| `POST /v1/search` | Ranked search over the catalog |
| `GET /v1/suggestions` | Autocomplete terms |
| `POST /v1/recommendations` | Related / frequently-bought-together |
| `GET /v1/inventory/insights` | Low-stock and out-of-stock signals |
| `GET /v1/search/insights` | Query volume and zero-result rates |
| `POST /v1/index/refresh` | Force an index rebuild after a large import |

Interactive docs at `/docs` (Swagger UI) and `/redoc` when the server is
running.

### Status codes

`422` for input the caller got wrong, `503` when the database is unreachable or
— for `/v1/index/refresh` only — when the ranking engine is not loaded.

`GET /health` deliberately reports `degraded` rather than failing when the
native engine is missing but search can still be served from the lexical
fallback. A health endpoint that returned 503 there would pull the instance out
of rotation for something that does not warrant it. `status` is one of `ok`,
`degraded`, `unavailable`, and the body says which dependency is at fault.

## The native ranking engine

`app/ranking.py` is a `ctypes` binding to `libcppsearch.so`. The C ABI is
documented in `native/cpp-search/include/cppsearch/ffi.h`, which is the
authority for the struct layouts and the ownership rules.

Two things about that boundary are worth knowing before touching it:

- **There is no `clear` in the ABI.** To empty the index the Python side swaps a
  freshly built index in under a lock, rather than mutating a live one.
- **A truncated C string from the FFI is worse than an error.** Buffers that are
  too small must fail loudly rather than return a clipped term.

When the library cannot be loaded, `load_engine` raises
`RankingEngineUnavailable` naming every path it tried, and the service logs that
and continues on the fallback.

## Schema drift

The SQLAlchemy declarations in `app/db.py` are hand-written, so they can drift
from the Drizzle schema that actually owns the tables. `tests/test_table_metadata.py`
and `scripts/verify_table_metadata.py` are the guard: they parse
`src/db/schema/*.ts` and fail if this service declares a column the application
does not have.

```bash
.venv/bin/python scripts/verify_table_metadata.py
```

Run it after any change to `src/db/schema/` or to `app/db.py`.

## Deployment notes

- Bind `0.0.0.0`; the service is called by the Next.js server, not by browsers.
- It holds an in-memory index, so it is **not** stateless in the usual sense.
  Give each instance time to warm up before routing traffic to it, and expect a
  cold instance to be slower until the first refresh completes.
- Scaling out means N copies of the index, one per instance. That is acceptable
  up to `CATALOG_SERVICE_INDEX_MAX_DOCUMENTS`; beyond it, indexing belongs in a
  dedicated search backend rather than in-process.
