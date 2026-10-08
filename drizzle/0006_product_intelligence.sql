-- Part 11: product catalog & product intelligence engine.
--
-- Adds: brands, category tree path, full product/variant commerce fields,
-- media kinds (video / 360), the flexible attribute engine, the append-only
-- inventory ledger, the pricing rule table, product relations, the catalog
-- event outbox, and the search foundation (FTS + trigram + synonyms +
-- suggestions + query log).
--
-- Idempotent: safe to re-run, and matches `drizzle-kit push` output.
-- Every ALTER is additive — no existing column is dropped or retyped, so
-- Parts 1–10 keep working against the same rows.

-- ── Extensions ───────────────────────────────────────────────────────────
-- pg_trgm powers fuzzy/prefix matching; unaccent powers accent-insensitive
-- search. Both ship with PostgreSQL core (contrib), no external install.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ── Enums ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE product_visibility AS ENUM ('PUBLIC', 'UNLISTED', 'PRIVATE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE media_kind AS ENUM ('IMAGE', 'VIDEO', 'SPIN_360');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE attribute_type AS ENUM ('TEXT', 'NUMBER', 'BOOLEAN', 'COLOR', 'ENUM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE inventory_operation AS ENUM (
    'STOCK_IN', 'SALE', 'RETURN', 'CANCELLATION',
    'MANUAL_ADJUSTMENT', 'DAMAGE', 'RESERVED', 'RELEASED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE inventory_reference AS ENUM (
    'ORDER', 'ORDER_ITEM', 'RETURN', 'CANCELLATION',
    'PURCHASE_ORDER', 'IMPORT_BATCH', 'MANUAL'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE price_rule_type AS ENUM ('AUTOMATIC', 'CAMPAIGN', 'SELLER', 'SCHEDULED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE discount_type AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE product_relation_type AS ENUM (
    'RELATED', 'UPSELL', 'CROSS_SELL', 'FREQUENTLY_BOUGHT_TOGETHER', 'ACCESSORY'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE catalog_event_type AS ENUM (
    'PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_DELETED', 'PRICE_CHANGED',
    'STOCK_CHANGED', 'PRODUCT_PUBLISHED', 'PRODUCT_UNPUBLISHED',
    'VARIANT_CREATED', 'VARIANT_UPDATED', 'VARIANT_RETIRED',
    'MEDIA_CHANGED', 'CATEGORY_UPDATED', 'BRAND_UPDATED', 'SEARCH_INDEX_REFRESHED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Brand lifecycle events. Added as separate idempotent statements so a database
-- that already has the type (created by an earlier run of this migration) still
-- picks them up: CREATE TYPE above is skipped wholesale on a duplicate.
DO $$ BEGIN ALTER TYPE catalog_event_type ADD VALUE IF NOT EXISTS 'BRAND_CREATED'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE catalog_event_type ADD VALUE IF NOT EXISTS 'BRAND_DELETED'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Brands ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  description text,
  logo_url text,
  banner_url text,
  website text,
  seller_id uuid,
  seo_title text,
  seo_description text,
  display_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brands_seller_id_users_id_fk FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS brands_slug_key ON brands (slug);
CREATE UNIQUE INDEX IF NOT EXISTS brands_name_key ON brands (lower(name));
CREATE INDEX IF NOT EXISTS brands_active_idx ON brands (is_active);
CREATE INDEX IF NOT EXISTS brands_seller_idx ON brands (seller_id);
CREATE INDEX IF NOT EXISTS brands_order_idx ON brands (display_order, name);

-- ── Categories: materialized path for O(1) subtree queries ───────────────
ALTER TABLE categories ADD COLUMN IF NOT EXISTS path text;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS depth integer NOT NULL DEFAULT 0;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS ancestor_ids text NOT NULL DEFAULT '';

-- Backfill from the existing parent_id chain before tightening to NOT NULL.
WITH RECURSIVE tree AS (
  SELECT c.id, c.slug, c.parent_id,
         c.slug::text AS path,
         0 AS depth,
         ''::text AS ancestor_ids
    FROM categories c WHERE c.parent_id IS NULL
  UNION ALL
  SELECT c.id, c.slug, c.parent_id,
         t.path || '/' || c.slug,
         t.depth + 1,
         CASE WHEN t.ancestor_ids = '' THEN t.id::text ELSE t.ancestor_ids || ',' || t.id::text END
    FROM categories c JOIN tree t ON c.parent_id = t.id
)
UPDATE categories c
   SET path = tree.path,
       depth = tree.depth,
       ancestor_ids = tree.ancestor_ids
  FROM tree WHERE c.id = tree.id;

-- Orphans whose parent chain never resolved (should not exist, but be safe).
UPDATE categories SET path = slug, depth = 0 WHERE path IS NULL;

ALTER TABLE categories ALTER COLUMN path SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS categories_path_key ON categories (path);
CREATE INDEX IF NOT EXISTS categories_path_prefix_idx ON categories (path) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS categories_depth_order_idx ON categories (depth, display_order, name);

-- ── Products ─────────────────────────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS visibility product_visibility NOT NULL DEFAULT 'PUBLIC',
  ADD COLUMN IF NOT EXISTS seller_id uuid,
  ADD COLUMN IF NOT EXISTS brand_id uuid,
  ADD COLUMN IF NOT EXISTS category_id uuid,
  ADD COLUMN IF NOT EXISTS subcategory_id uuid,
  ADD COLUMN IF NOT EXISTS cost_price integer,
  ADD COLUMN IF NOT EXISTS tax_rate_bp integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS barcode text,
  ADD COLUMN IF NOT EXISTS stock_quantity integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS low_stock_threshold integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS weight_grams integer,
  ADD COLUMN IF NOT EXISTS length_mm integer,
  ADD COLUMN IF NOT EXISTS width_mm integer,
  ADD COLUMN IF NOT EXISTS height_mm integer,
  ADD COLUMN IF NOT EXISTS featured boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_new boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_best_seller boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rating_average real,
  ADD COLUMN IF NOT EXISTS rating_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- Backfill the primary category from the existing product_categories mapping.
UPDATE products p
   SET category_id = pc.category_id
  FROM (
    SELECT DISTINCT ON (product_id) product_id, category_id
      FROM product_categories ORDER BY product_id, is_primary DESC
  ) pc
 WHERE p.id = pc.product_id AND p.category_id IS NULL;

-- Named to match Drizzle's convention so `db:push` and `db:migrate` agree.
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_seller_id_users_id_fk;
ALTER TABLE products ADD CONSTRAINT products_seller_id_users_id_fk
  FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_brand_id_brands_id_fk;
ALTER TABLE products ADD CONSTRAINT products_brand_id_brands_id_fk
  FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE SET NULL;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_category_id_categories_id_fk;
ALTER TABLE products ADD CONSTRAINT products_category_id_categories_id_fk
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_subcategory_id_categories_id_fk;
ALTER TABLE products ADD CONSTRAINT products_subcategory_id_categories_id_fk
  FOREIGN KEY (subcategory_id) REFERENCES categories(id) ON DELETE SET NULL;

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_cost_price_non_negative;
ALTER TABLE products ADD CONSTRAINT products_cost_price_non_negative
  CHECK (cost_price IS NULL OR cost_price >= 0);
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_stock_non_negative;
ALTER TABLE products ADD CONSTRAINT products_stock_non_negative CHECK (stock_quantity >= 0);
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_low_stock_threshold_non_negative;
ALTER TABLE products ADD CONSTRAINT products_low_stock_threshold_non_negative CHECK (low_stock_threshold >= 0);
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_tax_rate_range;
ALTER TABLE products ADD CONSTRAINT products_tax_rate_range CHECK (tax_rate_bp >= 0 AND tax_rate_bp <= 10000);
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_rating_range;
ALTER TABLE products ADD CONSTRAINT products_rating_range
  CHECK (rating_average IS NULL OR (rating_average >= 0 AND rating_average <= 5));
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_rating_count_non_negative;
ALTER TABLE products ADD CONSTRAINT products_rating_count_non_negative CHECK (rating_count >= 0);
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_weight_positive;
ALTER TABLE products ADD CONSTRAINT products_weight_positive CHECK (weight_grams IS NULL OR weight_grams > 0);
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_dimensions_positive;
ALTER TABLE products ADD CONSTRAINT products_dimensions_positive
  CHECK ((length_mm IS NULL OR length_mm > 0)
     AND (width_mm IS NULL OR width_mm > 0)
     AND (height_mm IS NULL OR height_mm > 0));

CREATE INDEX IF NOT EXISTS products_category_idx ON products (category_id);
CREATE INDEX IF NOT EXISTS products_subcategory_idx ON products (subcategory_id);
CREATE INDEX IF NOT EXISTS products_brand_idx ON products (brand_id);
CREATE INDEX IF NOT EXISTS products_seller_idx ON products (seller_id);
CREATE INDEX IF NOT EXISTS products_created_at_idx ON products (created_at);
CREATE INDEX IF NOT EXISTS products_listable_idx
  ON products (category_id, published_at DESC NULLS LAST)
  WHERE status = 'ACTIVE' AND visibility = 'PUBLIC';
CREATE INDEX IF NOT EXISTS products_featured_idx
  ON products (featured, published_at DESC NULLS LAST)
  WHERE status = 'ACTIVE' AND visibility = 'PUBLIC';
CREATE INDEX IF NOT EXISTS products_low_stock_idx
  ON products (stock_quantity) WHERE stock_quantity <= low_stock_threshold;
CREATE UNIQUE INDEX IF NOT EXISTS products_barcode_key ON products (barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS products_search_vector_idx ON products USING gin (search_vector);

-- ── Product variants ─────────────────────────────────────────────────────
ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS cost_price integer,
  ADD COLUMN IF NOT EXISTS barcode text,
  ADD COLUMN IF NOT EXISTS length_mm integer,
  ADD COLUMN IF NOT EXISTS width_mm integer,
  ADD COLUMN IF NOT EXISTS height_mm integer,
  ADD COLUMN IF NOT EXISTS stock_quantity integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reserved_quantity integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS image_id uuid,
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS combo_hash text;

ALTER TABLE product_variants DROP CONSTRAINT IF EXISTS product_variants_cost_non_negative;
ALTER TABLE product_variants ADD CONSTRAINT product_variants_cost_non_negative
  CHECK (cost_price IS NULL OR cost_price >= 0);
ALTER TABLE product_variants DROP CONSTRAINT IF EXISTS product_variants_stock_non_negative;
ALTER TABLE product_variants ADD CONSTRAINT product_variants_stock_non_negative CHECK (stock_quantity >= 0);
ALTER TABLE product_variants DROP CONSTRAINT IF EXISTS product_variants_reserved_non_negative;
ALTER TABLE product_variants ADD CONSTRAINT product_variants_reserved_non_negative CHECK (reserved_quantity >= 0);
ALTER TABLE product_variants DROP CONSTRAINT IF EXISTS product_variants_reserved_within_stock;
ALTER TABLE product_variants ADD CONSTRAINT product_variants_reserved_within_stock
  CHECK (reserved_quantity <= stock_quantity);
ALTER TABLE product_variants DROP CONSTRAINT IF EXISTS product_variants_position_non_negative;
ALTER TABLE product_variants ADD CONSTRAINT product_variants_position_non_negative CHECK (position >= 0);
ALTER TABLE product_variants DROP CONSTRAINT IF EXISTS product_variants_weight_positive;
ALTER TABLE product_variants ADD CONSTRAINT product_variants_weight_positive
  CHECK (weight_grams IS NULL OR weight_grams > 0);

CREATE UNIQUE INDEX IF NOT EXISTS product_variants_barcode_key
  ON product_variants (barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS product_variants_product_position_idx
  ON product_variants (product_id, position);
CREATE INDEX IF NOT EXISTS product_variants_active_product_idx
  ON product_variants (product_id, stock_quantity) WHERE is_active = true;
-- Legacy size/colour uniqueness now applies only to rows without a combo hash;
-- attribute-based variants are identified by their attribute set instead.
DROP INDEX IF EXISTS product_variants_combo_key;
CREATE UNIQUE INDEX IF NOT EXISTS product_variants_combo_key
  ON product_variants (product_id, coalesce(size, ''), coalesce(color, ''))
  WHERE combo_hash IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS product_variants_attribute_combo_key
  ON product_variants (product_id, combo_hash) WHERE combo_hash IS NOT NULL;

-- ── Media (images table = platform media table) ──────────────────────────
ALTER TABLE images
  ADD COLUMN IF NOT EXISTS media_kind media_kind NOT NULL DEFAULT 'IMAGE',
  ADD COLUMN IF NOT EXISTS thumbnail_url text,
  ADD COLUMN IF NOT EXISTS external_url text,
  ADD COLUMN IF NOT EXISTS format text,
  ADD COLUMN IF NOT EXISTS duration_ms integer,
  ADD COLUMN IF NOT EXISTS frame_count integer;

ALTER TABLE images DROP CONSTRAINT IF EXISTS images_dimensions_positive;
ALTER TABLE images ADD CONSTRAINT images_dimensions_positive
  CHECK ((width IS NULL OR width > 0) AND (height IS NULL OR height > 0));
ALTER TABLE images DROP CONSTRAINT IF EXISTS images_file_size_non_negative;
ALTER TABLE images ADD CONSTRAINT images_file_size_non_negative
  CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0);
ALTER TABLE images DROP CONSTRAINT IF EXISTS images_duration_positive;
ALTER TABLE images ADD CONSTRAINT images_duration_positive CHECK (duration_ms IS NULL OR duration_ms > 0);
ALTER TABLE images DROP CONSTRAINT IF EXISTS images_frame_count_positive;
ALTER TABLE images ADD CONSTRAINT images_frame_count_positive CHECK (frame_count IS NULL OR frame_count > 0);
ALTER TABLE images DROP CONSTRAINT IF EXISTS images_sort_order_non_negative;
ALTER TABLE images ADD CONSTRAINT images_sort_order_non_negative CHECK (sort_order >= 0);

CREATE INDEX IF NOT EXISTS images_product_kind_sort_idx
  ON images (product_id, media_kind, sort_order);

-- ── Attribute engine ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attribute_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  value_type attribute_type NOT NULL DEFAULT 'TEXT',
  is_variant_axis boolean NOT NULL DEFAULT false,
  is_required boolean NOT NULL DEFAULT false,
  allow_custom_values boolean NOT NULL DEFAULT true,
  unit text,
  is_swatch boolean NOT NULL DEFAULT false,
  display_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attribute_definitions_order_non_negative CHECK (display_order >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS attribute_definitions_code_key ON attribute_definitions (code);
CREATE INDEX IF NOT EXISTS attribute_definitions_axis_idx
  ON attribute_definitions (is_variant_axis, display_order);
CREATE INDEX IF NOT EXISTS attribute_definitions_active_idx ON attribute_definitions (is_active);

CREATE TABLE IF NOT EXISTS attribute_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id uuid NOT NULL,
  slug text NOT NULL,
  label text NOT NULL,
  hex text,
  sort_order integer NOT NULL DEFAULT 0,
  numeric_value numeric(18,4),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attribute_options_order_non_negative CHECK (sort_order >= 0),
  CONSTRAINT attribute_options_definition_id_attribute_definitions_id_fk
    FOREIGN KEY (definition_id) REFERENCES attribute_definitions(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS attribute_options_definition_slug_key
  ON attribute_options (definition_id, slug);
CREATE INDEX IF NOT EXISTS attribute_options_definition_order_idx
  ON attribute_options (definition_id, sort_order, label);
CREATE INDEX IF NOT EXISTS attribute_options_active_idx ON attribute_options (is_active);

CREATE TABLE IF NOT EXISTS product_attribute_axes (
  product_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  position integer NOT NULL DEFAULT 0,
  is_required boolean NOT NULL DEFAULT true,
  CONSTRAINT product_attribute_axes_product_id_definition_id_pk PRIMARY KEY (product_id, definition_id),
  CONSTRAINT product_attribute_axes_position_non_negative CHECK (position >= 0),
  CONSTRAINT product_attribute_axes_product_id_products_id_fk
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT product_attribute_axes_definition_id_attribute_definitions_id_f
    FOREIGN KEY (definition_id) REFERENCES attribute_definitions(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS product_attribute_axes_position_key
  ON product_attribute_axes (product_id, position);
CREATE INDEX IF NOT EXISTS product_attribute_axes_definition_idx
  ON product_attribute_axes (definition_id);

CREATE TABLE IF NOT EXISTS variant_attributes (
  variant_id uuid NOT NULL,
  product_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  option_id uuid,
  value_text text NOT NULL,
  value_key text NOT NULL,
  value_numeric numeric(18,4),
  CONSTRAINT variant_attributes_variant_id_definition_id_pk PRIMARY KEY (variant_id, definition_id),
  CONSTRAINT variant_attributes_value_not_blank CHECK (length(btrim(value_text)) > 0),
  CONSTRAINT variant_attributes_variant_id_product_variants_id_fk
    FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE CASCADE,
  CONSTRAINT variant_attributes_product_id_products_id_fk
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT variant_attributes_definition_id_attribute_definitions_id_fk
    FOREIGN KEY (definition_id) REFERENCES attribute_definitions(id) ON DELETE CASCADE,
  CONSTRAINT variant_attributes_option_id_attribute_options_id_fk
    FOREIGN KEY (option_id) REFERENCES attribute_options(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS variant_attributes_product_definition_idx
  ON variant_attributes (product_id, definition_id);
CREATE INDEX IF NOT EXISTS variant_attributes_option_idx ON variant_attributes (option_id);
CREATE INDEX IF NOT EXISTS variant_attributes_value_idx ON variant_attributes (definition_id, value_key);

CREATE TABLE IF NOT EXISTS product_attributes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  option_id uuid,
  value_text text,
  value_numeric numeric(18,4),
  value_boolean boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_attributes_has_value
    CHECK (value_text IS NOT NULL OR value_numeric IS NOT NULL OR value_boolean IS NOT NULL),
  CONSTRAINT product_attributes_product_id_products_id_fk
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT product_attributes_definition_id_attribute_definitions_id_fk
    FOREIGN KEY (definition_id) REFERENCES attribute_definitions(id) ON DELETE CASCADE,
  CONSTRAINT product_attributes_option_id_attribute_options_id_fk
    FOREIGN KEY (option_id) REFERENCES attribute_options(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS product_attributes_unique_key
  ON product_attributes (product_id, definition_id);
CREATE INDEX IF NOT EXISTS product_attributes_definition_idx
  ON product_attributes (definition_id, value_text);

CREATE TABLE IF NOT EXISTS product_specifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,
  group_name text NOT NULL DEFAULT 'General',
  label text NOT NULL,
  value text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  CONSTRAINT product_specifications_order_non_negative CHECK (sort_order >= 0),
  CONSTRAINT product_specifications_product_id_products_id_fk
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS product_specifications_unique_key
  ON product_specifications (product_id, lower(group_name), lower(label));
CREATE INDEX IF NOT EXISTS product_specifications_product_idx
  ON product_specifications (product_id, group_name, sort_order);

-- ── Inventory ledger (append-only) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  previous_quantity integer NOT NULL,
  quantity_changed integer NOT NULL,
  new_quantity integer NOT NULL,
  operation inventory_operation NOT NULL,
  reference_type inventory_reference NOT NULL DEFAULT 'MANUAL',
  reference_id text,
  reason text,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_ledger_new_is_consistent
    CHECK (previous_quantity + quantity_changed = new_quantity),
  CONSTRAINT inventory_ledger_new_non_negative CHECK (new_quantity >= 0),
  CONSTRAINT inventory_ledger_changed_non_zero CHECK (quantity_changed != 0),
  CONSTRAINT inventory_ledger_product_id_products_id_fk
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT inventory_ledger_variant_id_product_variants_id_fk
    FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE CASCADE,
  CONSTRAINT inventory_ledger_actor_id_users_id_fk
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS inventory_ledger_variant_time_idx
  ON inventory_ledger (variant_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS inventory_ledger_product_time_idx
  ON inventory_ledger (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inventory_ledger_operation_idx ON inventory_ledger (operation);
CREATE INDEX IF NOT EXISTS inventory_ledger_reference_idx
  ON inventory_ledger (reference_type, reference_id);
CREATE INDEX IF NOT EXISTS inventory_ledger_actor_idx ON inventory_ledger (actor_id);
-- Replayed webhooks become no-ops instead of double-deducting stock.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_ledger_idempotency_key
  ON inventory_ledger (variant_id, operation, reference_id) WHERE reference_id IS NOT NULL;

-- ── Pricing rules ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_price_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,
  variant_id uuid,
  rule_type price_rule_type NOT NULL DEFAULT 'AUTOMATIC',
  discount_type discount_type NOT NULL,
  discount_value integer NOT NULL,
  max_discount_paise integer,
  priority integer NOT NULL DEFAULT 100,
  stackable boolean NOT NULL DEFAULT true,
  name text NOT NULL DEFAULT 'Discount',
  seller_id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_price_rules_value_non_negative CHECK (discount_value >= 0),
  CONSTRAINT product_price_rules_percentage_range
    CHECK (discount_type != 'PERCENTAGE' OR discount_value <= 10000),
  CONSTRAINT product_price_rules_max_discount_non_negative
    CHECK (max_discount_paise IS NULL OR max_discount_paise >= 0),
  CONSTRAINT product_price_rules_window_valid
    CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
  CONSTRAINT product_price_rules_product_id_products_id_fk
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT product_price_rules_variant_id_product_variants_id_fk
    FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE CASCADE,
  CONSTRAINT product_price_rules_seller_id_users_id_fk
    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS product_price_rules_product_idx
  ON product_price_rules (product_id, rule_type, priority);
CREATE INDEX IF NOT EXISTS product_price_rules_variant_idx ON product_price_rules (variant_id);
CREATE INDEX IF NOT EXISTS product_price_rules_active_window_idx
  ON product_price_rules (product_id, coalesce(starts_at, '-infinity'), coalesce(ends_at, 'infinity'))
  WHERE is_active = true;
CREATE INDEX IF NOT EXISTS product_price_rules_seller_idx ON product_price_rules (seller_id);

-- ── Product relations / recommendations ──────────────────────────────────
CREATE TABLE IF NOT EXISTS product_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,
  related_product_id uuid NOT NULL,
  relation_type product_relation_type NOT NULL DEFAULT 'RELATED',
  score real NOT NULL DEFAULT 0,
  is_manual boolean NOT NULL DEFAULT false,
  co_occurrence_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_relations_not_self CHECK (product_id != related_product_id),
  CONSTRAINT product_relations_co_occurrence_non_negative CHECK (co_occurrence_count >= 0),
  CONSTRAINT product_relations_product_id_products_id_fk
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT product_relations_related_product_id_products_id_fk
    FOREIGN KEY (related_product_id) REFERENCES products(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS product_relations_unique_key
  ON product_relations (product_id, related_product_id, relation_type);
CREATE INDEX IF NOT EXISTS product_relations_lookup_idx
  ON product_relations (product_id, relation_type, score DESC);
CREATE INDEX IF NOT EXISTS product_relations_related_idx ON product_relations (related_product_id);

-- ── Catalog event outbox ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS catalog_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type catalog_event_type NOT NULL,
  aggregate_type text NOT NULL DEFAULT 'product',
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  CONSTRAINT catalog_events_attempt_non_negative CHECK (attempt_count >= 0),
  CONSTRAINT catalog_events_actor_id_users_id_fk
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS catalog_events_unpublished_idx
  ON catalog_events (created_at, id) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS catalog_events_aggregate_idx
  ON catalog_events (aggregate_type, aggregate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS catalog_events_type_idx ON catalog_events (event_type, created_at DESC);

-- ── Search foundation ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS search_synonyms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term text NOT NULL,
  synonym text NOT NULL,
  is_bidirectional boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS search_synonyms_pair_key ON search_synonyms (term, synonym);
CREATE INDEX IF NOT EXISTS search_synonyms_term_idx ON search_synonyms (term) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS product_search_index (
  product_id uuid PRIMARY KEY,
  slug text NOT NULL,
  name text NOT NULL,
  brand_name text,
  brand_id uuid,
  category_id uuid,
  category_path text,
  seller_id uuid,
  sku_text text NOT NULL DEFAULT '',
  tag_text text NOT NULL DEFAULT '',
  attribute_text text NOT NULL DEFAULT '',
  description_text text NOT NULL DEFAULT '',
  search_vector tsvector NOT NULL,
  trigram_text text NOT NULL DEFAULT '',
  price_paise integer NOT NULL DEFAULT 0,
  compare_at_paise integer,
  status text NOT NULL,
  is_searchable boolean NOT NULL DEFAULT false,
  rating_average real,
  rating_count integer NOT NULL DEFAULT 0,
  popularity real NOT NULL DEFAULT 0,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_search_index_price_non_negative CHECK (price_paise >= 0),
  CONSTRAINT product_search_index_product_id_products_id_fk
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS product_search_index_vector_idx
  ON product_search_index USING gin (search_vector);
CREATE INDEX IF NOT EXISTS product_search_index_trigram_idx
  ON product_search_index USING gin (trigram_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS product_search_index_searchable_idx
  ON product_search_index (is_searchable, popularity DESC, product_id) WHERE is_searchable = true;
CREATE INDEX IF NOT EXISTS product_search_index_category_idx ON product_search_index (category_id);
CREATE INDEX IF NOT EXISTS product_search_index_brand_idx ON product_search_index (brand_id);

CREATE TABLE IF NOT EXISTS search_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term text NOT NULL,
  kind text NOT NULL DEFAULT 'PRODUCT',
  product_id uuid,
  category_id uuid,
  brand_id uuid,
  weight real NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_suggestions_product_id_products_id_fk
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT search_suggestions_category_id_categories_id_fk
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
  CONSTRAINT search_suggestions_brand_id_brands_id_fk
    FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS search_suggestions_unique_key
  ON search_suggestions (term, kind, product_id);
CREATE INDEX IF NOT EXISTS search_suggestions_prefix_idx
  ON search_suggestions USING gin (term gin_trgm_ops);
CREATE INDEX IF NOT EXISTS search_suggestions_weight_idx ON search_suggestions (weight);

CREATE TABLE IF NOT EXISTS search_query_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query text NOT NULL,
  normalized_query text NOT NULL,
  result_count integer NOT NULL DEFAULT 0,
  took_ms integer,
  session_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_query_logs_result_count_non_negative CHECK (result_count >= 0)
);
CREATE INDEX IF NOT EXISTS search_query_logs_normalized_idx
  ON search_query_logs (normalized_query, created_at DESC);
CREATE INDEX IF NOT EXISTS search_query_logs_zero_results_idx
  ON search_query_logs (created_at DESC) WHERE result_count = 0;

-- ── Bulk import batches ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL DEFAULT 'csv',
  file_name text,
  file_hash text,
  status text NOT NULL DEFAULT 'PENDING',
  total_rows integer NOT NULL DEFAULT 0,
  imported_rows integer NOT NULL DEFAULT 0,
  rejected_rows integer NOT NULL DEFAULT 0,
  error_report jsonb,
  actor_id uuid,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_batches_counts_non_negative
    CHECK (total_rows >= 0 AND imported_rows >= 0 AND rejected_rows >= 0),
  CONSTRAINT import_batches_actor_id_users_id_fk
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS import_batches_status_idx ON import_batches (status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS import_batches_file_hash_key
  ON import_batches (file_hash) WHERE file_hash IS NOT NULL;

-- ── Seed the two axes every existing product already implies ─────────────
-- Parts 1–10 hard-coded size/colour on variants. Registering them as real
-- attribute definitions lets new axes sit beside them without a rewrite, and
-- lets `variant.service.ts` mirror legacy size/colour into `variant_attributes`.
INSERT INTO attribute_definitions (code, name, value_type, is_variant_axis, is_required, is_swatch, display_order)
VALUES
  ('size',  'Size',  'TEXT',  true, true, false, 0),
  ('color', 'Color', 'COLOR', true, true, true,  1)
ON CONFLICT (code) DO NOTHING;
