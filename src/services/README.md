# Services layer

Business logic lives here, isolated from both HTTP (route handlers) and
the database. Every service is `server-only`, small, and independently
testable.

## Existing

- `newsletter.service.ts` — newsletter capture + audit log (live).

## Arriving in later milestones

```
services/
  payments/        # Razorpay (primary) + Stripe-ready provider interface
  pod/             # POD supplier client (orders, catalog sync, webhooks)
  shipping/        # rates, labels, tracking aggregation
  email/           # transactional templates + provider interface
  storage/         # S3-compatible uploads (design artwork, print files)
  orders/          # order lifecycle, refunds
  catalog/         # products, variants, designs, collections
  reviews/         # verified reviews
  coupons/         # discount engine
  notifications/   # in-app + email + whatsapp-ready
  analytics/       # event ingestion
  admin/           # back-office operations
```

Rules for every service:

1. Never read `process.env` directly in dozens of places — use `@/config/env`.
2. Throw `AppError` subclasses from `@/lib/errors` for expected failures.
3. Log via `@/lib/logger`, never `console.log`, never log secrets/PII.
4. Significant mutations append an `audit_events` row.
5. External calls have timeouts and map failures to `IntegrationError`.
