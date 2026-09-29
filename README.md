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
