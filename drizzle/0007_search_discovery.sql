-- Part 12: advanced search, discovery & relevance engine.
--
-- Adds the tables Part 12 genuinely needs on top of the Part 11 search
-- foundation (product_search_index, search_query_logs, search_suggestions,
-- search_synonyms):
--
--   search_vocabulary      the dictionary typo correction may correct *to*
--   search_history         per-user recent searches (upserted, bounded)
--   search_events          clicks / add-to-cart / purchase after a search
--   search_ranking_configs versioned, balance-checked ranking weight sets
--   search_experiments     A/B slots for ranking changes
--   search_settings        runtime tunables (candidate limit, autocorrect, ...)
--
-- Plus the Part 12 columns on search_query_logs (correction + ranking
-- provenance, so an analytics row is reproducible) and the facet / rating /
-- recency indexes on product_search_index.
--
-- Idempotent: safe to re-run, and matches `drizzle-kit push` output.
-- Every statement is additive — no existing column is dropped or retyped, so
-- Parts 1–11 keep working against the same rows.

-- ── Spell-correction vocabulary ────────────────────────────────────────────
-- A query is only ever corrected to a term that actually exists in the
-- catalog, so "iphne" becomes "iphone" because "iphone" is a real brand here —
-- not because a distance function thought it was close. One row per *term*,
-- which is what a correction lookup needs and is far smaller to scan than the
-- one-row-per-product search index.
CREATE TABLE IF NOT EXISTS search_vocabulary (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term text NOT NULL,
  source text NOT NULL DEFAULT 'PRODUCT',
  document_count integer NOT NULL DEFAULT 1,
  brand_id uuid,
  category_id uuid,
  trigram_text text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_vocabulary_document_count_positive CHECK (document_count >= 1),
  CONSTRAINT search_vocabulary_term_not_empty CHECK (length(term) > 0),
  CONSTRAINT search_vocabulary_brand_id_brands_id_fk
    FOREIGN KEY (brand_id) REFERENCES brands (id) ON DELETE cascade,
  CONSTRAINT search_vocabulary_category_id_categories_id_fk
    FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE cascade
);

-- A term from two sources is still one vocabulary entry; `source` records the
-- strongest one.
CREATE UNIQUE INDEX IF NOT EXISTS search_vocabulary_term_key ON search_vocabulary (term);
CREATE INDEX IF NOT EXISTS search_vocabulary_trigram_idx
  ON search_vocabulary USING gin (trigram_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS search_vocabulary_source_idx
  ON search_vocabulary (source, document_count DESC);

-- ── Search history (authenticated users only) ──────────────────────────────
-- Unique per (user, normalized query) and upserted, so searching "nike shoes"
-- forty times produces one row with search_count = 40 rather than forty rows.
-- That is both the right privacy posture and the reason the table cannot grow
-- without bound. Anonymous visitors keep history in the browser only.
CREATE TABLE IF NOT EXISTS search_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  raw_query text NOT NULL,
  normalized_query text NOT NULL,
  result_count integer NOT NULL DEFAULT 0,
  search_count integer NOT NULL DEFAULT 1,
  last_searched_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_history_search_count_positive CHECK (search_count >= 1),
  CONSTRAINT search_history_result_count_non_negative CHECK (result_count >= 0),
  CONSTRAINT search_history_user_id_users_id_fk
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE cascade
);

-- "Nike Shoes" and "nike shoes" merge on the normalized form.
CREATE UNIQUE INDEX IF NOT EXISTS search_history_user_query_key
  ON search_history (user_id, normalized_query);
CREATE INDEX IF NOT EXISTS search_history_user_recent_idx
  ON search_history (user_id, last_searched_at DESC);

-- ── Search events (click, add-to-cart, purchase) ───────────────────────────
-- The table that turns search from a guess into a measurement: without click
-- position and outcome there is no way to tell whether a ranking change
-- helped. Append-only, never updated.
CREATE TABLE IF NOT EXISTS search_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  search_log_id uuid,
  product_id uuid,
  position integer,
  event_type text NOT NULL DEFAULT 'CLICK',
  session_hash text,
  ranking_version text,
  experiment_variant text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_events_position_positive CHECK (position IS NULL OR position >= 1),
  CONSTRAINT search_events_product_id_products_id_fk
    FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE cascade
);

-- `search_log_id` has no foreign key on purpose: a purchase can be attributed
-- to a search from an earlier session, and a dangling FK would be worse than
-- a null.
CREATE INDEX IF NOT EXISTS search_events_log_idx ON search_events (search_log_id);
CREATE INDEX IF NOT EXISTS search_events_type_time_idx
  ON search_events (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS search_events_product_idx
  ON search_events (product_id, created_at DESC);

-- ── Ranking configuration ──────────────────────────────────────────────────
-- Versioned weight sets. The partial unique index enforces the invariant that
-- exactly one configuration is active, which is what makes a ranking change
-- safely reversible: activate the previous version and the new one steps down.
CREATE TABLE IF NOT EXISTS search_ranking_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL,
  label text NOT NULL DEFAULT 'Default ranking',
  weights jsonb NOT NULL,
  out_of_stock_mode text NOT NULL DEFAULT 'DEMOTE',
  fuzzy_threshold real NOT NULL DEFAULT 0.35,
  max_edit_distance integer NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_ranking_configs_fuzzy_threshold_range
    CHECK (fuzzy_threshold >= 0 AND fuzzy_threshold <= 1),
  CONSTRAINT search_ranking_configs_edit_distance_range
    CHECK (max_edit_distance >= 0 AND max_edit_distance <= 3),
  CONSTRAINT search_ranking_configs_out_of_stock_mode_valid
    CHECK (out_of_stock_mode IN ('HIDE', 'DEMOTE', 'ONLY_IF_EMPTY'))
);

CREATE UNIQUE INDEX IF NOT EXISTS search_ranking_configs_version_key
  ON search_ranking_configs (version);
CREATE UNIQUE INDEX IF NOT EXISTS search_ranking_configs_single_active_key
  ON search_ranking_configs (is_active) WHERE is_active = true;

-- ── Experiments ────────────────────────────────────────────────────────────
-- One active experiment per key, so two tests can never silently fight over
-- the same traffic bucket.
CREATE TABLE IF NOT EXISTS search_experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  name text NOT NULL,
  variants jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT false,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS search_experiments_key_active_key
  ON search_experiments (key) WHERE is_active = true;

-- ── Runtime settings ───────────────────────────────────────────────────────
-- Tunables an operator can change without a deploy (candidate limit,
-- autocorrect on/off). Keyed, so an unknown key falls back to the compiled
-- default in code rather than erroring.
CREATE TABLE IF NOT EXISTS search_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  description text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Part 12 columns on search_query_logs ───────────────────────────────────
-- Correction and ranking provenance. Without these an analytics row cannot be
-- reproduced: you would know a query returned nothing, but not whether that
-- was before or after spell correction, or under which weight set.
ALTER TABLE search_query_logs ADD COLUMN IF NOT EXISTS corrected_query text;
ALTER TABLE search_query_logs ADD COLUMN IF NOT EXISTS was_corrected boolean NOT NULL DEFAULT false;
ALTER TABLE search_query_logs ADD COLUMN IF NOT EXISTS ranking_version text;
ALTER TABLE search_query_logs ADD COLUMN IF NOT EXISTS experiment_variant text;
ALTER TABLE search_query_logs ADD COLUMN IF NOT EXISTS filter_signature text;

CREATE INDEX IF NOT EXISTS search_query_logs_version_time_idx
  ON search_query_logs (ranking_version, created_at DESC);

-- ── Part 12 indexes on product_search_index ────────────────────────────────
-- Faceting groups the candidate set by brand or category and filters on price,
-- so the composite index leads with the grouping column. Without these, every
-- facet update is a full pass over the search index.
CREATE INDEX IF NOT EXISTS product_search_index_facet_brand_idx
  ON product_search_index (brand_id, price_paise) WHERE is_searchable = true;
CREATE INDEX IF NOT EXISTS product_search_index_facet_category_idx
  ON product_search_index (category_id, price_paise) WHERE is_searchable = true;
CREATE INDEX IF NOT EXISTS product_search_index_rating_idx
  ON product_search_index (rating_average DESC NULLS LAST) WHERE is_searchable = true;
CREATE INDEX IF NOT EXISTS product_search_index_updated_idx
  ON product_search_index (indexed_at DESC) WHERE is_searchable = true;
