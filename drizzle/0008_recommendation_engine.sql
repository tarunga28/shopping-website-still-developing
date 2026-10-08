-- Part 13: recommendation, personalization & discovery intelligence engine.
--
-- Adds the tables the recommender needs on top of Parts 11 and 12:
--
--   recommendation_requests   one row per API call — the attribution join point
--   recommendation_events     impression -> click -> cart -> purchase
--   user_interest_signals     raw weighted signals per (subject, dimension, key)
--   user_interest_profiles    decayed snapshot the ranking engine reads
--   product_similarity        precomputed content-based similarity
--   product_co_purchases      co-occurrence with support / confidence / lift
--   product_popularity        scoped popularity + momentum, kept separate
--   recommendation_configs    versioned weights and policy per type
--   recommendation_experiments A/B slots
--   recommendation_metrics    daily rollups per type
--
-- It also extends the *existing* behavioural event enum rather than forking a
-- second event stream: the storefront already records behaviour, and the
-- recommender is one more consumer of it.
--
-- Idempotent: safe to re-run, and matches `drizzle-kit push` output.
-- Every statement is additive — no existing column is dropped or retyped, so
-- Parts 1–12 keep working against the same rows.

-- ── Enums ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE recommendation_type AS ENUM (
    'SIMILAR_PRODUCTS', 'RELATED_PRODUCTS', 'FREQUENTLY_BOUGHT_TOGETHER',
    'CUSTOMER_ALSO_BOUGHT', 'CUSTOMER_ALSO_VIEWED', 'TRENDING_PRODUCTS',
    'POPULAR_IN_CATEGORY', 'RECENTLY_VIEWED', 'CONTINUE_SHOPPING',
    'PERSONALIZED_FOR_YOU', 'CART_RECOMMENDATIONS', 'CHECKOUT_RECOMMENDATIONS',
    'POST_PURCHASE_RECOMMENDATIONS', 'CROSS_SELL', 'UPSELL',
    'NEW_USER_RECOMMENDATIONS', 'ANONYMOUS_RECOMMENDATIONS'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE recommendation_event_type AS ENUM (
    'SHOWN', 'CLICKED', 'ADDED_TO_CART', 'PURCHASED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE interest_dimension AS ENUM (
    'CATEGORY', 'BRAND', 'PRODUCT', 'ATTRIBUTE', 'PRICE_BAND', 'PRODUCT_TYPE'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE popularity_scope AS ENUM ('GLOBAL', 'CATEGORY', 'BRAND');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Extend the existing behavioural enum. One append-only event stream is cheaper
-- to reason about than two, and these are behaviours the recommender needs
-- that the storefront did not previously record.
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'PRODUCT_CLICK';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'SEARCH_RESULT_CLICK';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'WISHLIST_REMOVE';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'RETURN';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'SHARE';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'COMPARE';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'CATEGORY_VIEW';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'BRAND_VIEW';
ALTER TYPE analytics_event_type ADD VALUE IF NOT EXISTS 'FILTER_USED';

-- ── Part 13 columns on analytics_events ──────────────────────────────────
-- The table already existed and nothing wrote to it. These are the fields a
-- recommender needs that its original shape did not carry: which variant, in
-- which category, from which brand, under which recommendation request.
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS variant_id uuid;
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS category_id uuid;
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS brand_id uuid;
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS search_query text;
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS recommendation_type recommendation_type;
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS recommendation_request_id uuid;
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS source text;

-- Interest aggregation groups by subject and recency, so it needs an index
-- that leads with the subject rather than the event type.
CREATE INDEX IF NOT EXISTS analytics_events_user_created_idx
  ON analytics_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS analytics_events_session_created_idx
  ON analytics_events (session_id, created_at DESC);

DO $$ BEGIN
  ALTER TABLE analytics_events
    ADD CONSTRAINT analytics_events_variant_id_product_variants_id_fk
    FOREIGN KEY (variant_id) REFERENCES product_variants (id) ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE analytics_events
    ADD CONSTRAINT analytics_events_category_id_categories_id_fk
    FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE analytics_events
    ADD CONSTRAINT analytics_events_brand_id_brands_id_fk
    FOREIGN KEY (brand_id) REFERENCES brands (id) ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Recommendation requests ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recommendation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id text NOT NULL,
  recommendation_type recommendation_type NOT NULL,
  user_id uuid,
  session_hash text,
  context_product_id uuid,
  context_category_id uuid,
  algorithm_version text NOT NULL,
  experiment_variant text,
  candidate_count integer NOT NULL DEFAULT 0,
  result_count integer NOT NULL DEFAULT 0,
  took_ms integer,
  cache_status text NOT NULL DEFAULT 'MISS',
  fallback_used boolean NOT NULL DEFAULT false,
  fallback_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recommendation_requests_candidate_count_non_negative CHECK (candidate_count >= 0),
  CONSTRAINT recommendation_requests_result_count_non_negative CHECK (result_count >= 0),
  -- A result can never exceed the candidate pool it was drawn from.
  CONSTRAINT recommendation_requests_result_within_candidates CHECK (result_count <= candidate_count),
  CONSTRAINT recommendation_requests_user_id_users_id_fk
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE set null,
  CONSTRAINT recommendation_requests_context_product_id_products_id_fk
    FOREIGN KEY (context_product_id) REFERENCES products (id) ON DELETE set null,
  CONSTRAINT recommendation_requests_context_category_id_categories_id_fk
    FOREIGN KEY (context_category_id) REFERENCES categories (id) ON DELETE set null
);

CREATE UNIQUE INDEX IF NOT EXISTS recommendation_requests_recommendation_id_key
  ON recommendation_requests (recommendation_id);
CREATE INDEX IF NOT EXISTS recommendation_requests_type_time_idx
  ON recommendation_requests (recommendation_type, created_at DESC);
CREATE INDEX IF NOT EXISTS recommendation_requests_user_idx
  ON recommendation_requests (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS recommendation_requests_session_idx
  ON recommendation_requests (session_hash, created_at DESC);

-- ── Recommendation events ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recommendation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type recommendation_event_type NOT NULL,
  recommendation_type recommendation_type NOT NULL,
  attributed_request_id uuid,
  recommendation_id text,
  product_id uuid,
  variant_id uuid,
  position integer,
  algorithm_version text,
  user_id uuid,
  session_hash text,
  revenue_paise integer NOT NULL DEFAULT 0,
  order_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recommendation_events_position_positive CHECK (position IS NULL OR position >= 1),
  CONSTRAINT recommendation_events_attributed_request_id_recommendation_requests_id_fk
    FOREIGN KEY (attributed_request_id) REFERENCES recommendation_requests (id) ON DELETE set null,
  CONSTRAINT recommendation_events_product_id_products_id_fk
    FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE cascade,
  CONSTRAINT recommendation_events_variant_id_product_variants_id_fk
    FOREIGN KEY (variant_id) REFERENCES product_variants (id) ON DELETE set null,
  CONSTRAINT recommendation_events_user_id_users_id_fk
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE set null,
  CONSTRAINT recommendation_events_order_id_orders_id_fk
    FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE set null
);

CREATE INDEX IF NOT EXISTS recommendation_events_type_time_idx
  ON recommendation_events (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS recommendation_events_request_idx
  ON recommendation_events (attributed_request_id);
CREATE INDEX IF NOT EXISTS recommendation_events_product_idx
  ON recommendation_events (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS recommendation_events_rec_type_time_idx
  ON recommendation_events (recommendation_type, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS recommendation_events_attribution_idx
  ON recommendation_events (product_id, event_type, created_at DESC);

-- ── User interest signals ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_interest_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  session_hash text,
  dimension interest_dimension NOT NULL,
  key text NOT NULL,
  raw_weight real NOT NULL DEFAULT 0,
  event_count integer NOT NULL DEFAULT 0,
  strongest_event text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_interest_signals_event_count_non_negative CHECK (event_count >= 0),
  CONSTRAINT user_interest_signals_raw_weight_non_negative CHECK (raw_weight >= 0),
  -- Exactly one subject: both null is an orphan, both set is a double count.
  CONSTRAINT user_interest_signals_exactly_one_subject
    CHECK ((user_id IS NULL) <> (session_hash IS NULL)),
  CONSTRAINT user_interest_signals_user_id_users_id_fk
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE cascade
);

CREATE UNIQUE INDEX IF NOT EXISTS user_interest_signals_subject_key
  ON user_interest_signals (user_id, session_hash, dimension, key);
CREATE INDEX IF NOT EXISTS user_interest_signals_user_weight_idx
  ON user_interest_signals (user_id, raw_weight DESC);
CREATE INDEX IF NOT EXISTS user_interest_signals_session_weight_idx
  ON user_interest_signals (session_hash, raw_weight DESC);
CREATE INDEX IF NOT EXISTS user_interest_signals_dimension_idx
  ON user_interest_signals (dimension, key);

-- ── User interest profiles ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_interest_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  session_hash text,
  interests jsonb NOT NULL DEFAULT '{}'::jsonb,
  price_preference jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence real NOT NULL DEFAULT 0,
  signal_count integer NOT NULL DEFAULT 0,
  decay_version text NOT NULL DEFAULT 'exponential-v1',
  computed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_interest_profiles_confidence_range CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT user_interest_profiles_signal_count_non_negative CHECK (signal_count >= 0),
  CONSTRAINT user_interest_profiles_exactly_one_subject
    CHECK ((user_id IS NULL) <> (session_hash IS NULL)),
  CONSTRAINT user_interest_profiles_user_id_users_id_fk
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE cascade
);

CREATE UNIQUE INDEX IF NOT EXISTS user_interest_profiles_user_key
  ON user_interest_profiles (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS user_interest_profiles_session_key
  ON user_interest_profiles (session_hash);
CREATE INDEX IF NOT EXISTS user_interest_profiles_computed_idx
  ON user_interest_profiles (computed_at DESC);

-- ── Product similarity (precomputed) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_similarity (
  product_id uuid NOT NULL,
  similar_product_id uuid NOT NULL,
  score real NOT NULL DEFAULT 0,
  algorithm text NOT NULL DEFAULT 'content-v1',
  sources jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_similarity_product_id_similar_product_id_pk
    PRIMARY KEY (product_id, similar_product_id),
  CONSTRAINT product_similarity_not_self CHECK (product_id != similar_product_id),
  CONSTRAINT product_similarity_score_range CHECK (score >= 0 AND score <= 1),
  CONSTRAINT product_similarity_product_id_products_id_fk
    FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE cascade,
  CONSTRAINT product_similarity_similar_product_id_products_id_fk
    FOREIGN KEY (similar_product_id) REFERENCES products (id) ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS product_similarity_lookup_idx
  ON product_similarity (product_id, score DESC);
CREATE INDEX IF NOT EXISTS product_similarity_reverse_idx
  ON product_similarity (similar_product_id);

-- ── Co-purchase (precomputed) ────────────────────────────────────────────
-- `lift` is the column that makes this trustworthy: it is confidence divided
-- by how often the companion is bought anyway, so a genuinely associated item
-- scores high and a merely popular one scores near 1.
CREATE TABLE IF NOT EXISTS product_co_purchases (
  product_id uuid NOT NULL,
  co_product_id uuid NOT NULL,
  order_count integer NOT NULL DEFAULT 0,
  support real NOT NULL DEFAULT 0,
  confidence real NOT NULL DEFAULT 0,
  lift real NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_co_purchases_product_id_co_product_id_pk
    PRIMARY KEY (product_id, co_product_id),
  CONSTRAINT product_co_purchases_not_self CHECK (product_id != co_product_id),
  CONSTRAINT product_co_purchases_order_count_positive CHECK (order_count >= 1),
  CONSTRAINT product_co_purchases_support_range CHECK (support >= 0 AND support <= 1),
  CONSTRAINT product_co_purchases_confidence_range CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT product_co_purchases_lift_non_negative CHECK (lift >= 0),
  CONSTRAINT product_co_purchases_product_id_products_id_fk
    FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE cascade,
  CONSTRAINT product_co_purchases_co_product_id_products_id_fk
    FOREIGN KEY (co_product_id) REFERENCES products (id) ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS product_co_purchases_lookup_idx
  ON product_co_purchases (product_id, lift DESC);
CREATE INDEX IF NOT EXISTS product_co_purchases_confidence_idx
  ON product_co_purchases (product_id, confidence DESC);

-- ── Popularity & trending (precomputed) ──────────────────────────────────
-- `score` is lifetime-weighted and `trending_score` is momentum. Keeping them
-- apart is what stops a three-year-old bestseller from being permanently
-- labelled "trending".
CREATE TABLE IF NOT EXISTS product_popularity (
  product_id uuid NOT NULL,
  scope popularity_scope NOT NULL DEFAULT 'GLOBAL',
  -- Empty string for GLOBAL, so the primary key stays non-nullable.
  scope_id text NOT NULL DEFAULT '',
  view_count integer NOT NULL DEFAULT 0,
  add_to_cart_count integer NOT NULL DEFAULT 0,
  wishlist_count integer NOT NULL DEFAULT 0,
  purchase_count integer NOT NULL DEFAULT 0,
  revenue_paise integer NOT NULL DEFAULT 0,
  score real NOT NULL DEFAULT 0,
  trending_score real NOT NULL DEFAULT 0,
  conversion_rate real NOT NULL DEFAULT 0,
  window_days integer NOT NULL DEFAULT 30,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_popularity_product_id_scope_scope_id_pk
    PRIMARY KEY (product_id, scope, scope_id),
  CONSTRAINT product_popularity_view_count_non_negative CHECK (view_count >= 0),
  CONSTRAINT product_popularity_purchase_count_non_negative CHECK (purchase_count >= 0),
  CONSTRAINT product_popularity_score_non_negative CHECK (score >= 0),
  CONSTRAINT product_popularity_conversion_rate_range
    CHECK (conversion_rate >= 0 AND conversion_rate <= 1),
  CONSTRAINT product_popularity_window_days_positive CHECK (window_days >= 1),
  CONSTRAINT product_popularity_product_id_products_id_fk
    FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS product_popularity_scope_score_idx
  ON product_popularity (scope, scope_id, score DESC);
CREATE INDEX IF NOT EXISTS product_popularity_trending_idx
  ON product_popularity (scope, scope_id, trending_score DESC);

-- ── Configuration, experiments, metrics ──────────────────────────────────
CREATE TABLE IF NOT EXISTS recommendation_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_type recommendation_type NOT NULL,
  version text NOT NULL,
  label text NOT NULL DEFAULT 'Default',
  weights jsonb NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS recommendation_configs_type_version_key
  ON recommendation_configs (recommendation_type, version);
-- One active config per type, so a rollback is "activate the previous version".
CREATE UNIQUE INDEX IF NOT EXISTS recommendation_configs_single_active_key
  ON recommendation_configs (recommendation_type, is_active) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS recommendation_experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  name text NOT NULL,
  recommendation_type recommendation_type NOT NULL,
  variants jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT false,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS recommendation_experiments_key_active_key
  ON recommendation_experiments (key) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS recommendation_experiments_type_idx
  ON recommendation_experiments (recommendation_type);

CREATE TABLE IF NOT EXISTS recommendation_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_date date NOT NULL,
  recommendation_type recommendation_type NOT NULL,
  algorithm_version text NOT NULL DEFAULT '',
  impressions integer NOT NULL DEFAULT 0,
  clicks integer NOT NULL DEFAULT 0,
  add_to_carts integer NOT NULL DEFAULT 0,
  purchases integer NOT NULL DEFAULT 0,
  revenue_paise integer NOT NULL DEFAULT 0,
  ctr real NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recommendation_metrics_impressions_non_negative CHECK (impressions >= 0),
  -- A click without an impression is a tracking bug, not a metric.
  CONSTRAINT recommendation_metrics_clicks_within_impressions CHECK (clicks <= impressions),
  CONSTRAINT recommendation_metrics_ctr_range CHECK (ctr >= 0 AND ctr <= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS recommendation_metrics_bucket_key
  ON recommendation_metrics (bucket_date, recommendation_type, algorithm_version);
CREATE INDEX IF NOT EXISTS recommendation_metrics_type_date_idx
  ON recommendation_metrics (recommendation_type, bucket_date DESC);
