# Inkline — Wear Your Creativity.

Production-grade foundation for a print-on-demand e-commerce business,
India-first. Original artwork printed on premium apparel, drinkware and
prints — made only after the customer orders.

## Stack

| Layer        | Choice                                                            |
| ------------ | ----------------------------------------------------------------- |
| Framework    | Next.js 16 (App Router, RSC-first)                                |
| Language     | TypeScript (strict mode)                                          |
| Styling      | Tailwind CSS v4 + design tokens                                   |
| UI           | Custom design system on Radix primitives (a11y-first)             |
| Database     | PostgreSQL via Drizzle ORM (migration-first, `drizzle-kit`)       |
| Validation   | Zod (API + forms + environment)                                   |
| Auth         | Prepared (edge `proxy.ts` gating seams + env groups)              |
| Payments     | Razorpay-ready env/service seams (India), Stripe-ready interface  |
| POD          | Supplier-agnostic service seam (`services/pod/`)                  |
| Testing      | Vitest + Testing Library                                          |

> **ORM note:** the data layer uses Drizzle ORM (the provisioned database
> toolkit for this project) with `drizzle-kit` migrations. The Prisma-style
> workflow the project plan calls for — schema file, typed client,
> migration files, push/inspect commands — maps 1:1; services are written
> so an ORM swap stays possible behind the service layer.

## Quick start

```bash
cp .env.example .env     # fill DATABASE_URL (and future secrets)
npm install
npx drizzle-kit push     # apply schema to your local Postgres
npm run dev              # http://localhost:3000
```

## Commands

| Command              | Purpose                                  |
| -------------------- | ---------------------------------------- |
| `npm run dev`        | Development server                       |
| `npm run build`      | Production build                         |
| `npm run start`      | Production server                        |
| `npm run lint`       | ESLint                                   |
| `npm run typecheck`  | Strict TS check                          |
| `npm run test`       | Unit/component test suite                |
| `npm run db:push`    | Apply schema to the database             |
| `npm run db:generate`| Generate a SQL migration from schema     |
| `npm run db:seed`    | Idempotent development seed data         |
| `npm run db:verify`  | Database integrity verification suite    |
| `npm run db:studio`  | Inspect the database in a browser        |

## Database

PostgreSQL via Drizzle ORM — 41 tables across 8 domains (users, catalog,
commerce, orders, POD, engagement, support, system) in
`src/db/schema/`. Conventions: UUID PKs, integer minor-unit money with
CHECK constraints, snake_case columns, snapshot semantics for orders,
supplier IDs stored separately from internal IDs, append-only POD event
log with idempotency keys. `npm run db:verify` asserts the contract
(uniques, checks, cascades, idempotency, rollback) without mutating data.

See `docs/ARCHITECTURE.md` for the module map, conventions and the
milestone seam points for auth, catalog, cart, payments and POD.

Further docs: `docs/SEARCH.md` (search, discovery and relevance),
`docs/RECOMMENDATIONS.md` (recommendation, personalization and discovery
intelligence), `docs/MANUAL-TESTING.md` (hands-on checklist for the catalog and
search engines), `docs/DESIGN_SYSTEM.md`, and
`services/catalog-service/README.md` (the Python intelligence service).

## Catalog browsing (Shop, Category, Collection)

`/shop`, `/category/[slug]` and `/collection/[slug]` are server-rendered from
`src/services/catalog/` (visibility rules in `visibility.ts`, queries in
`public-catalog.service.ts`, tagged caching in `cached.ts`, page loader in
`listing.service.ts`). The URL is the only filter/sort/page state; params are
parsed and validated in `src/lib/catalog/params.ts`. Every admin catalog write
expires the `catalog` cache tag (`invalidateCatalogCache`). Migration
`drizzle/0004_catalog_browsing.sql` adds the browsing indexes and slug-history
tables.

Public API: `GET /api/products`, `/api/categories`, `/api/collections`
(`{ data, pagination }`, rate limited, validated params).

### Database integration tests

`tests/integration` needs a disposable PostgreSQL database with the schema
applied. It is skipped unless `TEST_DATABASE_URL` is set:

```bash
DATABASE_URL=$TEST_DATABASE_URL npm run db:push
TEST_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/inkline_test npm test
```

Fixtures use a unique prefix and are deleted afterwards.
