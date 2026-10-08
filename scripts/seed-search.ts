/**
 * Search & discovery seed data (Part 12).
 *
 *   npm run db:seed:search
 *
 * Creates a catalog shaped for exercising search, not for looking pretty on a
 * homepage: 24 brands, 8 categories, 120 products with variants, attributes,
 * mixed stock states, ratings, and discounts — then indexes it and rebuilds the
 * correction vocabulary.
 *
 * ## Why a separate script
 *
 * `npm run db:seed` seeds the demo storefront. This seeds a corpus for search
 * work, which is a different shape and a different volume. Keeping them apart
 * means neither can break the other, and a search corpus can be re-seeded
 * freely.
 *
 * ## Deliberately difficult terms
 *
 * The corpus includes the cases that break a naive search engine, so a manual
 * test can find them immediately:
 *   - typos that have a real correction ("laptopp", "iphne", "samsng")
 *   - abbreviations and synonyms ("tee"/"t-shirt", "mobile"/"smartphone")
 *   - model numbers that must match exactly ("A17-256GB", "8901234567890")
 *   - price queries ("under 50000", "between 30000 and 50000")
 *   - queries with no possible match, to exercise zero-result recovery
 *
 * Idempotent: rows are keyed by a stable slug prefix and upserted, so re-running
 * refreshes rather than duplicates.
 */
import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

const PREFIX = "searchseed";

/** Deterministic PRNG so a re-seed produces the same catalog. */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
const random = makeRandom(20260607);
const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));

const BRANDS = [
  "Apple", "Samsung", "Google", "OnePlus", "Xiaomi", "Nike", "Adidas", "Puma",
  "Levi's", "Inkline", "boAt", "Sony", "JBL", "Dell", "HP", "Lenovo",
  "Asus", "Acer", "Canon", "Nikon", "Philips", "Bajaj", "Prestige", "Wonderchef",
] as const;

const CATEGORIES = [
  { name: "Smartphones", slug: "smartphones", parent: null },
  { name: "Laptops", slug: "laptops", parent: null },
  { name: "Audio", slug: "audio", parent: null },
  { name: "Cameras", slug: "cameras", parent: null },
  { name: "Kitchen Appliances", slug: "kitchen-appliances", parent: null },
  { name: "Men's Clothing", slug: "mens-clothing", parent: null },
  { name: "Women's Clothing", slug: "womens-clothing", parent: null },
  { name: "Footwear", slug: "footwear", parent: null },
] as const;

const SUBCATEGORIES: Record<string, string[]> = {
  smartphones: ["Flagship", "Mid-range", "Budget"],
  laptops: ["Gaming", "Ultrabook", "Workstation"],
  audio: ["Headphones", "Earbuds", "Speakers"],
  cameras: ["DSLR", "Mirrorless", "Action"],
  "kitchen-appliances": ["Mixer Grinder", "Induction Cooktop", "Air Fryer"],
  "mens-clothing": ["Shirts", "T-Shirts", "Jeans"],
  "womens-clothing": ["Kurtis", "Dresses", "Tops"],
  footwear: ["Running Shoes", "Sneakers", "Sandals"],
};

const ADJECTIVES = [
  "Premium", "Classic", "Pro", "Ultra", "Essential", "Elite", "Compact",
  "Wireless", "Organic", "Vintage",
] as const;

const COLORS = ["black", "white", "blue", "silver", "red", "green", "grey"] as const;

/** Attribute axes per category — drives the dynamic facet list. */
const AXES: Record<string, Array<{ code: string; name: string; values: string[] }>> = {
  smartphones: [
    { code: "storage", name: "Storage", values: ["64GB", "128GB", "256GB", "512GB"] },
    { code: "ram", name: "RAM", values: ["4GB", "6GB", "8GB", "12GB"] },
    { code: "color", name: "Colour", values: [...COLORS] },
  ],
  laptops: [
    { code: "storage", name: "Storage", values: ["256GB", "512GB", "1TB"] },
    { code: "ram", name: "RAM", values: ["8GB", "16GB", "32GB"] },
    { code: "screen_size", name: "Screen size", values: ['14"', '15.6"', '16"'] },
    { code: "color", name: "Colour", values: [...COLORS] },
  ],
  audio: [
    { code: "color", name: "Colour", values: [...COLORS] },
    { code: "battery", name: "Battery", values: ["20h", "30h", "40h"] },
  ],
  cameras: [
    { code: "sensor", name: "Sensor", values: ["APS-C", "Full Frame"] },
    { code: "color", name: "Colour", values: ["black", "silver"] },
  ],
  "kitchen-appliances": [
    { code: "capacity", name: "Capacity", values: ["2L", "3L", "5L"] },
    { code: "color", name: "Colour", values: [...COLORS] },
  ],
  "mens-clothing": [
    { code: "size", name: "Size", values: ["S", "M", "L", "XL", "XXL"] },
    { code: "color", name: "Colour", values: [...COLORS] },
    { code: "material", name: "Material", values: ["cotton", "linen", "denim"] },
  ],
  "womens-clothing": [
    { code: "size", name: "Size", values: ["XS", "S", "M", "L", "XL"] },
    { code: "color", name: "Colour", values: [...COLORS] },
    { code: "material", name: "Material", values: ["cotton", "silk", "georgette"] },
  ],
  footwear: [
    { code: "size", name: "Size", values: ["6", "7", "8", "9", "10", "11"] },
    { code: "color", name: "Colour", values: [...COLORS] },
    { code: "material", name: "Material", values: ["leather", "canvas", "mesh"] },
  ],
};

/** Price bands in paise, per category. */
const PRICE_BANDS: Record<string, [number, number]> = {
  smartphones: [800_000, 14_000_000],
  laptops: [3_000_000, 18_000_000],
  audio: [100_000, 3_000_000],
  cameras: [3_500_000, 20_000_000],
  "kitchen-appliances": [150_000, 1_200_000],
  "mens-clothing": [60_000, 400_000],
  "womens-clothing": [60_000, 450_000],
  footwear: [100_000, 900_000],
};

/** Brands that sell in each category. */
const CATEGORY_BRANDS: Record<string, string[]> = {
  smartphones: ["Apple", "Samsung", "Google", "OnePlus", "Xiaomi"],
  laptops: ["Dell", "HP", "Lenovo", "Asus", "Acer", "Apple"],
  audio: ["boAt", "Sony", "JBL"],
  cameras: ["Canon", "Nikon", "Sony"],
  "kitchen-appliances": ["Philips", "Bajaj", "Prestige", "Wonderchef"],
  "mens-clothing": ["Levi's", "Nike", "Adidas", "Puma", "Inkline"],
  "womens-clothing": ["Levi's", "Inkline", "Puma"],
  footwear: ["Nike", "Adidas", "Puma"],
};

/** Synonyms worth having in a demo catalog. One-way unless truly interchangeable. */
const SYNONYMS: Array<[string, string, boolean]> = [
  ["cell phone", "smartphone", true],
  ["mobile phone", "smartphone", true],
  ["handset", "smartphone", false],
  ["laptop computer", "laptop", true],
  ["notebook", "laptop", false],
  ["headphone", "headphones", true],
  ["earbud", "earbuds", true],
  ["tee", "t-shirt", false],
  ["tshirt", "t-shirt", true],
  ["sneakers", "sneaker", true],
  ["shoe", "shoes", true],
  ["trouser", "jeans", false],
  ["tv", "television", true],
  ["back cover", "phone case", false],
  ["mobile case", "phone case", false],
  ["mixie", "mixer grinder", false],
];

async function main() {
  const client = await pool.connect();
  const startedAt = Date.now();

  try {
    console.log(`Seeding search corpus (prefix "${PREFIX}")…`);

    // ── Brands ─────────────────────────────────────────────────────────
    const brandIds = new Map<string, string>();
    for (const name of BRANDS) {
      const slug = `${PREFIX}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      const row = await client.query(
        `INSERT INTO brands (name, slug, description, is_active, display_order)
         VALUES ($1, $2, $3, true, $4)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, is_active = true
         RETURNING id`,
        [name, slug, `${name} products in the search demo catalog.`, BRANDS.indexOf(name)],
      );
      brandIds.set(name, row.rows[0].id);
    }
    console.log(`  brands ✓ (${brandIds.size})`);

    // ── Categories ─────────────────────────────────────────────────────
    const categoryIds = new Map<string, string>();
    const subcategoryIds = new Map<string, string>();

    for (const category of CATEGORIES) {
      const slug = `${PREFIX}-${category.slug}`;
      const row = await client.query(
        `INSERT INTO categories (name, slug, path, depth, ancestor_ids, is_active, display_order)
         VALUES ($1, $2, $3, 0, '{}', true, $4)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, is_active = true
         RETURNING id`,
        [category.name, slug, `/${slug}`, CATEGORIES.indexOf(category)],
      );
      const parentId = row.rows[0].id;
      categoryIds.set(category.slug, parentId);

      const subs = SUBCATEGORIES[category.slug] ?? [];
      for (const subName of subs) {
        const subSlug = `${slug}-${subName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
        const subRow = await client.query(
          `INSERT INTO categories (name, slug, path, depth, parent_id, ancestor_ids, is_active, display_order)
           VALUES ($1, $2, $3, 1, $4, ARRAY[$4]::uuid[], true, $5)
           ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, is_active = true
           RETURNING id`,
          [subName, subSlug, `/${slug}/${subSlug}`, parentId, subs.indexOf(subName)],
        );
        subcategoryIds.set(`${category.slug}:${subName}`, subRow.rows[0].id);
      }
    }
    console.log(`  categories ✓ (${categoryIds.size} roots, ${subcategoryIds.size} subcategories)`);

    // ── Attribute definitions and options ──────────────────────────────
    const definitionIds = new Map<string, string>();
    const optionIds = new Map<string, string>();

    for (const axes of Object.values(AXES)) {
      for (const axis of axes) {
        if (definitionIds.has(axis.code)) continue;
        const defRow = await client.query(
          `INSERT INTO attribute_definitions (code, name, value_type, is_variant_axis, allow_custom_values, is_active, display_order)
           VALUES ($1, $2, 'TEXT', true, true, true, 0)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [axis.code, axis.name],
        );
        // ON CONFLICT DO NOTHING returns no row when the code already exists.
        if (defRow.rows[0]) {
          definitionIds.set(axis.code, defRow.rows[0].id);
        } else {
          const existing = await client.query(
            `SELECT id FROM attribute_definitions WHERE code = $1`,
            [axis.code],
          );
          if (existing.rows[0]) definitionIds.set(axis.code, existing.rows[0].id);
        }

        const definitionId = definitionIds.get(axis.code);
        if (!definitionId) continue;

        for (const value of axis.values) {
          const optionRow = await client.query(
            `INSERT INTO attribute_options (definition_id, label, slug, is_active, sort_order)
             VALUES ($1, $2, $3, true, 0)
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [definitionId, value, value.toLowerCase().replace(/[^a-z0-9]+/g, "-")],
          );
          if (optionRow.rows[0]) {
            optionIds.set(`${axis.code}:${value}`, optionRow.rows[0].id);
          } else {
            // Already present from an earlier run: ON CONFLICT DO NOTHING returns
            // nothing, so look the id up. Without this, a re-seed leaves
            // optionIds empty and silently links no variant attributes at all.
            const existingOption = await client.query(
              `SELECT id FROM attribute_options WHERE definition_id = $1 AND slug = $2`,
              [definitionId, value.toLowerCase().replace(/[^a-z0-9]+/g, "-")],
            );
            if (existingOption.rows[0]) {
              optionIds.set(`${axis.code}:${value}`, existingOption.rows[0].id);
            }
          }
        }
      }
    }
    console.log(`  attribute definitions ✓ (${definitionIds.size} axes, ${optionIds.size} options)`);

    // ── Products ───────────────────────────────────────────────────────
    const TARGET_PRODUCTS = 120;
    let created = 0;
    let variantsCreated = 0;

    for (let index = 0; index < TARGET_PRODUCTS; index += 1) {
      const category = CATEGORIES[index % CATEGORIES.length]!;
      const subs = SUBCATEGORIES[category.slug] ?? [];
      const subName = subs.length > 0 ? subs[index % subs.length]! : null;
      const brandName = pick(CATEGORY_BRANDS[category.slug] ?? BRANDS.slice(0, 5));
      const adjective = pick(ADJECTIVES);

      const name = `${adjective} ${brandName} ${subName ?? category.name} ${index + 1}`;
      const slug = `${PREFIX}-p${index + 1}`;
      const [minPrice, maxPrice] = PRICE_BANDS[category.slug]!;
      const basePrice = between(minPrice, maxPrice);
      // Roughly a third carry a discount, so the discount facet has content.
      const hasDiscount = random() < 0.35;
      const compareAt = hasDiscount ? Math.round(basePrice * (1.1 + random() * 0.4)) : null;
      // A deliberate spread of stock states: in stock, low stock, and out.
      const stockRoll = random();
      const stockQuantity = stockRoll < 0.15 ? 0 : stockRoll < 0.35 ? between(1, 3) : between(4, 60);
      const ratingAverage = Math.round((3 + random() * 2) * 10) / 10;
      const ratingCount = between(0, 500);

      const productRow = await client.query(
        `INSERT INTO products (
           name, slug, short_description, description, product_type, status, visibility,
           base_price, compare_at_price, brand_id, category_id, subcategory_id,
           stock_quantity, low_stock_threshold, rating_average, rating_count, published_at
         )
         VALUES ($1,$2,$3,$4,'OTHER','ACTIVE','PUBLIC',$5,$6,$7,$8,$9,$10,3,$11,$12, now())
         ON CONFLICT (slug) DO UPDATE SET
           name = EXCLUDED.name,
           base_price = EXCLUDED.base_price,
           compare_at_price = EXCLUDED.compare_at_price,
           stock_quantity = EXCLUDED.stock_quantity,
           rating_average = EXCLUDED.rating_average,
           rating_count = EXCLUDED.rating_count
         RETURNING id`,
        [
          name,
          slug,
          `${adjective} ${subName ?? category.name.toLowerCase()} from ${brandName}.`,
          `${name}. Seeded for search testing — searchable by name, brand, category, attribute, SKU, and barcode.`,
          basePrice,
          compareAt,
          brandIds.get(brandName) ?? null,
          categoryIds.get(category.slug) ?? null,
          subName ? subcategoryIds.get(`${category.slug}:${subName}`) ?? null : null,
          stockQuantity,
          ratingAverage,
          ratingCount,
        ],
      );
      const productId = productRow.rows[0].id;
      created += 1;

      // ── Variants: every axis combination would explode, so seed a sample.
      const axes = AXES[category.slug] ?? [];
      const variantAxis = axes.find((axis) => axis.code === "size" || axis.code === "storage");
      const colorAxis = axes.find((axis) => axis.code === "color");
      const variantValues = variantAxis ? variantAxis.values.slice(0, 3) : [null];
      const colorValues = colorAxis ? colorAxis.values.slice(0, 2) : [null];

      for (const variantValue of variantValues) {
        for (const colorValue of colorValues) {
          const sku = `${PREFIX}-${String(index + 1).padStart(3, "0")}-${(variantValue ?? "X").replace(/[^A-Za-z0-9]/g, "")}-${(colorValue ?? "X").slice(0, 3).toUpperCase()}`;
          // A realistic barcode shape, so barcode search has something to find.
          const barcode = `890${String(1000000000 + index * 7 + variantsCreated).slice(0, 10)}`;
          // combo_hash must be set, and must match what the app computes:
          // `product_variants_attribute_combo_key` is a unique index over
          // (product_id, combo_hash). Leaving it null would fall through to the
          // legacy (product_id, size, color) index, where every variant of a
          // product looks identical and all but the first are rejected.
          // Format mirrors variantComboHash() in src/lib/catalog/attributes.ts.
          const comboParts = [
            variantAxis && variantValue ? `${variantAxis.code}:${variantValue.toLowerCase()}` : null,
            colorAxis && colorValue ? `${colorAxis.code}:${colorValue.toLowerCase()}` : null,
          ]
            .filter((part): part is string => part !== null)
            .sort();
          const comboHash = comboParts.join("|") || "standard";

          const variantRow = await client.query(
            `INSERT INTO product_variants (
               product_id, sku, name, price, availability, stock_quantity, reserved_quantity,
               barcode, is_active, position, combo_hash
             )
             VALUES ($1,$2,$3,$4,$5,$6,0,$7,true,$8,$9)
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [
              productId,
              sku,
              [variantValue, colorValue].filter(Boolean).join(" ") || "Standard",
              basePrice,
              stockQuantity === 0 ? "OUT_OF_STOCK" : stockQuantity <= 3 ? "LOW_STOCK" : "IN_STOCK",
              stockQuantity,
              barcode,
              variantsCreated,
              comboHash,
            ],
          );
          let variantId = variantRow.rows[0]?.id;
          if (!variantId) {
            // Already present from an earlier run. Without this lookup a re-seed
            // would skip every variant and therefore link no attributes at all.
            const existingVariant = await client.query(
              `SELECT id FROM product_variants WHERE product_id = $1 AND sku = $2`,
              [productId, sku],
            );
            variantId = existingVariant.rows[0]?.id;
          }
          if (!variantId) continue;
          variantsCreated += 1;

          // Opening stock must be a ledger row, not a bare column value — the
          // inventory engine derives stock from the ledger and a mismatch shows
          // up as a permanent integrity error.
          if (stockQuantity > 0) {
            await client.query(
              `INSERT INTO inventory_ledger (
                 product_id, variant_id, previous_quantity, quantity_changed, new_quantity,
                 operation, reference_type, reason
               )
               VALUES ($1,$2,0,$3,$3,'STOCK_IN','PURCHASE_ORDER','Seed data')
               ON CONFLICT DO NOTHING`,
              [productId, variantId, stockQuantity],
            );
          }

          // Variant attributes drive the facet counts.
          // product_id is NOT NULL on variant_attributes — it is denormalized so
          // facet queries can group by product without joining back.
          for (const [axis, value] of [
            [variantAxis, variantValue],
            [colorAxis, colorValue],
          ] as const) {
            if (!axis || !value) continue;
            const optionId = optionIds.get(`${axis.code}:${value}`);
            if (!optionId) continue;
            // value_key is NOT NULL and is the lowercased form used for
            // case-insensitive combo matching and duplicate detection.
            await client.query(
              `INSERT INTO variant_attributes (variant_id, product_id, definition_id, option_id, value_text, value_key)
               VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
              [variantId, productId, definitionIds.get(axis.code), optionId, value, value.toLowerCase()],
            );
          }
        }
      }
    }
    console.log(`  products ✓ (${created})`);
    console.log(`  variants ✓ (${variantsCreated})`);

    // ── Synonyms ───────────────────────────────────────────────────────
    let synonymsCreated = 0;
    for (const [term, synonym, bidirectional] of SYNONYMS) {
      const result = await client.query(
        `INSERT INTO search_synonyms (term, synonym, is_bidirectional, is_active)
         VALUES ($1,$2,$3,true)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [term, synonym, bidirectional],
      );
      if (result.rows[0]) synonymsCreated += 1;
    }
    console.log(`  synonyms ✓ (${synonymsCreated} new)`);
  } finally {
    client.release();
  }

  console.log(
    `\nSeed complete in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.\n` +
      `Next:  npm run search:index  then  npm run search:reindex:derived`,
  );

  console.log("\nTry these searches:");
  console.log('  "laptopp"                  → corrected to "laptop"');
  console.log('  "iphne pro max under 100000" → typo + price constraint');
  console.log('  "nike black shoes"         → brand + colour + category');
  console.log('  "laptop between 30000 and 50000" → price range');
  console.log('  "tee"                      → synonym-expanded to t-shirt');
  console.log('  "zzzzqqqq"                 → zero-result recovery');
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
