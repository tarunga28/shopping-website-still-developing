# Architecture

Foundation milestone (v0.1.0). This document is the map every later part
follows so the platform grows **without restructuring**.

## Module map

```
src/
  app/                      # Routes (App Router)
    api/
      health/route.ts       # Liveness + readiness probe (DB check)
      newsletter/route.ts   # POST — validated, rate-limited signup
    legal/<policy>/page.tsx # Privacy / Terms / Shipping / Refunds
    layout.tsx              # Fonts, metadata architecture, header/footer
    page.tsx                # Home — composes data-driven sections
    error.tsx               # Segment error boundary (safe copy + digest)
    global-error.tsx        # Root-level fallback (self-contained)
    not-found.tsx           # Branded 404
    loading.tsx             # Route loading shell
    robots.ts sitemap.ts manifest.ts icon.svg
  components/
    ui/                     # Design system (see below)
    layout/                 # Header, footer, mobile nav, search, dialogs
    home/                   # Homepage sections (data-driven, DB-ready)
    legal/                  # Shared policy page layout
    providers.tsx           # Client providers (toast, motion prefs)
  config/
    site.ts                 # Brand, commerce, contact, social, flags, nav
    env.ts                  # Validated server env (zod, grouped, lazy)
    legal-content.ts        # Policy copy as data
  db/
    index.ts                # Pooled Drizzle client (schema-bound)
    schema.ts               # Foundation tables + future domain home
  services/
    newsletter.service.ts   # First vertical slice of the service pattern
    README.md               # Where each future domain service lives
  lib/
    api-client.ts           # Typed browser fetch wrapper
    api-response.ts         # Uniform { ok, data | error } contract
    errors.ts               # AppError taxonomy + safe public mapping
    format.ts               # Money (paise), dates — Intl-based
    logger.ts               # Structured server logging (no secrets/PII)
    placeholder-data.ts     # SAMPLE catalogue (swapped for DB later)
    rate-limit.ts           # RateLimiter interface + in-memory backend
    seo.ts                  # buildMetadata, canonicals, OG/Twitter
    utils.ts                # cn(), misc pure helpers
  validations/              # Zod schemas per domain (newsletter first)
  hooks/                    # Client hooks (useHotkey …)
  types/                    # Shared domain-lean types
tests/
  unit/ components/         # Vitest suites
docs/ARCHITECTURE.md        # This file
src/proxy.ts                # Edge proxy: request IDs + auth-gating seams
```

## Design system inventory (`components/ui`)

Button, Input, Label, Select, Checkbox, RadioGroup, Dialog (Modal),
Drawer, DropdownMenu, Tabs, Card, Badge, Alert, Spinner, Skeleton,
Pagination, Price, ProductCard, ImageGallery, SocialIcons, Toaster.

Conventions: cva-driven variants, Radix primitives for interaction,
`cn()` for class composition, semantic tokens only (paper/cream/sand/
clay/ink/smoke/flame), focus rings via `outline-flame`.

## Data & business rules

- **Money** is integer paise; format only at the edge (`formatPrice`).
- **Planned schema** (later milestones, always via drizzle-kit
  migrations): users/roles, products/variants/designs, categories/
  collections, images, carts/items, wishlists, orders/items, payments,
  refunds, addresses, shipments/tracking, pod_orders/pod_events, coupons,
  reviews, notifications, support_tickets, analytics, audit_logs.
  Foundation already ships `newsletter_subscribers` + `audit_events`.
- **Service layer pattern:** route → service → db. Routes never contain
  business logic; services never see `Request` objects.

## Security posture

- Secrets server-only (`server-only` package + env groups).
- Security headers + CSP centralized in `next.config.ts`.
- `proxy.ts` adds `x-request-id` and defines the auth-gating seams.
- All public inputs validated with Zod; honeypot + rate limiting on the
  newsletter form; salted IP hashing at rest.
- Errors: customer-safe messages via `AppError`; internals logged
  structured, never exposed.

## Catalog REST API (Part 11)

The catalog is reachable two ways: the pre-existing `/api/catalog/*` and
`/api/admin/catalog/*` routes (used by the storefront and the admin server
actions), and the REST surface below. They share the same services, so there is
one implementation of every rule and two shapes of URL.

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/products` | public | Paginated listing, `PublicProductDTO` only |
| `POST /api/products` | editor | Create (lands as `DRAFT`) |
| `GET /api/products/:id` | public¹ | Public projection, or the admin shape for an editor |
| `PUT /api/products/:id` | editor | Full update |
| `DELETE /api/products/:id` | editor | **Archives**; never hard-deletes |
| `GET /api/products/slug/:slug` | public | Slug lookup for SEO URLs |
| `GET /api/products/:id/variants` | public¹ | Variants; cost price stripped publicly |
| `POST /api/products/:id/variants` | editor | Create variant + opening `STOCK_IN` ledger row |
| `GET /api/products/:id/inventory` | public¹ | Stock balances; the ledger is editor-only |
| `POST /api/products/:id/inventory` | editor | One ledger movement, transactional |
| `GET /api/categories` | public | Category tree |
| `POST /api/categories` | editor | Create; `path` is server-derived and returned |
| `PUT /api/categories/:id` | editor | Update, recomputing the subtree paths |
| `DELETE /api/categories/:id` | editor | Archive; `?reassignTo=` moves live products first |
| `GET /api/brands` | public | Active brands; `includeInactive` honoured for editors |
| `POST /api/brands` | editor | Create |

¹ Reads on a shared path branch on the **session role**, never on a request
parameter. A client cannot ask for the admin shape; there is no flag to send.

### Two invariants worth knowing before changing these

**Public responses are explicit allow-lists.** `getProductByIdPublic`,
`getProductBySlugPublic` and the variants route build a new object from named
fields rather than deleting keys from a row. A column added to `products` or
`product_variants` therefore cannot reach a public response by default — it has
to be added on purpose. Cost price, admin notes, tax rate, the search vector and
the inventory ledger are the fields this protects.

**`DELETE` archives.** Products are referenced by orders, reviews, carts and
wishlists, and categories by their own descendants; a hard delete would either
fail on a foreign key or orphan real history. Archiving keeps every reference
resolvable and takes the item off the storefront, which is what "delete" means
operationally. `tests/integration/catalog-rest-api.test.ts` asserts the row
survives with `status = 'ARCHIVED'`.

### Errors

Routes use the `{ ok, data | error }` envelope from `lib/api-response.ts`
(`apiOk` / `apiFail`) and are wrapped in `withErrorHandling`. Note this is a
different envelope from the public catalog's `catalogApiResponse` — do not mix
them. Statuses: `401` unauthenticated, `403` authenticated but not an editor,
`404` missing or not publicly visible, `422` validation, `429` rate-limited.

A missing product and a hidden product return the **same** 404 body. Distinguishing
them would let anyone enumerate unpublished slugs.

## Milestone seams (where future parts plug in)

| Part            | Plug point                                              |
| --------------- | ------------------------------------------------------- |
| Auth            | `proxy.ts` prefix gates + `config/env.ts` auth group    |
| Catalog         | `lib/placeholder-data.ts` → DB queries, same components |
| Cart/Checkout   | header dialogs → real routes; `services/orders`         |
| Razorpay        | `services/payments` + env group + webhook route         |
| POD supplier    | `services/pod` client + `pod_orders`/`pod_events` table |
| Media storage   | `services/storage` (S3-compatible)                      |
| Analytics/Email | env groups already reserved                             |
