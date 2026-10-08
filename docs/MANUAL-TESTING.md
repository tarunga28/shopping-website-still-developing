# Manual Testing Checklist — Parts 11 & 12

A hands-on checklist for the Product Catalog & Product Intelligence Engine (Part 11) and
the Advanced Search, Discovery & Relevance Engine (Part 12). Automated coverage lives in
`tests/unit`, `tests/integration`, `native/*/tests` and `services/catalog-service/tests`;
this document covers what a human should click through on a running instance.

Every URL below assumes the dev server on `http://localhost:3000`.

---

## 0. Prerequisites

### 0.1 Environment

```bash
cp .env.example .env
```

Fill in at minimum:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL 14+ connection string. Required by Next.js and the Python service. |
| `AUTH_SECRET` | next-auth session encryption. |
| `NEXT_PUBLIC_APP_URL` | Canonical origin; used for metadata and canonical URLs. |
| `SEARCH_SESSION_SALT` | HMAC salt for the anonymous search session cookie. Without it the session is derived from a default — fine locally, not in production. |
| `CPPSEARCH_LIBRARY` | Optional absolute path to the compiled `libcppsearch.so`. Omit to fall back to SQL ranking. |
| `CATALOG_SERVICE_DATABASE_URL` | For the Python service only (falls back to `DATABASE_URL`). |

`IP_HASH_SALT` is used to hash client IPs for per-IP rate limits; leave it unset locally.

### 0.2 Database + data

```bash
npm install
npm run db:migrate          # applies drizzle/0003..0007
npm run db:seed             # baseline catalog, users, categories
npm run db:seed:search      # Part 12 discovery corpus (120 products / 540 variants)
npm run search:index        # builds search_products + vocabulary
npm run search:reindex:derived
```

### 0.3 Native modules (optional but recommended)

```bash
npm run native:build
npm run native:test         # cpp-search 100 checks, c-importer 5157 checks
```

### 0.4 Automated gates

Run these first; if one is red, stop and fix it before clicking anything.

| Command | Expected |
|---|---|
| `npm run typecheck` | 0 errors |
| `npm run db:parity` | `✓ HEAD + 0006 + 0007 == current Drizzle schema (1699 facts)` |
| `npm test` | 469 passed, 176 skipped |
| `npm run test:db` | 176 passed |
| `npm run e2e:catalog` | 21/21 PASS, `E2E CATALOG: all checks passed` |
| `npm run native:test` | 0 failures in both modules |
| `npm run service:test` | 109 passed |
| `npm run build` | `✓ Compiled successfully` |

Then:

```bash
npm run dev
```

Sign in as an admin account before section 1.

---

## 1. Admin — product catalog

### 1.1 Product list (`/admin/products`)

- [ ] Table renders with columns, and no page ever loads the whole catalog.
- [ ] Search box filters server-side (type a fragment of a real product name).
- [ ] Status filter (`DRAFT` / `ACTIVE` / `ARCHIVED`) narrows the list.
- [ ] Category filter narrows the list.
- [ ] Sorting by column header changes order and survives pagination.
- [ ] Pagination controls move through pages; page 2 is not page 1.
- [ ] Bulk selection: select several rows, change status, apply — all selected rows change.
- [ ] Bulk move to category applies to all selected rows.
- [ ] Bulk inventory adjustment opens a typed-confirmation dialog and refuses to submit
      until the exact phrase is typed.
- [ ] Empty state (search for `zzzzqqqq`) shows a message, not a crash.

### 1.2 Create product (`/admin/products/new`)

Create a product exercising every section:

- [ ] **GENERAL** — name, slug auto-derives from the name, short + full description, type.
- [ ] **PRICING** — base price, sale price, cost price, tax rate. Price fields accept
      rupees and store paise.
- [ ] **INVENTORY** — stock quantity, low-stock threshold. Opening stock is written as a
      `STOCK_IN` ledger row (verify in 1.4).
- [ ] **MEDIA** — add a `PRODUCT` type image. **A product cannot publish without one.**
- [ ] **VARIANTS** — add at least one variant. **Cannot publish without one.** Add an
      attribute that is *not* size or colour (e.g. `Material`) to prove the engine is
      attribute-driven, not hard-coded.
- [ ] **SEO** — meta title, meta description, canonical slug.
- [ ] Responsive: narrow the browser to ~380 px; the form stays usable.

### 1.3 Validation

- [ ] Submitting with an empty name is rejected server-side with a readable message.
- [ ] A duplicate slug is rejected.
- [ ] A negative price is rejected.
- [ ] A malformed SKU is rejected (must match `^[A-Z0-9][A-Z0-9-_]*$`, 3–64 chars).
- [ ] A variant count over 200 or attribute axes over 6 is rejected.
- [ ] Bypass the form and POST directly to `/api/products` with an invalid body → **422**.

### 1.4 Publish + inventory

- [ ] `/admin/products/[id]` shows the publish checklist. With a missing image or
      variant, publish is blocked and the blocker is named.
- [ ] After satisfying the checklist, publish succeeds and the product becomes public.
- [ ] `/admin/inventory` lists variants with stock; filter by low stock.
- [ ] Adjust stock down by 5 → the ledger shows a row with the correct
      `previous_quantity` / `quantity_changed` / `new_quantity` triple.
- [ ] Adjust stock below zero without the negative-stock setting → refused.
- [ ] Re-issue the *same* `referenceId` → no double-count (idempotent replay,
      `quantityChanged: 0`).

### 1.5 Categories (`/admin/categories`)

- [ ] Tree renders with indentation reflecting depth.
- [ ] Create a child under an existing category; the materialized `path` is server-derived.
- [ ] **Move** a subtree to a new parent — children's paths update too, not just the moved node.
- [ ] Reorder siblings; order persists after reload.
- [ ] Archive a category that has products — the products survive (the FK is
      `ON DELETE SET NULL`), and the category disappears from the tree.
- [ ] Depth beyond 20 is rejected.

### 1.6 Brands (`/admin/brands`)

- [ ] Create a brand **with** an explicit slug — it must be accepted, not reported as an
      error. (This was a real bug: `assertSlug` returns the cleaned slug on success.)
- [ ] Brand list shows a product count per brand without a 500.
- [ ] Deactivate a brand; it stops appearing in public facets but its products remain.

---

## 2. Public storefront

### 2.1 Product page (`/product/[slug]`)

- [ ] Gallery renders thumbnail / main / gallery images.
- [ ] Title, brand, rating, price, discount badge, stock state all present.
- [ ] Variant selector reflects the real axes (not just size/colour).
- [ ] Selecting a variant updates price and stock.
- [ ] Quantity stepper respects available stock.
- [ ] Add to cart / Buy now / Wishlist work for a signed-in user.
- [ ] Highlights, specs, description, related products render.
- [ ] View source: `<title>`, `og:*` tags, canonical, and JSON-LD structured data are present.

### 2.2 Public API must not leak internals

This is the single most important security check in Part 11.

```bash
curl -s localhost:3000/api/products/slug/<published-slug> | python3 -m json.tool
```

- [ ] Response contains **no** `costPrice`, no admin notes, no tax rate, no search vector.
- [ ] Variants are stripped of internal fields.
- [ ] The same request signed in as ADMIN **does** include them (role-based, never a
      request parameter).
- [ ] `GET /api/products/[id]/inventory` as a guest returns stock balances but **not** the
      ledger.

### 2.3 Hidden products cannot be enumerated

- [ ] Request a `DRAFT` product's slug → **404**.
- [ ] Request a non-existent slug → **404 with an identical body**. The two must be
      indistinguishable, or unpublished slugs can be enumerated.
- [ ] `DELETE /api/products/[id]` archives; the row still exists in the database.

---

## 3. Search & discovery (Part 12)

Use the seeded corpus. Good queries: `laptop`, `shoes`, `headphones`, `camera`, `jeans`.

### 3.1 Typo tolerance and query understanding

| Query | Expected |
|---|---|
| `laptopp` | Corrected to `laptop`; banner says *"Showing results for laptop. Search instead for laptopp."* |
| `iphne pro max under 100000` | Typo corrected **and** a ≤ ₹100,000 price constraint applied |
| `laptop between 30000 and 50000` | Price band ₹30,000–₹50,000 applied |
| `nike black shoes` | Brand, colour attribute and category all recognized |
| `tee` | Synonym-expanded to t-shirt |
| `zzzzqqqq` | Zero-result recovery: suggestions offered, no crash |

- [ ] A word with **no** near neighbour in the vocabulary is **not** corrected.
- [ ] Auto-applied correction requires confidence ≥ 0.62; below that it is offered, not applied.
- [ ] An exact SKU search matches without being tokenized apart.

### 3.2 Suggestions and autocomplete (`/api/search/suggestions`)

- [ ] Typing 2+ characters in the header search box returns typed suggestions.
- [ ] Suggestions carry a `type` (product / brand / category / popular / history).
- [ ] A single character returns nothing useful (below `MIN_SUGGEST_LENGTH = 2`).
- [ ] Suggestions respond in well under 100 ms.
- [ ] Keyboard navigation and Enter-to-search work in the combobox.

### 3.3 Filters, facets, sorting, pagination

- [ ] Facet sidebar shows brands, categories, attribute axes, price buckets and rating,
      each with live counts.
- [ ] Clicking a facet updates the URL. **Every filter is reflected in the URL.**
- [ ] Reload the filtered URL — the same filtered state is restored.
- [ ] Share the URL with someone else — same results.
- [ ] Removing a facet chip clears just that filter.
- [ ] An inverted price band (`minPrice=5000&maxPrice=1000`) is normalised, not empty.
- [ ] Sort options all work: `relevance`, `popularity`, `newest`, `price-asc`,
      `price-desc`, `rating`, `discount`, `best-selling`.
- [ ] Sorting is server-side, not client-side on one page.
- [ ] Pagination uses an opaque cursor; deep pages are fast.
- [ ] No result set exceeds the page size.
- [ ] Result count is reported and stable.

URL shape, for reference:

```
/search?q=laptop&brand=<id>&category=<id>&minPrice=30000&maxPrice=50000
        &rating=4&availability=in_stock&sale=1&attr.color=black&sort=price-asc&cursor=<opaque>
```

`availability` accepts `any | in_stock | out_of_stock | on_sale`. Attribute filters are
namespaced `attr.<axis>=value1,value2`.

### 3.4 Ranking sanity

- [ ] An exact name match outranks a description-only match.
- [ ] An in-stock product outranks an otherwise identical out-of-stock one.
- [ ] With out-of-stock mode set to HIDE, out-of-stock products disappear entirely.
- [ ] The response carries a `rankingVersion` and a `tookMs` latency figure.

### 3.5 Search history and trends

- [ ] A signed-in user's repeated search is deduplicated in history (`/api/search/history`).
- [ ] History is capped at 20 entries.
- [ ] Clicking a result records a click event (`/api/search/click`) with its position.
- [ ] Recent searches appear in the combobox.

---

## 4. Admin search dashboard (`/admin/search`)

- [ ] Overview shows query volume, zero-result rate, average latency.
- [ ] Popular queries list is populated after a few searches.
- [ ] Rising / trending queries section renders.
- [ ] Zero-result queries are listed — search `zzzzqqqq` first, then reload.
- [ ] Low-click queries are listed.
- [ ] Click-position data renders without error.
- [ ] Index status shows freshness derived from the `catalog_events` outbox.
- [ ] Synonyms: create one, list it, deactivate it. A term cannot be its own synonym,
      and a duplicate pair is rejected. Batch import reports per-line errors.

---

## 5. Indexing

- [ ] Publish a new product → it becomes searchable without a manual reindex
      (the outbox feeds the index).
- [ ] Unpublish a product → it disappears from search results.
- [ ] `npm run search:index` completes on the full catalog.
- [ ] `npm run search:status` reports index counts and last-indexed time.
- [ ] `npm run search:queue` processes the pending outbox.
- [ ] Editing a price updates the searchable index.

---

## 6. Caching

- [ ] A popular product page is served from cache on the second request.
- [ ] **Changing stock at checkout never serves a stale quantity** — the inventory
      read path must not be cached.
- [ ] Creating/updating/archiving a product expires the `catalog` tag; the listing
      reflects the change on the next request.
- [ ] Creating or retiring a **variant** expires the `catalog` tag too (availability
      counts derive from `product_variants`).

---

## 7. Security and authorization

Roles are `CUSTOMER`, `SELLER`, `ADMIN`, `SUPER_ADMIN`; catalog editors are
`PRODUCT_MANAGER`, `ADMIN`, `SUPER_ADMIN`.

- [ ] `POST /api/products` as a guest → **401**.
- [ ] `POST /api/products` as a CUSTOMER → **403**.
- [ ] `POST /api/products` as ADMIN → success.
- [ ] `GET /api/admin/search/analytics` as a guest → 401/403.
- [ ] Rate limiting: hammer `/api/search` and observe **429** after the limit.
- [ ] SQL injection: search `'; DROP TABLE products; --` → no error, no data loss.
- [ ] XSS: create a product named `<script>alert(1)</script>` → rendered escaped.
- [ ] Image URLs are constrained to `/...` or `https://...` (no `javascript:`, no
      backslashes).
- [ ] Catalog writes are recorded in `audit_events` with a real actor id.

---

## 8. Performance

```bash
npm run search:loadtest
```

- [ ] Reference figures on the seeded corpus (120 products / 540 variants, concurrency 10,
      30 s, dev mode): search ≈ 40 req/s, p50 ≈ 182 ms, p95 ≈ 253 ms; autocomplete
      p50 ≈ 106 ms; 0 errors.
- [ ] If you see a wall of **429**s, you are measuring the rate limiter, not search.
      Raise the limit or set `SEARCH_LOADTEST=1` before drawing conclusions.
- [ ] No page loads the full catalog — check the Network tab for response sizes.

---

## 9. Python catalog-intelligence service

```bash
cd services/catalog-service
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn app.main:app --port 8100
```

- [ ] `GET /health` → 200.
- [ ] `POST /v1/search` returns ranked results.
- [ ] `GET /v1/suggestions` returns suggestions.
- [ ] `POST /v1/recommendations` returns recommendations.
- [ ] `GET /v1/inventory/insights` and `GET /v1/search/insights` respond.
- [ ] `POST /v1/index/refresh` responds.
- [ ] The service is **read-only** — no write path exists.
- [ ] With `CPPSEARCH_LIBRARY` unset it still ranks (lexical fallback), and says so.
- [ ] `.venv/bin/python scripts/verify_table_metadata.py` reports every table `ok`.

Config prefix is `CATALOG_SERVICE_`; env prefix wins over `.env`. See
`services/catalog-service/README.md`.

---

## 10. Regression — must not break

Part 11 and 12 were added without touching earlier modules. Confirm:

- [ ] Registration, login, logout, email verification, password reset.
- [ ] Cart add / update / remove, and cart totals.
- [ ] Wishlist add / remove.
- [ ] Checkout preparation flow.
- [ ] Account pages: profile, addresses, orders, security, notifications, settings.
- [ ] Existing category and collection pages.
- [ ] Newsletter signup.

---

## 11. End-to-end acceptance (§61)

The full lifecycle is scripted:

```bash
npm run e2e:catalog
```

Expected: **21/21 PASS** and `E2E CATALOG: all checks passed`. It walks admin-creates →
publish-checklist → published → category listing → view by id and slug → no internal-field
leak → variant with its own price → search surfaces the published product but not the
draft → a sale reduces stock → a replayed reference is a no-op → an oversell is refused →
the rollup equals the sum of variants → every balance replays from the ledger → archive
hides but keeps the row → cleanup.

Search-specific acceptance (§61) — confirm by hand:

- [ ] `iphne pro max under 100000` corrects the typo, applies the price constraint,
      returns real indexed results, ranks them, returns facets, and the click is recorded.
