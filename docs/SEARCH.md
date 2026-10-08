# Search & Discovery (Part 12)

Production search for the Inkline storefront: query understanding, typo
correction, faceted filtering, layered relevance ranking, autocomplete, search
analytics, and an indexing pipeline.

This document covers architecture, the API surface, ranking, indexing, caching,
analytics, operations, and troubleshooting.

---

## 1. Architecture

```
                         CUSTOMER
                             │
                             ▼
              ┌──────────────────────────────┐
              │  Search UI (client)          │
              │  combobox · results · facets │
              └──────────────┬───────────────┘
                             │  every filter/sort change rewrites the URL,
                             │  which re-fetches — state is shareable
                             ▼
              ┌──────────────────────────────┐
              │  /api/search                 │  rate-limited, validated
              └──────────────┬───────────────┘
                             ▼
              ┌──────────────────────────────┐
              │  executeSearch()             │  src/services/search/query.service.ts
              └───┬──────────────────────┬───┘
                  │                      │
        ┌─────────▼────────┐   ┌─────────▼─────────┐
        │ QUERY PROCESSOR  │   │   FILTER ENGINE   │
        │ normalize        │   │ parse URL → filters│
        │ tokenize         │   │ build SQL WHERE   │
        │ spell correct    │   └─────────┬─────────┘
        │ synonyms         │             │
        │ entity extract   │             │
        │ intent detect    │             │
        └─────────┬────────┘             │
                  └──────────┬───────────┘
                             ▼
        ┌────────────────────────────────────────────┐
        │  PHASE 1 — PostgreSQL (recall)             │
        │  tsvector + trigram match, filters,        │
        │  coarse rank, bounded candidate set        │
        └────────────────────┬───────────────────────┘
                             ▼
        ┌────────────────────────────────────────────┐
        │  PHASE 2 — layered relevance (ranking.ts)  │
        │  text → entity → availability →            │
        │  commercial → quality → (personalization)  │
        └────────────────────┬───────────────────────┘
                             ▼
                  facets · results · metadata
                             │
                             ▼
                     search_query_logs  →  analytics dashboard
```

### The two-phase split, and why

Phase one runs in PostgreSQL and returns a **bounded** candidate set (default
400). Phase two applies the full relevance model in TypeScript.

Doing the whole ranking in SQL would produce a query so complex the planner
cannot use an index. Doing the matching in application code would mean shipping
the catalog to the app server on every keystroke. Bounding the candidate set
keeps both sides cheap, and the bound is a setting (`limits.candidateLimit`)
rather than a constant so it can be tuned under load.

### Where each concern lives

| Concern | Location |
| --- | --- |
| Query normalization, price parsing | `src/lib/search/normalize.ts` |
| Spell correction primitives | `src/lib/search/spell.ts` |
| Entity extraction | `src/lib/search/entities.ts` |
| Pipeline orchestration | `src/lib/search/query.ts` |
| Ranking weights + scoring | `src/lib/search/ranking.ts` |
| Filters, facets, URL state | `src/lib/search/filters.ts` |
| Search execution | `src/services/search/query.service.ts` |
| Autocomplete | `src/services/search/suggest.service.ts` |
| Analytics | `src/services/search/analytics.service.ts` |
| Per-user history | `src/services/search/history.service.ts` |
| Synonyms | `src/services/search/synonym.service.ts` |
| Indexing | `src/services/search/index.service.ts` |
| Correction vocabulary | `src/services/search/vocabulary.service.ts` |
| Entity lexicon | `src/services/search/lexicon.service.ts` |
| Ranking config + experiments | `src/services/search/config.service.ts` |

Everything under `src/lib/search/` is **pure and synchronous** — no database, no
I/O — so the entire query-understanding behaviour is unit-testable and can be
reused from a worker without modification.

---

## 2. The query pipeline

```
raw input
  → normalize       fold case/diacritics, collapse whitespace, bound length
  → tokenize        split on non-alphanumerics; identifiers stay intact
  → price extract   "under 50k" → { maxPaise: 5_000_000 }
  → abbreviations   "laptops" also matches "laptop"
  → spell correct   only to terms that exist in THIS catalog
  → synonyms        positional groups: (tee | t | shirt) & black
  → entities        brand / category / attribute / colour / gender
  → intent          PRODUCT | CATEGORY | BRAND | NAVIGATIONAL | BROAD
  → ProcessedQuery
```

The order is load-bearing. Price is extracted before tokenizing so `50000` never
becomes a search term. Spell correction runs before entity extraction so
`adiddas` is recognised as the brand rather than discarded as an unknown word.

### Worked example

Input: **`iphne pro max under 100000`**

| Stage | Result |
| --- | --- |
| normalize | `iphne pro max under 100000` |
| price | `{ maxPaise: 10_000_000, source: "under 100000" }` |
| remaining terms | `iphne`, `pro`, `max` |
| spell | `iphne` → `iphone` (a real brand in this catalog) |
| executed | `iphone pro max`, price ≤ ₹1,00,000 |
| UI | "Showing results for **iphone pro max** instead of *iphne pro max*" + an undo link |

### Normalization rules

- Case folded: `iPhone` = `iphone` = `IPHONE`
- Diacritics stripped via NFKD: `café` → `cafe`
- Whitespace collapsed, control characters removed
- Length bounded to 120 characters
- Stop words (`the`, `best`, `buy`, …) dropped from match terms but retained in
  the raw form shown back to the shopper
- Repeated characters capped at two (`shiiirt` → `shiirt`), **not** one — capping
  at one would break `dress` and `coffee`

### Identifiers are never rewritten

A bare SKU or barcode (`A17-256GB`, `8901234567890`) is detected and matched
**exactly** against the SKU/barcode columns. It is not tokenized, not
spell-corrected, and not synonym-expanded. Correcting a model number produces a
confidently wrong answer, which is worse than no answer.

### Price parsing

Understood forms:

| Input | Result |
| --- | --- |
| `under 50000`, `below 50k`, `less than 50000` | `maxPaise` |
| `above 10000`, `over 10k`, `more than 10000` | `minPaise` |
| `between 30000 and 50000` | both |
| `1000 to 2000`, `1000 - 2000` | both |
| `₹50000`, `rs 50000`, `50000 rupees` | currency decoration stripped |
| `50k`, `1.5l`, `2lakh`, `1cr` | Indian shorthand expanded |

**A bare number is not a price filter.** `laptop 50000` leaves `50000` as a
search term, because guessing a ceiling would silently hide products. `m` is not
treated as a multiplier — in a catalog it means metres as often as million.

---

## 3. Typo correction

### The rule

**A token may only be corrected to a term that exists in this catalog.**

The candidate list comes from `search_vocabulary`, which is rebuilt from the
catalog itself: product names, brand names, category names, attribute values,
and tags. So `iphne` → `iphone` because `iphone` is a brand in *this* store — not
because an edit-distance function thought they were close.

A word with no near neighbour (`zzzzzzzz`) is left untouched. That is the
difference between controlled correction and bending every query into the nearest
catalog word.

### What is never corrected

- Pure numbers and model numbers (`17`, `256gb`, `a17`)
- Tokens of three characters or fewer
- Terms already present in the vocabulary

### Confidence decides apply vs. suggest

```
confidence = 0.6 × shapeScore + 0.4 × commonality
  shapeScore   = 1 − distance/tokenLength
  commonality  = log10(documentCount + 1) / 3
```

- **≥ 0.62** → applied silently, and the UI says "Showing results for X"
  with an undo link.
- **< 0.62** → offered as "Did you mean X?" and the original query is executed.

This is why a rare term is not silently rewritten: with few products carrying it,
the correction is a guess, and the shopper should decide.

### Distance allowances

| Token length | Allowed edits |
| --- | --- |
| < 4 | 0 (never corrected) |
| 4–6 | 1 |
| ≥ 7 | 2 |

Damerau-Levenshtein is used, so a transposition (`ipohne` → `iphone`) costs one
edit rather than two.

---

## 4. Ranking

### The layers

| # | Layer | Signals |
| --- | --- | --- |
| 1 | Text | `exactSku`, `exactName`, `prefixName`, `tokenName`, `descriptionMatch` |
| 2 | Entity | `exactBrand`, `exactCategory`, `attributeMatch`, `tagMatch` |
| 3 | Availability | `outOfStockPenalty` |
| 4 | Commercial | `popularity`, `salesVelocity` |
| 5 | Quality | `rating`, `reviewVolume`, `freshness` |
| 6 | Personalization | **always 0** — the slot exists, no signals yet |

### The invariant

Commercial + quality signals can reorder **close** matches. They can never
promote a product that does not match the query past one that does.

`assertLayerBalance` enforces this: the maximum commercial+quality contribution
must stay below `tokenName`. At their maxima the shipped weights sum to ~100,
against `tokenName` = 120.

This is checked in three places, because a bad ranking change is expensive:

1. On every read of a stored config (logged at error level)
2. On save — an unbalanced config is **rejected**
3. In the unit tests

### Weights are data, not literals

Weights live in `search_ranking_configs.weights` (jsonb), keyed by version.

Two reasons:

- Tuning relevance must not require a deploy
- A bad change must be revertable by flipping `is_active` back to the previous row

An unknown key in the stored blob is **rejected**, not ignored — a typo like
`exactBrnad` would otherwise silently leave the real signal at its default, and
the operator would see "my change did nothing" with no explanation.

### Ranking version

Every search response carries `metadata.rankingVersion`, and every
`search_query_logs` and `search_events` row records it. That is what makes a
ranking change measurable: compare click-through rate between `v1` and `v2` over
the same period.

### Out-of-stock handling

Configurable per ranking config:

| Mode | Behaviour |
| --- | --- |
| `HIDE` | unavailable products are removed |
| `DEMOTE` (default) | kept, pushed down by `outOfStockPenalty` |
| `ONLY_IF_EMPTY` | shown only when nothing available matches |

---

## 5. Filters and facets

### Filters are generated, not hard-coded

The facet list is derived from the attribute axes the matched products actually
carry. Adding a `Material` axis in the admin makes a Material filter appear on
the storefront with no deploy.

### URL state

Every filter, the sort, the query, and the cursor are URL parameters:

```
/search?q=shoes&brand=nike&attr.color=black&attr.size=9&minPrice=2000&maxPrice=8000&sort=rating
```

The round trip `parse(serialize(f)) === f` is a tested contract. That is what
makes a search bookmarkable, shareable, and correct under browser back/forward.
Nothing is hidden in React state alone.

### Facets

Counts are computed **within the current query**, so a facet never offers a
combination that returns nothing. Selected values stay in the list and are
flagged — a facet that disappears when you tick it looks broken.

Price is bucketed into fixed bands (`Under ₹1,000`, `₹1,000 – ₹5,000`, …)
because "₹4,999 – ₹5,001" is not a choice a shopper can act on. Empty buckets are
omitted.

### Sorting

Server-side only, across eight strategies: `relevance`, `popularity`, `newest`,
`price-asc`, `price-desc`, `rating`, `discount`, `best-selling`.

An unknown sort value falls back to `relevance` rather than being interpolated
into an `ORDER BY`.

### Pagination

Cursor-based. The cursor is `base64url("<score>:<productId>")`, split on the
**first** colon (the score is a fixed-format float that never contains one; a
product id legitimately can).

---

## 6. Indexing

### Schema

`product_search_index` — one row per product, holding only what discovery needs:

| Column | Purpose |
| --- | --- |
| `product_id`, `slug`, `name` | identity and display |
| `brand_name`, `brand_id`, `category_id`, `category_path` | entity facets |
| `sku_text`, `tag_text`, `attribute_text`, `description_text` | matchable text |
| `search_vector` (tsvector, GIN) | full-text match |
| `trigram_text` (gin_trgm_ops GIN) | typo tolerance and prefix |
| `price_paise`, `compare_at_paise` | price filter and discount sort |
| `rating_average`, `rating_count` | quality signals |
| `popularity` | commercial signal |
| `is_searchable` | partial-index predicate: ACTIVE + PUBLIC only |
| `indexed_at` | staleness detection |

**No private fields.** No cost price, no supplier references, no seller internals.
The index is read by a public endpoint.

### Event-driven updates

```
product write  →  catalog_events (same transaction)  →  worker  →  product_search_index
```

Part 11 writes catalog changes to an outbox **inside** the product-write
transaction, so an event is never lost and never fabricated. The worker consumes
it:

```
npm run search:queue
```

This is the routine path — no administrator has to remember to reindex anything.

**Why an outbox rather than an inline write:** indexing inside the product-write
transaction would make a slow index write fail the save. Decoupling means the
save is fast and durable and the index catches up. The cost is eventual
consistency, which for search is the right trade — a product appearing a second
late is invisible; a failed product save is not.

A failed event is marked failed and skipped, never retried forever. One
unindexable product must not wedge the queue.

### Commands

```bash
npm run search:status              # index health
npm run search:index               # full rebuild
npm run search:queue               # drain the pending event queue
npm run search:reindex:derived     # rebuild vocabulary + suggestions
npm run search:index -- --category <id>
npm run search:index -- --brand <id>
npm run search:index -- --product <id>
npm run search:index -- --batch-size 1000
```

Full rebuilds are keyset-paged by primary key and report progress with an ETA, so
a long run does not look hung.

---

## 7. Caching

| What | TTL | Invalidation |
| --- | --- | --- |
| Search results | 30s | short by design — stock and price move |
| Suggestions | 120s | `refreshSuggestionTable` |
| Facets | 60s | follows the result cache |
| Entity lexicon | 60s in-process | `invalidateLexiconCache()` on brand/category/attribute write |
| Synonym map | 60s in-process | `invalidateSynonymCache()` on synonym write |
| Ranking config | 30s in-process | `invalidateRankingConfigCache()` on config save |

Cache keys are the **canonical** query (tokens sorted and deduplicated) plus the
filter signature, so `Nike Shoes` and `shoes nike` share one entry.

**Personalized searches are never cached globally.** The personalization layer is
disabled, but the rule is stated here so it survives the day it is enabled.

Inventory is deliberately **not** cached in search results beyond the short TTL —
a stale "in stock" is a customer-facing bug.

---

## 8. API

### `GET /api/search`

| Param | Notes |
| --- | --- |
| `q` | free text, max 120 chars. Longer is rejected, not truncated |
| `category`, `brand` | comma-separated ids |
| `minPrice`, `maxPrice` | rupees |
| `rating` | 1–5 |
| `availability` | `any` \| `in_stock` \| `out_of_stock` \| `on_sale` |
| `sale` | `1` for discounted only |
| `attr.<axis>` | comma-separated values, e.g. `attr.color=black,white` |
| `sort` | see §5 |
| `limit` | 1–100 |
| `cursor` | from a previous response |

Returns `{ query, correctedQuery, results, facets, suggestions, nextCursor, metadata }`.

An unparseable parameter is **dropped**, not rejected, so a hand-edited URL
degrades to a working search.

### `GET /api/search/suggestions?q=&limit=`

Typed suggestions: `PRODUCT`, `BRAND`, `CATEGORY`, `SEARCH_QUERY`,
`TRENDING_QUERY`, `HISTORY`. The type lets the frontend render each differently.

This endpoint **never** runs the search pipeline — no spell correction, no
faceting, no hydration. Autocomplete fires on every keystroke and has to answer
in single-digit milliseconds.

### `GET|DELETE /api/search/history`

Signed-in users only. The user id comes from the session; there is no parameter
that selects whose history to read.

### `POST /api/search/click`

Records `CLICK` / `ADD_TO_CART` / `PURCHASE` against a `searchLogId`. Bot traffic
is dropped rather than recorded.

### Admin (catalog-editor role required)

- `GET /api/admin/search/analytics?days=30`
- `GET|POST|PATCH|DELETE /api/admin/search/synonyms`
- `GET|POST /api/admin/search/index`

---

## 9. Analytics

### Privacy

`search_query_logs` stores a **salted HMAC** of the user id or IP
(`SEARCH_SESSION_SALT`), never the raw value. Search logs are the most casually
collected data in the system and the most tempting to over-collect; a raw IP is
personal data under most privacy regimes, and a user id links every query a
person ever typed to their account forever.

Search **history** is the one place a user id appears, and it is the user's own
row, readable only by them.

Anonymous visitors keep history in the browser. A server-side history keyed by
session id would be a durable, linkable browsing record for people who never
agreed to one.

### Metrics

Overview: total searches, unique queries, average result count, zero-result rate,
click-through rate, add-to-cart rate, and p50/p95/p99 latency.

Percentiles, not averages — an average of 80 ms can hide a p99 of 3 seconds, and
the p99 is what a shopper experiences as "search is broken".

Also: trending queries, rising queries (recent half vs. earlier half of the same
window), zero-result queries with a suggested fix, low-click queries, and clicks
by position.

Bot traffic is excluded by a deliberately narrow heuristic. Under-counting a
trend is a small error; hiding real demand is a large one.

### Dashboard

`/admin/search` — Overview, Trending, Zero results, Relevance, Synonyms.

---

## 10. Security

- **Rate limiting** on every endpoint; search is the tightest (60/min) because it
  fires on every filter change
- **Query length** bounded to 120 characters; longer input is rejected rather
  than truncated, because silently truncating returns results for a query the
  shopper never typed
- **Parameter validation** everywhere; unknown sorts fall back, unknown facets
  are dropped
- **No raw query syntax reaches the database.** Every term is tokenized to
  letters and digits before being assembled into a `tsquery`
- **No private fields** in the index or the API response
- **Authorization** on all admin routes
- **Logging** without personal data

---

## 11. Failure handling

Every dependency degrades independently:

| Failure | Behaviour |
| --- | --- |
| No lexicon | no entity extraction; text search still works |
| No vocabulary | no spell correction |
| No ranking config | compiled-in v1 defaults |
| Index query fails | `metadata.degraded = true` + a reason, never a silent empty set |
| Facet query fails | results returned without facets |
| Analytics write fails | search still succeeds |

"Search is broken" and "nothing matched" must be distinguishable to both the
shopper and the on-call engineer. A silent empty result set is the worst outcome.

---

## 12. Local development

```bash
# 1. Database
cp .env.example .env          # fill in DATABASE_URL, SEARCH_SESSION_SALT
npm run db:migrate            # applies 0003–0007

# 2. Seed a search corpus (24 brands, 8 categories, 120 products, variants)
npm run db:seed:search

# 3. Build the index and the derived structures
npm run search:index
npm run search:reindex:derived

# 4. Run
npm run dev
```

Then try:

| Query | What it exercises |
| --- | --- |
| `laptopp` | typo correction |
| `iphne pro max under 100000` | typo + price constraint |
| `nike black shoes` | brand + colour + category extraction |
| `laptop between 30000 and 50000` | price range |
| `tee` | synonym expansion |
| `A17-256GB` | exact identifier match |
| `zzzzqqqq` | zero-result recovery |

### Tests

```bash
npm test                                  # full suite (615 tests)
npx vitest run tests/unit/search-*.test.ts    # search unit tests
npm run test:db                           # integration tests on embedded PostgreSQL
npm run native:test                       # C++ engine + C importer
npm run service:test                      # Python catalog-intelligence service
npm run db:parity                         # schema ↔ migration drift check
```

### Load testing

```bash
# Terminal 1 — SEARCH_LOADTEST is the rate-limit multiplier, so the run measures
# the engine rather than the limiter. Never set it in a deployed environment.
SEARCH_LOADTEST=500 AUTH_SECRET=dev-secret npm run dev

# Terminal 2
npm run search:loadtest
npm run search:loadtest -- --concurrency 20 --seconds 30
```

Reports p50/p95/p99, throughput, and error rate for search and autocomplete
separately, using a query mix weighted like real traffic. A deterministic seed
makes runs comparable. Exits non-zero above a 1% error rate.

Rate-limited responses (429) are counted **separately** from errors. They are the
limiter working as designed, not a fault — and latency is measured over served
requests only, because the latency of a rejected request says nothing about the
search path. Without `SEARCH_LOADTEST` set, a single-IP run spends most of its
requests collecting 429s and the script says so rather than printing numbers that
look like engine throughput.

### Measured results

Run against a 120-product / 540-variant seeded corpus, `next dev` (Turbopack),
single Node process, embedded PostgreSQL, concurrency 10, 30 seconds:

| | Search | Autocomplete |
| --- | --- | --- |
| Requests served | 1,245 | 530 |
| Throughput | 40.8 req/s | 17.4 req/s |
| Errors | 0 (0.00%) | 0 (0.00%) |
| Rate-limited | 0 | 0 |
| p50 | 182 ms | 106 ms |
| p95 | 253 ms | 153 ms |
| p99 | 594 ms | 306 ms |
| max | 751 ms | 606 ms |

**These are development-server numbers and should not be read as production
capacity.** `next dev` compiles routes on first hit and runs unoptimised; a
production build (`npm run build && npm run start`) will be materially faster.
They are recorded because they are what was actually measured, and because the
important signal here is the shape — zero errors, zero rate-limiting, and a p99
that is not an order of magnitude above the p50 — not the absolute values.

The corpus is also small. Re-run against a production-sized catalog before drawing
conclusions about scale; the two-phase design (§1) is what is intended to hold up
at 100k+ products, but that has not been measured here.

---

## 13. Production deployment

```
CDN
 ↓
Web App (Next.js)
 ↓
/api/search  ──→  PostgreSQL (tsvector + trigram GIN indexes)
 ↓
search_query_logs  →  /admin/search
```

Workers drain the event queue on a schedule:

```bash
npm run search:queue
```

### Required environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | same instance as the app |
| `SEARCH_SESSION_SALT` | **yes in production** | `openssl rand -hex 32`. A dev fallback exists; using it in production would make the hash reversible |
| `CPPSEARCH_LIBRARY` | no | path to `libcppsearch.so`; empty searches the usual places |

---

## 14. Troubleshooting

**Search returns nothing for everything.**
`npm run search:status`. If `indexed` is 0, run `npm run search:index`.

**`stale` count is high.**
Products changed after they were indexed. `npm run search:queue` drains the
backlog; check `failed events` for rows that could not be indexed.

**A typo is not corrected.**
The vocabulary is built from the catalog. `npm run search:reindex:derived`, then
confirm the intended term exists: it must be a real product word, brand,
category, attribute, or tag. Check confidence — a rare term is *suggested*, not
applied, by design.

**A facet is missing.**
Facets come from attribute axes on the matched products. If no matched product
carries that axis, there is nothing to facet on.

**Ranking changed unexpectedly.**
Check the active version in `/admin/search` → Relevance. Every logged query
records its `rankingVersion`, so you can compare periods.

**"Ranking is unbalanced" warning.**
A stored config lets commercial signals outweigh a name match. It is rejected on
save; if it appears, an older row is active. Fix the weights or activate a
different version.

---

## 15. What is deliberately not here

- **Personalization.** The layer exists and is always zero. It is disabled until
  real signals exist, rather than shipping a guess.
- **Semantic / vector search.** The interfaces are shaped for it —
  `ProcessedQuery` is the boundary a stronger model would replace — but nothing
  here pretends to do it.
- **An A/B platform.** `search_experiments` holds variants and buckets by session
  hash; measurement reuses the analytics already collected. Deliberately minimal.
- **Sales velocity.** The weight exists and is fed `0`, because the data does not
  exist yet. Fabricating a number would be worse than leaving the slot empty.
