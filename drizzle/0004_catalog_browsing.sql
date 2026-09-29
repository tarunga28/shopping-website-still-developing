-- Part 9: production catalog browsing.
-- Adds partial indexes for the storefront sort orders, slug history for
-- renamed categories/collections, and supporting composite indexes.
-- Idempotent: safe to re-run, and matches `drizzle-kit push` output.

CREATE INDEX IF NOT EXISTS products_active_published_idx
  ON products (published_at DESC NULLS LAST, id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS products_active_price_idx
  ON products (base_price, id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS products_active_name_idx
  ON products (lower(name), id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS products_active_type_idx
  ON products (product_type, id) WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS product_variants_product_availability_idx
  ON product_variants (product_id, availability);
CREATE INDEX IF NOT EXISTS images_product_type_sort_idx
  ON images (product_id, type, sort_order);

CREATE TABLE IF NOT EXISTS category_slug_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  slug text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS category_slug_history_slug_key ON category_slug_history (slug);
CREATE INDEX IF NOT EXISTS category_slug_history_category_idx ON category_slug_history (category_id);

CREATE TABLE IF NOT EXISTS collection_slug_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  slug text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS collection_slug_history_slug_key ON collection_slug_history (slug);
CREATE INDEX IF NOT EXISTS collection_slug_history_collection_idx ON collection_slug_history (collection_id);
