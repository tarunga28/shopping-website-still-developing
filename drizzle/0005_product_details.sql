-- Part 10: production product details page.
-- Adds structured product copy (features/materials/fit/care/specs) and
-- product-type-specific size charts. Idempotent and matches `drizzle-kit push`.

ALTER TABLE products ADD COLUMN IF NOT EXISTS details jsonb;

CREATE TABLE IF NOT EXISTS size_charts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_type product_type NOT NULL,
  title text NOT NULL,
  unit text NOT NULL DEFAULT 'cm',
  columns jsonb NOT NULL,
  rows jsonb NOT NULL,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS size_charts_active_type_key
  ON size_charts (product_type) WHERE is_active = true;
