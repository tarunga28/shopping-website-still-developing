/**
 * Flexible attribute & variant engine (pure).
 *
 * Parts 1–10 modelled variants with hard-coded `size`/`colour` columns. That
 * cannot express a phone (Storage × Colour) or a poster (Size × Finish) without
 * inventing a new column per product family, so this module models variants as
 * a set of (axis → value) assignments instead:
 *
 *   axis  "size"    → "M"        axis "storage" → "256GB"
 *   axis  "color"   → "Black"    axis "color"   → "Black"
 *
 * A variant is one point in the cartesian product of the axes its product uses.
 * Adding a new axis is a database row, never a schema change, and the legacy
 * `size`/`colour` columns are mirrored from it so existing filters, the PDP
 * selector and POD mapping keep working.
 *
 * Pure and synchronous: no database, so variant generation is unit-testable.
 */

export const MAX_AXES_PER_PRODUCT = 6;
export const MAX_VARIANTS_PER_PRODUCT = 200;
export const ATTRIBUTE_VALUE_MAX_LENGTH = 60;

export interface AttributeAxis {
  /** Canonical code, e.g. "size", "storage". */
  code: string;
  name: string;
  /** Position in the storefront selector; lower renders first. */
  position: number;
  isRequired: boolean;
  /** Only these values are allowed. Empty/undefined = free text. */
  allowedValues?: readonly AttributeOption[];
  allowCustomValues: boolean;
}

export interface AttributeOption {
  slug: string;
  label: string;
  hex?: string | null;
  sortOrder: number;
  numericValue?: number | null;
}

/** One axis assignment on a variant. */
export interface AttributeAssignment {
  code: string;
  /** Canonical value key (lowercased slug). */
  valueKey: string;
  /** Display label. */
  valueLabel: string;
  /** Set when the value came from a curated option rather than free text. */
  optionId?: string | null;
  numericValue?: number | null;
}

export interface VariantBlueprint {
  assignments: AttributeAssignment[];
  /** Optional per-variant overrides from the form; generation leaves them empty. */
  sku?: string;
  name?: string;
  pricePaise?: number | null;
  stockQuantity?: number | null;
}

export interface VariantGenerationResult {
  variants: VariantBlueprint[];
  /** Human-readable problems, empty when the combination set is valid. */
  errors: string[];
}

/* ── Value normalization ─────────────────────────────────────────────── */

/**
 * Canonical form of an attribute value.
 *
 * Matching must be case- and whitespace-insensitive so "BLACK ", "black" and
 * "Black" are the same variant rather than three of them — but the display
 * label keeps whatever the merchant typed.
 */
export function attributeValueKey(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function cleanAttributeValue(value: string): string {
  // Strip control characters and collapse whitespace; never inject markup.
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, ATTRIBUTE_VALUE_MAX_LENGTH);
}

/**
 * Deterministic identity for a variant's attribute set.
 *
 * Axes are sorted by code so `{size:M, color:Black}` and `{color:Black, size:M}`
 * hash identically. This is what the `combo_hash` unique index enforces — the
 * database, not the UI, is what stops two variants claiming the same
 * combination under concurrent requests.
 */
export function variantComboHash(assignments: readonly AttributeAssignment[]): string {
  const sorted = [...assignments]
    .map((assignment) => `${assignment.code}:${assignment.valueKey}`)
    .sort();
  return sorted.join("|");
}

/** Human label, in axis order: "Black / M" or "256GB / Black". */
export function variantLabel(assignments: readonly AttributeAssignment[], axes: readonly AttributeAxis[]): string {
  const ordered = [...axes].sort((a, b) => a.position - b.position);
  const byCode = new Map(assignments.map((assignment) => [assignment.code, assignment]));
  const parts: string[] = [];
  for (const axis of ordered) {
    const assignment = byCode.get(axis.code);
    if (assignment) parts.push(assignment.valueLabel);
  }
  // Include axes the product did not declare, so nothing is silently dropped.
  for (const assignment of assignments) {
    if (!ordered.some((axis) => axis.code === assignment.code)) parts.push(assignment.valueLabel);
  }
  return parts.join(" / ").slice(0, 80) || "Default";
}

/* ── Validation ──────────────────────────────────────────────────────── */

export interface AssignmentValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Validate one variant's assignments against the product's axes.
 *
 * Rejects: missing required axes, unknown axes, values outside a curated list
 * when custom values are disallowed, duplicate axes, and blank values.
 */
export function validateAssignments(
  assignments: readonly AttributeAssignment[],
  axes: readonly AttributeAxis[],
): AssignmentValidation {
  const errors: string[] = [];
  const axisByCode = new Map(axes.map((axis) => [axis.code, axis]));
  const seen = new Set<string>();

  for (const assignment of assignments) {
    const axis = axisByCode.get(assignment.code);
    if (!axis) {
      errors.push(`"${assignment.code}" is not an attribute of this product.`);
      continue;
    }
    if (seen.has(assignment.code)) {
      errors.push(`"${axis.name}" is set more than once on the same variant.`);
      continue;
    }
    seen.add(assignment.code);

    const value = cleanAttributeValue(assignment.valueLabel);
    if (!value) {
      errors.push(`${axis.name} cannot be blank.`);
      continue;
    }
    const allowed = axis.allowedValues ?? [];
    if (allowed.length > 0 && !axis.allowCustomValues) {
      const match = allowed.find((option) => option.slug === attributeValueKey(value));
      if (!match) {
        errors.push(
          `${axis.name} "${value}" is not one of: ${allowed.map((option) => option.label).join(", ")}.`,
        );
      }
    }
  }

  for (const axis of axes) {
    if (axis.isRequired && !seen.has(axis.code)) {
      errors.push(`${axis.name} is required for every variant.`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Duplicate combination detector — returns the combo hashes that repeat. */
export function duplicateCombinations(blueprints: readonly VariantBlueprint[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const blueprint of blueprints) {
    const hash = variantComboHash(blueprint.assignments);
    if (seen.has(hash)) duplicates.add(hash);
    seen.add(hash);
  }
  return [...duplicates];
}

/* ── Generation ──────────────────────────────────────────────────────── */

/**
 * Cartesian product of the selected option values, one variant per combination.
 *
 * `selections` maps axis code → the value keys the merchant ticked. Axes with
 * no selection are skipped, so a product with a single axis (shoe sizes) still
 * generates correctly.
 *
 * Guarded by MAX_VARIANTS_PER_PRODUCT: an unbounded product of six axes with
 * twenty options each is 64 million rows, which is a user error, not a feature.
 */
export function generateVariants(
  axes: readonly AttributeAxis[],
  selections: Readonly<Record<string, readonly string[]>>,
): VariantGenerationResult {
  const errors: string[] = [];
  const activeAxes = [...axes]
    .filter((axis) => (selections[axis.code]?.length ?? 0) > 0)
    .sort((a, b) => a.position - b.position);

  if (activeAxes.length === 0) {
    return { variants: [], errors: ["Select at least one value for an attribute before generating variants."] };
  }

  // Resolve each selected key to an option so labels and sort order come from
  // the curated list rather than whatever the form submitted.
  const perAxis: { axis: AttributeAxis; values: { key: string; label: string; optionId: string | null }[] }[] = [];
  for (const axis of activeAxes) {
    const allowed = axis.allowedValues ?? [];
    const values = (selections[axis.code] ?? []).map((key) => {
      const option = allowed.find((candidate) => candidate.slug === attributeValueKey(key));
      if (!option && allowed.length > 0 && !axis.allowCustomValues) {
        errors.push(`${axis.name}: "${key}" is not an allowed value.`);
        return null;
      }
      return { key: attributeValueKey(key), label: option?.label ?? cleanAttributeValue(key), optionId: option?.slug ?? null };
    });
    const resolved = values.filter((value): value is { key: string; label: string; optionId: string | null } => value !== null);
    // Deduplicate selections so "M" ticked twice cannot create two variants.
    const unique = [...new Map(resolved.map((value) => [value.key, value])).values()];
    if (unique.length === 0) return { variants: [], errors: [...errors, `${axis.name} has no valid values selected.`] };
    perAxis.push({ axis, values: unique });
  }
  if (errors.length > 0) return { variants: [], errors };

  const total = perAxis.reduce((product, entry) => product * entry.values.length, 1);
  if (total > MAX_VARIANTS_PER_PRODUCT) {
    return {
      variants: [],
      errors: [
        `That combination creates ${total.toLocaleString("en-IN")} variants. The limit is ${MAX_VARIANTS_PER_PRODUCT} — split this into separate products.`,
      ],
    };
  }

  const variants: VariantBlueprint[] = [];
  const walk = (index: number, current: AttributeAssignment[]) => {
    if (index === perAxis.length) {
      variants.push({ assignments: [...current] });
      return;
    }
    const { axis, values } = perAxis[index];
    for (const value of values) {
      const assignment: AttributeAssignment = {
        code: axis.code,
        valueKey: value.key,
        valueLabel: value.label,
        optionId: value.optionId,
      };
      walk(index + 1, [...current, assignment]);
    }
  };
  walk(0, []);

  for (const variant of variants) variant.name = variantLabel(variant.assignments, activeAxes);

  return { variants, errors };
}

/**
 * Merge form edits back onto generated variants.
 *
 * Generation is deterministic, so a variant the merchant already priced keeps
 * its price when they tick one more size — matched by combo hash, not by
 * position, which would silently shift prices onto the wrong variants.
 */
export function mergeVariantEdits(
  generated: readonly VariantBlueprint[],
  existing: readonly VariantBlueprint[],
): VariantBlueprint[] {
  const byHash = new Map(existing.map((blueprint) => [variantComboHash(blueprint.assignments), blueprint]));
  return generated.map((blueprint) => {
    const previous = byHash.get(variantComboHash(blueprint.assignments));
    if (!previous) return blueprint;
    return {
      ...blueprint,
      sku: previous.sku ?? blueprint.sku,
      name: previous.name ?? blueprint.name,
      pricePaise: previous.pricePaise ?? blueprint.pricePaise,
      stockQuantity: previous.stockQuantity ?? blueprint.stockQuantity,
    };
  });
}

/** Legacy mirror: the size/colour columns still read by filters and POD mapping. */
export function legacySizeColor(
  assignments: readonly AttributeAssignment[],
): { size: string | null; color: string | null; colorCode: string | null } {
  const byCode = new Map(assignments.map((assignment) => [assignment.code, assignment]));
  return {
    size: byCode.get("size")?.valueLabel ?? null,
    color: byCode.get("color")?.valueLabel ?? null,
    colorCode: null,
  };
}

/** Suggested SKU fragment from a combination: "M-BLACK", "256GB-BLACK". */
export function skuFragment(assignments: readonly AttributeAssignment[], separator = "-"): string {
  return assignments
    .map((assignment) => assignment.valueKey.toUpperCase().replace(/[^A-Z0-9]+/g, ""))
    .filter(Boolean)
    .join(separator)
    .slice(0, 40);
}

/**
 * Deterministic SKU for a generated variant.
 *
 * A stable rule matters: importing the same catalog twice must produce the same
 * SKUs, otherwise the second import looks like 100,000 new products.
 */
export function derivedSku(prefix: string, assignments: readonly AttributeAssignment[]): string {
  const cleanPrefix = prefix.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20) || "SKU";
  const fragment = skuFragment(assignments);
  return fragment ? `${cleanPrefix}-${fragment}`.slice(0, 64) : cleanPrefix.slice(0, 64);
}
