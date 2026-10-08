# Part 13 — Recommendation, Personalization & Discovery Intelligence

A recommendation layer built on top of the Part 11 catalog and the Part 12
search engine. It reuses both rather than forking either: candidates come from
the catalog and the precomputed search index, and behavioural signals land in
the **existing** `analytics_events` table, which was defined in Part 1 but had
no writer until now.

---

## 1. Architecture

```
                        shopper
                           │
                           ▼
                  recommendation API
                           │
             ┌─────────────┴─────────────┐
             ▼                           ▼
       user profile                 context engine
   (decayed interest weights)   (product, cart, query)
             └─────────────┬─────────────┘
                           ▼
                    candidate engine
        ┌──────────┬───────┴──────┬───────────┐
        ▼          ▼              ▼           ▼
   similarity  co-purchase   popularity   interest
        └──────────┴──────┬──────┴───────────┘
                          ▼
                    ranking engine      ← additive, component-wise
                          ▼
                    exclusion layer     ← business rules, cannot be outvoted
                          ▼
                    diversity pass      ← brand / category / seller caps
                          ▼
                     final rail
```

Two rules hold throughout:

**Candidate generation is separate from ranking.** A generator proposes ids and
a strength; it never decides the final order. That is what lets a new generator
be added without touching the ranker, and what makes "where did this come
from?" answerable after the fact.

**Expensive work is precomputed.** Similarity, co-purchase and popularity are
written by `npm run recommendations:compute` and read at request time. A page
render re-ranks; it never recomputes a similarity matrix.

---

## 2. Event stream

Part 13 extends `analytics_events` rather than adding a parallel log. Two
append-only tables describing the same shopper is two places to be wrong.

Migration `0008` adds the columns an interest aggregation needs — they were
previously passed in the `context` jsonb, but grouping by a jsonb path is not
indexable:

| Column | Purpose |
|---|---|
| `variant_id`, `category_id`, `brand_id` | the axes interest is aggregated on |
| `search_query` | the query behind a SEARCH / SEARCH_RESULT_CLICK |
| `recommendation_type`, `recommendation_request_id` | which rail an action followed |
| `source` | where in the app it fired: pdp, cart, checkout, search, home |

New enum values: `PRODUCT_CLICK`, `SEARCH_RESULT_CLICK`, `WISHLIST_REMOVE`,
`RETURN`, `SHARE`, `COMPARE`, `CATEGORY_VIEW`, `BRAND_VIEW`, `FILTER_USED`.

Recommendation impressions get their own table (`recommendation_events`) because
they carry attribution state — position, algorithm version, the request that
produced them — and arrive at a much higher volume than purchases.

Every write is fire-and-forget. A dropped signal degrades recommendations
slightly; a 500 on add-to-cart costs an order.

---

## 3. Interest profiles

`user_interest_signals` holds one row per (subject, dimension, key) with an
**undecayed** `raw_weight`. Decay is applied on read, never baked in at write
time — otherwise changing the half-life would require re-deriving every
historical row.

A subject is either a signed-in user or a salted session hash, enforced by a
check constraint: a row belonging to both would double-count, and one belonging
to neither is meaningless.

`user_interest_profiles` is the materialized, decayed snapshot the ranker
reads. It stores `decay_version` so a profile produced under an old curve is
identifiable rather than silently wrong.

Weights:

```
PURCHASE 10 · ADD_TO_CART 4 · WISHLIST_ADD 3.5 · CHECKOUT_STARTED 2
SEARCH_RESULT_CLICK 1.6 · PRODUCT_CLICK 1.4 · PRODUCT_VIEW 1
CATEGORY_VIEW / BRAND_VIEW 0.8 · COMPARE 1.2 · SHARE 1.1 · SEARCH 0.5
RETURN −4 · NOT_INTERESTED −6 · WISHLIST_REMOVE / REMOVE_FROM_CART −1.5
```

**Personalization is gated on evidence.** Below `MIN_PERSONALIZATION_CONFIDENCE`
(0.15) the engine stops pretending to personalize and serves trending instead.
A profile built from one product view should not drive a "recommended for you"
rail — the honest answer for that shopper is the trending list.

On sign-in, `mergeSessionIntoUser` folds the anonymous session's signals into
the user profile at a 0.7 discount and deletes the session rows. Without this,
everything a shopper did before logging in is discarded at exactly the moment
it becomes attributable.

---

## 4. Similarity is not complementarity

`product_similarity` is content-based: category, subcategory, brand, product
type, attributes, price and text. A phone case shares none of these with the
phone, so it scores low here and high in co-purchase — which is exactly right,
because routing a case through similarity is how a "similar products" rail ends
up full of socks.

The weight profile is **category-specific**:

| Profile | Emphasis |
|---|---|
| `electronics` | attributes 0.32 > category 0.22 > brand 0.14 |
| `apparel` | category 0.26 > brand 0.20 > attributes 0.20 |
| `default` | category 0.30 > brand 0.18 > attributes 0.18 |

Two laptops with the same CPU and RAM are near substitutes; two t-shirts with
the same colour are not. A single global weight vector cannot express that.

Text is the lowest-weighted signal deliberately — it is easy to game with
keyword stuffing and rewards verbose descriptions.

---

## 5. Co-purchase and lift

`product_co_purchases` stores support, confidence and **lift**.

Lift is the column that makes this safe to ship. Confidence alone would
recommend toilet paper alongside every product on the site, because everyone
buys toilet paper — its confidence is high everywhere. Lift divides that away:
a companion everyone buys anyway scores near 1.0 no matter how often it
appears, while a genuinely associated accessory scores well above it.

Ranking is by lift, not raw count. Ordering by count is the classic mistake
that turns "frequently bought together" into "bestsellers, again".

A minimum-support floor matters for the same reason: with enough orders, any
two products are eventually bought together once by coincidence.

**Cross-sell** reads the same table but requires the companion to be in a
*different* category. That one predicate is the whole distinction — a
co-purchased item in the same category is a substitute the shopper chose
instead.

**Upsell** requires a genuine step up: same category, price between 1.1× and
1.8×, similarity ≥ 0.45, and rating ≥ 3.5. A premium product is not an upsell
merely for being more expensive.

---

## 6. Popularity and trending are separate scores

A single combined number has a specific failure mode: a three-year-old
bestseller accumulates so much lifetime volume that it stays on top forever,
and "trending" becomes a permanent label for the same four products.

`trending_score` is momentum — recent activity against the product's **own**
baseline, not against other products. A niche product can legitimately trend
without being outsold site-wide. Smoothing prevents a doubling of two views
from reading as a trend.

Popularity is log-scaled, so a product with a million views does not make one
with a thousand invisible. Unbounded, popularity would eventually drown every
other signal — which is how a recommender quietly becomes a bestseller list.

---

## 7. Ranking

```
finalScore = relevance + userInterest + similarity + popularity
           + quality + freshness + purchaseAffinity + context
           − duplicationPenalty − outOfStockPenalty − stalePenalty
```

Additive and component-wise, so the debugger can print the breakdown and the
explanation layer can name the dominant term.

**The balance invariant.** Soft signals (popularity + quality + freshness) must
stay below contextual signals (relevance + userInterest + similarity +
context). `assertWeightBalance` enforces this on load, on save, and in tests.
Violate it and every rail converges on the same popular items regardless of
what the shopper is looking at.

Per-type overrides exist because one weight vector for every slot is wrong in a
visible way: a cross-sell rail scored like a similarity rail recommends a second
phone instead of a case.

---

## 8. Exclusions cannot be outvoted

Business rules run **after** ranking, as a filter, not as a score component. A
rule buried inside a score is a rule that can be outvoted: give an out-of-stock
product a large enough relevance score and it wins, and the shopper gets a card
they cannot buy. The same applies to restricted categories — "scored too well
to hide" is exactly the failure worth designing out.

Every rule returns a reason, so the debugger can say why an item was dropped.

Seller share is capped (§56) but the cap is a ceiling, not a quota: it never
promotes a less relevant item above a more relevant one from another seller, it
only defers the excess — and deferred items still fill the rail if nothing
better exists.

---

## 9. Failure never propagates

```
primary strategy  →  category popularity  →  global popularity  →  empty rail
```

A recommendation rail is a nice-to-have; the page it sits on is not. Every
stage is individually caught, and a rail with no candidates renders nothing
rather than an empty heading — an empty rail reads as a bug.

---

## 10. APIs

| Endpoint | Purpose |
|---|---|
| `GET /api/recommendations` | one rail. `type`, `productId`, `categoryId`, `limit`, `cart`, `exclude` |
| `GET /api/recommendations/home` | five rails in one request (§35) |
| `POST /api/recommendations/events` | `kind=impression \| action \| behavioral` |
| `GET /api/admin/recommendations/analytics` | dashboard payload |
| `GET /api/admin/recommendations/debug` | candidate trace, similarity breakdown |

Type aliases are accepted: `similar`, `related`, `frequently-bought`,
`also-bought`, `also-viewed`, `trending`, `for-you`, `cart`, `cross-sell`,
`upsell`, `post-purchase`, `recently-viewed`, `continue-shopping`.

**A `userId` parameter is deliberately not accepted.** Identity comes from the
session only — accepting it from the query string would let anyone request
another shopper's personalized rail.

Responses carry `recommendationId`, which the client must echo on impression
and click events. Without it there is no attribution, and the dashboard can
report impressions but never conversions.

---

## 11. Frontend

`<RecommendationRail />` serves every slot; the named components in §64 are
thin wrappers that fix the `type` and default heading, so a page reads
`<CrossSellRail productId={...} />` rather than a string literal a typo could
silently turn into a different rail.

No product data is passed in — the rail fetches its own, which keeps the
"no hard-coded product arrays" rule structurally true.

Two behaviours worth knowing:

- **Deferred fetch.** The request fires when the rail is within 400px of the
  viewport, not on mount. A product page carries three rails; requesting all
  three during initial paint would compete with the content the shopper came
  for.
- **Impressions on real visibility**, at 50% threshold. Reporting an impression
  for a rail nobody scrolled to would inflate every denominator in the
  dashboard and understate CTR.

Rails are `cache: "no-store"` — the response is personalized, so a shared cache
would serve one shopper's rail to another.

Wired into the product page alongside the existing structural
`<RelatedProducts />`, which is kept rather than replaced: it ranks by shared
collection and tags, so it is the only rail with something to say before the
offline job has run.

---

## 12. Offline jobs

```bash
npm run recommendations:compute                      # everything
npm run recommendations:compute -- --only similarity
npm run recommendations:compute -- --only co-purchase
npm run recommendations:compute -- --only popularity
npm run recommendations:compute -- --only profiles
npm run recommendations:compute -- --only metrics
npm run recommendations:compute -- --coverage        # report table coverage
```

Options: `--batch-size <n>`, `--window-days <n>`, `--limit <n>`.

### Acceptance run

```bash
npm run e2e:recommendations
```

Walks the §78 scenario end to end against a disposable database: a shopper
searches, views, filters, wishlists and buys a gaming laptop; the profile must
reflect it. Other shoppers buy the same laptop alongside a mouse, and a
co-purchase relationship must emerge with lift above 1. A product page must
surface similar items *and* frequently-bought accessories — and must not offer
an accessory as a "similar product". A product that suddenly gets attention
must surface as trending. 29 checks.

The co-purchase fixture deliberately includes orders that do **not** contain
the mouse. With every product in every order the mouse's base rate is 1.0, so
lift is exactly 1.0 and no association is detectable — a degenerate fixture
rather than a code failure. The filler orders are what make the test mean
something.

Every stage is idempotent and independently retryable. A stage that fails is
reported and the run exits non-zero, but the others still complete — a cron job
that aborts on the first error never catches up.

Retention pruning runs as part of the batch rather than as its own cron entry,
because a table that grows without bound is a problem the same job that fills
it should prevent.

---

## 13. The dashboard's most important number is not CTR

`/admin/recommendations` leads with **coverage** and **fallback rate**.

A rail can show a healthy CTR while quietly serving the global-popularity
fallback for most requests, because the fallback still returns plausible
products. Coverage falling is the early warning that the offline job has
stopped running; CTR falling is the late one.

---

## 14. Debugger

```
GET /api/admin/recommendations/debug?view=trace&type=cross-sell&productId=<id>
```

Views: `trace`, `similarity`, `requests`, `impressions`, `coverage`.

A trace re-runs the real pipeline rather than replaying a stored result,
because the question is normally "what would happen now". Nothing is persisted,
so debugging cannot pollute the metrics it is explaining.

It exposes score breakdowns and exclusion reasons — precisely the internals the
public response keeps out, which is why it sits behind the catalog-editor
check.

---

## 15. ML-ready seam

`RecommendationModel` (in `src/lib/recommendations/types.ts`) separates
`generateCandidates`, `scoreCandidates`, `rankCandidates` and
`explainRecommendation`. They are separate methods rather than one
`recommend()` because a hybrid system typically keeps rule-based candidate
generation while swapping the scorer — collapsing them would force replacing
both at once.

No learned model is implemented, and none is stubbed out to look like one.

---

## 16. Environment variables

No new required variables. The engine reads `DATABASE_URL` and reuses
`SEARCH_SESSION_SALT` for the salted anonymous session hash.

---

## 17. Known limitations

- **Co-view has no dedicated table.** `CUSTOMER_ALSO_VIEWED` currently
  approximates from similarity plus popularity. View-pair volume would justify
  its own table; until then the label overstates what is computed.
- **Regional popularity is not implemented.** `popularity_scope` has
  `GLOBAL`, `CATEGORY` and `BRAND`. There is no region signal in the catalog to
  scope on yet.
- **Replenishment prediction computes but notifies nothing.** §33 asked for the
  foundation. `predictReplenishment` returns due dates from median purchase
  intervals; no email or push is sent, because a "time to rebuy" message off a
  median of two data points is the kind of confident wrong that gets
  recommendations ignored.
- **Collaborative filtering is data-ready, not implemented.** The interaction
  tables exist and are populated. `collaborativeFiltering` is a feature flag
  that defaults to off.
- **Similarity is computed within a category.** Cross-category similarity is
  almost always noise, so it is skipped — but that means a product in a
  singleton category has no similarity rows at all and falls back to the
  content floor.
