-- Catalog management: slug history, reusable colors/sizes, image roles,
-- campaign windows, and stricter money checks. Does not connect a supplier.

DO $$ BEGIN
  CREATE TYPE image_role AS ENUM ('PRIMARY', 'GALLERY', 'HOVER', 'THUMBNAIL', 'MOBILE', 'SOCIAL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS admin_notes text,
  ADD COLUMN IF NOT EXISTS estimated_shipping_paise integer,
  ADD COLUMN IF NOT EXISTS estimated_payment_fee_paise integer,
  ADD COLUMN IF NOT EXISTS supplier_mapping_required boolean NOT NULL DEFAULT false;

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_compare_at_non_negative;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_compare_at_not_below;
ALTER TABLE products
  ADD CONSTRAINT products_compare_at_not_below
  CHECK (compare_at_price IS NULL OR compare_at_price >= base_price);

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_shipping_non_negative;
ALTER TABLE products
  ADD CONSTRAINT products_shipping_non_negative
  CHECK (estimated_shipping_paise IS NULL OR estimated_shipping_paise >= 0);

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_fee_non_negative;
ALTER TABLE products
  ADD CONSTRAINT products_fee_non_negative
  CHECK (estimated_payment_fee_paise IS NULL OR estimated_payment_fee_paise >= 0);

CREATE INDEX IF NOT EXISTS products_name_idx ON products (name);
CREATE INDEX IF NOT EXISTS products_status_published_idx ON products (status, published_at);

ALTER TABLE product_variants DROP CONSTRAINT IF EXISTS product_variants_compare_at_not_below;
ALTER TABLE product_variants
  ADD CONSTRAINT product_variants_compare_at_not_below
  CHECK (compare_at_price IS NULL OR compare_at_price >= price);

CREATE INDEX IF NOT EXISTS product_variants_size_idx ON product_variants (size);
CREATE INDEX IF NOT EXISTS product_variants_color_idx ON product_variants (color);
CREATE UNIQUE INDEX IF NOT EXISTS product_variants_combo_key
  ON product_variants (product_id, COALESCE(size, ''), COALESCE(color, ''));

ALTER TABLE collections
  ADD COLUMN IF NOT EXISTS starts_at timestamptz,
  ADD COLUMN IF NOT EXISTS ends_at timestamptz;

ALTER TABLE images
  ADD COLUMN IF NOT EXISTS role image_role NOT NULL DEFAULT 'GALLERY';

CREATE INDEX IF NOT EXISTS images_category_idx ON images (category_id);
CREATE INDEX IF NOT EXISTS images_collection_idx ON images (collection_id);
CREATE INDEX IF NOT EXISTS product_tags_tag_idx ON product_tags (tag_id);

CREATE TABLE IF NOT EXISTS product_slug_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  slug text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS product_slug_history_slug_key ON product_slug_history (slug);
CREATE INDEX IF NOT EXISTS product_slug_history_product_idx ON product_slug_history (product_id);

CREATE TABLE IF NOT EXISTS colors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  hex text NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS colors_slug_key ON colors (slug);
CREATE UNIQUE INDEX IF NOT EXISTS colors_name_key ON colors (lower(name));

CREATE TABLE IF NOT EXISTS sizes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  label text NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sizes_code_key ON sizes (code);

CREATE TABLE IF NOT EXISTS size_product_types (
  size_id uuid NOT NULL REFERENCES sizes(id) ON DELETE CASCADE,
  product_type product_type NOT NULL,
  PRIMARY KEY (size_id, product_type)
);
