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
