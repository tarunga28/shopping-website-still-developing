import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  attributeDefinitions,
  attributeOptions,
  inventoryLedger,
  productAttributeAxes,
  products,
  productVariants,
  variantAttributes,
} from "@/db/schema";
import { withTransaction, type DbClient, type DbTx } from "@/db/utils";
import {
  cleanAttributeValue,
  attributeValueKey,
  derivedSku,
  generateVariants,
  legacySizeColor,
  mergeVariantEdits,
  variantComboHash,
  variantLabel,
  type AttributeAssignment,
  type VariantBlueprint,
} from "@/lib/catalog/attributes";
import { deriveAvailability } from "@/lib/catalog/inventory";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { assertCompareAt, parseInrToPaise } from "@/lib/catalog-rules";
import { emitCatalogEvents } from "@/services/catalog/events.service";
import { adjustInventory } from "@/services/catalog/inventory.service";
import { invalidateCatalogCache } from "@/lib/catalog/cache";

/**
 * Variant engine.
 *
 * A variant is the purchasable unit: one point in the cartesian product of the
 * attribute axes its product uses. This module is the only writer of
 * `product_variants`, `variant_attributes` and the variant rows in the legacy
 * `size`/`colour` columns, so:
 *
 *   • the attribute set and the combo hash always agree;
 *   • a variant never exists without its ledger history — opening stock is
 *     recorded as a STOCK_IN, which is what makes `verifyInventoryIntegrity`
 *     meaningful (a row whose balance came from nowhere would fail a replay);
 *   • every write emits VARIANT_CREATED / VARIANT_UPDATED for downstream
 *     consumers.
 */

export interface VariantActor {
  id: string | null;
}

export interface VariantAxis {
  id: string;
  code: string;
  name: string;
  position: number;
  isRequired: boolean;
  allowCustomValues: boolean;
  isSwatch: boolean;
  options: { id: string; slug: string; label: string; hex: string | null; sortOrder: number }[];
}

export interface VariantWithAttributes {
  id: string;
  sku: string;
  name: string;
  price: number;
  compareAtPrice: number | null;
  costPrice: number | null;
  barcode: string | null;
  stockQuantity: number;
  reservedQuantity: number;
  availability: string;
  isActive: boolean;
  position: number;
  size: string | null;
  color: string | null;
  attributes: AttributeAssignment[];
}

/* ── Axis loading ────────────────────────────────────────────────────── */

/** Axes a product has opted into, with their curated options, in render order. */
export async function getProductAxes(productId: string, client: DbClient = db): Promise<VariantAxis[]> {
  const rows = await client
    .select({
      id: attributeDefinitions.id,
      code: attributeDefinitions.code,
      name: attributeDefinitions.name,
      position: productAttributeAxes.position,
      isRequired: productAttributeAxes.isRequired,
      allowCustomValues: attributeDefinitions.allowCustomValues,
      isSwatch: attributeDefinitions.isSwatch,
      valueType: attributeDefinitions.valueType,
    })
    .from(productAttributeAxes)
    .innerJoin(attributeDefinitions, eq(attributeDefinitions.id, productAttributeAxes.definitionId))
    .where(and(eq(productAttributeAxes.productId, productId), eq(attributeDefinitions.isActive, true)))
    .orderBy(asc(productAttributeAxes.position));

  if (rows.length === 0) return [];

  const optionRows = await client
    .select({
      definitionId: attributeOptions.definitionId,
      id: attributeOptions.id,
      slug: attributeOptions.slug,
      label: attributeOptions.label,
      hex: attributeOptions.hex,
      sortOrder: attributeOptions.sortOrder,
    })
    .from(attributeOptions)
    .where(and(inArray(attributeOptions.definitionId, rows.map((row) => row.id)), eq(attributeOptions.isActive, true)))
    .orderBy(asc(attributeOptions.sortOrder), asc(attributeOptions.label));

  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    position: row.position,
    isRequired: row.isRequired,
    allowCustomValues: row.allowCustomValues,
    isSwatch: row.isSwatch,
    options: optionRows
      .filter((option) => option.definitionId === row.id)
      .map((option) => ({ id: option.id, slug: option.slug, label: option.label, hex: option.hex, sortOrder: option.sortOrder })),
  }));
}

/** Every axis defined in the catalog, for the product-creation form. */
export async function listVariantAxes(client: DbClient = db): Promise<VariantAxis[]> {
  const rows = await client
    .select({
      id: attributeDefinitions.id,
      code: attributeDefinitions.code,
      name: attributeDefinitions.name,
      position: attributeDefinitions.displayOrder,
      isRequired: attributeDefinitions.isRequired,
      allowCustomValues: attributeDefinitions.allowCustomValues,
      isSwatch: attributeDefinitions.isSwatch,
    })
    .from(attributeDefinitions)
    .where(and(eq(attributeDefinitions.isActive, true), eq(attributeDefinitions.isVariantAxis, true)))
    .orderBy(asc(attributeDefinitions.displayOrder), asc(attributeDefinitions.name));
  return rows.map((row) => ({ ...row, options: [] }));
}

/* ── Reads ───────────────────────────────────────────────────────────── */

export async function listVariants(productId: string, client: DbClient = db): Promise<VariantWithAttributes[]> {
  const rows = await client
    .select()
    .from(productVariants)
    .where(eq(productVariants.productId, productId))
    .orderBy(asc(productVariants.position), asc(productVariants.name));
  if (rows.length === 0) return [];

  const attributeRows = await client
    .select({
      variantId: variantAttributes.variantId,
      code: attributeDefinitions.code,
      valueKey: variantAttributes.valueKey,
      valueText: variantAttributes.valueText,
      optionId: variantAttributes.optionId,
    })
    .from(variantAttributes)
    .innerJoin(attributeDefinitions, eq(attributeDefinitions.id, variantAttributes.definitionId))
    .where(eq(variantAttributes.productId, productId))
    .orderBy(asc(attributeDefinitions.displayOrder));

  const byVariant = new Map<string, AttributeAssignment[]>();
  for (const row of attributeRows) {
    const list = byVariant.get(row.variantId) ?? [];
    list.push({ code: row.code, valueKey: row.valueKey, valueLabel: row.valueText, optionId: row.optionId });
    byVariant.set(row.variantId, list);
  }

  return rows.map((row) => ({
    id: row.id,
    sku: row.sku,
    name: row.name,
    price: row.price,
    compareAtPrice: row.compareAtPrice,
    costPrice: row.costPrice,
    barcode: row.barcode,
    stockQuantity: row.stockQuantity,
    reservedQuantity: row.reservedQuantity,
    availability: row.availability,
    isActive: row.isActive,
    position: row.position,
    size: row.size,
    color: row.color,
    attributes: byVariant.get(row.id) ?? [],
  }));
}

/* ── Writes ──────────────────────────────────────────────────────────── */

export interface CreateVariantInput {
  sku: string;
  name?: string;
  price: string | number;
  compareAt?: string | number | null;
  costPrice?: string | number | null;
  barcode?: string | null;
  /** Opening stock. Recorded as a STOCK_IN so the ledger explains the balance. */
  stockQuantity?: number;
  assignments: AttributeAssignment[];
  position?: number;
}

/**
 * Create a variant with its attribute rows, legacy size/colour mirror, combo
 * hash and opening stock ledger entry — all in one transaction.
 */
export async function createVariant(
  actor: VariantActor,
  productId: string,
  input: CreateVariantInput,
  options: { invalidateCache?: boolean } = {},
): Promise<{ id: string; sku: string }> {
  const created = await withTransaction(async (tx) => {
    const [product] = await tx
      .select({ id: products.id, lowStockThreshold: products.lowStockThreshold })
      .from(products)
      .where(eq(products.id, productId));
    if (!product) throw new NotFoundError("That product does not exist.");

    const pricePaise = parseInrToPaise(input.price);
    const compareAtPaise = input.compareAt ? parseInrToPaise(input.compareAt) : null;
    const costPaise = input.costPrice ? parseInrToPaise(input.costPrice) : null;
    try {
      assertCompareAt(pricePaise, compareAtPaise);
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : "Price is invalid.");
    }

    const sku = input.sku.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]*$/.test(sku) || sku.length > 64) {
      throw new ValidationError("SKU must be uppercase letters, numbers and hyphens, up to 64 characters.");
    }

    const assignments = normalizeAssignments(input.assignments);
    const comboHash = variantComboHash(assignments);
    const legacy = legacySizeColor(assignments);
    const openingStock = Math.max(0, Math.trunc(input.stockQuantity ?? 0));

    const [row] = await tx
      .insert(productVariants)
      .values({
        productId,
        sku,
        name: input.name?.trim() || variantLabel(assignments, []) || sku,
        price: pricePaise,
        compareAtPrice: compareAtPaise,
        costPrice: costPaise,
        barcode: input.barcode?.trim() || null,
        stockQuantity: openingStock,
        availability: deriveAvailability({
          stockQuantity: openingStock,
          reservedQuantity: 0,
          lowStockThreshold: product.lowStockThreshold,
        }),
        size: legacy.size,
        color: legacy.color,
        comboHash,
        position: input.position ?? 0,
      })
      .returning({ id: productVariants.id });
    if (!row) throw new ValidationError("The variant could not be created.");

    await writeAttributeRows(tx, row.id, productId, assignments);

    // Opening stock is a real movement: without it the ledger cannot explain
    // the balance, and an integrity replay would report a mismatch.
    if (openingStock > 0) {
      await tx.insert(inventoryLedger).values({
        productId,
        variantId: row.id,
        previousQuantity: 0,
        quantityChanged: openingStock,
        newQuantity: openingStock,
        operation: "STOCK_IN",
        referenceType: "MANUAL",
        reason: "Opening stock",
        actorId: actor.id,
      });
    }

    await emitCatalogEvents(tx, [
      {
        eventType: "VARIANT_CREATED",
        aggregateType: "variant",
        aggregateId: row.id,
        actorId: actor.id,
        payload: { productId, sku, attributes: assignments, openingStock },
      },
      {
        eventType: "PRODUCT_UPDATED",
        aggregateType: "product",
        aggregateId: productId,
        actorId: actor.id,
        payload: { reason: "variant_created", sku },
      },
    ]);

    return { id: row.id, sku };
  });

  // The storefront listing derives availability and orderable counts from
  // variant rows and is cached under the `catalog` tag, so a new variant has to
  // expire it — otherwise the listing keeps serving the old counts until the
  // TTL lapses. Invalidated after the commit: expiring before would let a
  // concurrent read repopulate the cache from pre-commit data.
  //
  // Callers that batch (see `generateProductVariants`) suppress this and expire
  // once for the whole batch.
  if (options.invalidateCache !== false) invalidateCatalogCache();

  return created;
}

function normalizeAssignments(assignments: readonly AttributeAssignment[]): AttributeAssignment[] {
  const seen = new Map<string, AttributeAssignment>();
  for (const assignment of assignments) {
    const label = cleanAttributeValue(assignment.valueLabel);
    if (!label) continue;
    seen.set(assignment.code, {
      code: assignment.code,
      valueKey: attributeValueKey(label),
      valueLabel: label,
      optionId: assignment.optionId ?? null,
      numericValue: assignment.numericValue ?? null,
    });
  }
  return [...seen.values()];
}

async function writeAttributeRows(
  tx: DbTx,
  variantId: string,
  productId: string,
  assignments: readonly AttributeAssignment[],
): Promise<void> {
  if (assignments.length === 0) return;
  const definitions = await tx
    .select({ id: attributeDefinitions.id, code: attributeDefinitions.code })
    .from(attributeDefinitions);
  const byCode = new Map(definitions.map((definition) => [definition.code, definition.id]));

  const values = assignments
    .filter((assignment) => byCode.has(assignment.code))
    .map((assignment) => ({
      variantId,
      productId,
      definitionId: byCode.get(assignment.code)!,
      optionId: assignment.optionId ?? null,
      valueText: assignment.valueLabel,
      valueKey: assignment.valueKey,
      valueNumeric:
        assignment.numericValue != null ? sql`(${assignment.numericValue})::numeric(18,4)` : null,
    }));
  if (values.length === 0) return;

  await tx.insert(variantAttributes).values(values).onConflictDoUpdate({
    target: [variantAttributes.variantId, variantAttributes.definitionId],
    set: { valueText: sql`excluded.value_text`, valueKey: sql`excluded.value_key`, optionId: sql`excluded.option_id` },
  });
}

/* ── Generation ──────────────────────────────────────────────────────── */

export interface GenerateInput {
  /** axis code → selected value keys. */
  selections: Record<string, string[]>;
  skuPrefix: string;
  price?: string | number | null;
  /** Existing variants, so a regeneration keeps prices the merchant already set. */
  preserveFrom?: readonly VariantWithAttributes[];
  /** When true, variants no longer in the selection are retired. */
  retireMissing?: boolean;
}

export interface GenerateResult {
  created: { id: string; sku: string }[];
  matchedExisting: number;
  retired: string[];
  errors: string[];
}

/**
 * Generate (or reconcile) the full variant set for a product from its axes.
 *
 * Matching is by combo hash, so ticking one extra size creates one new variant
 * and leaves the priced ones untouched. Re-running the same generation is a
 * no-op — which is what makes a bulk re-import safe.
 */
export async function generateProductVariants(
  actor: VariantActor,
  productId: string,
  input: GenerateInput,
): Promise<GenerateResult> {
  const axes = await getProductAxes(productId);
  if (axes.length === 0) {
    throw new ValidationError("Add at least one attribute to this product before generating variants.");
  }

  const plan = generateVariants(
    axes.map((axis) => ({
      code: axis.code,
      name: axis.name,
      position: axis.position,
      isRequired: axis.isRequired,
      allowCustomValues: axis.allowCustomValues,
      allowedValues: axis.options.map((option) => ({
        slug: option.slug,
        label: option.label,
        hex: option.hex,
        sortOrder: option.sortOrder,
      })),
    })),
    input.selections,
  );
  if (plan.errors.length > 0) throw new ValidationError(plan.errors.join(" "));

  const existing = input.preserveFrom ?? (await listVariants(productId));
  const existingByHash = new Map(existing.map((variant) => [variantComboHash(variant.attributes), variant]));
  const pricePaise = input.price ? parseInrToPaise(input.price) : null;

  const blueprints: VariantBlueprint[] = plan.variants.map((blueprint) => ({
    ...blueprint,
    sku: derivedSku(input.skuPrefix, blueprint.assignments),
    pricePaise,
  }));
  const merged = mergeVariantEdits(
    blueprints,
    existing.map((variant) => ({
      assignments: variant.attributes,
      sku: variant.sku,
      name: variant.name,
      pricePaise: variant.price,
      stockQuantity: variant.stockQuantity,
    })),
  );

  const created: { id: string; sku: string }[] = [];
  let matchedExisting = 0;
  const wantedHashes = new Set<string>();

  for (const blueprint of merged) {
    const hash = variantComboHash(blueprint.assignments);
    wantedHashes.add(hash);
    const existingVariant = existingByHash.get(hash);
    if (existingVariant) {
      matchedExisting += 1;
      continue;
    }
    const result = await createVariant(
      actor,
      productId,
      {
        sku: blueprint.sku ?? derivedSku(input.skuPrefix, blueprint.assignments),
        name: blueprint.name,
        price: blueprint.pricePaise ?? pricePaise ?? 0,
        assignments: blueprint.assignments,
      },
      // Expired once for the whole batch below, not once per variant.
      { invalidateCache: false },
    );
    created.push(result);
  }

  const retired: string[] = [];
  if (input.retireMissing) {
    for (const variant of existing) {
      if (wantedHashes.has(variantComboHash(variant.attributes))) continue;
      if (!variant.isActive) continue;
      await retireVariant(actor, productId, variant.id, { invalidateCache: false });
      retired.push(variant.id);
    }
  }

  if (created.length > 0 || retired.length > 0) invalidateCatalogCache();

  return { created, matchedExisting, retired, errors: [] };
}

/**
 * Retire a variant.
 *
 * Never deletes: order history references the row, and a hard delete would turn
 * past orders into broken foreign keys. The variant simply leaves the
 * storefront.
 */
export async function retireVariant(
  actor: VariantActor,
  productId: string,
  variantId: string,
  options: { invalidateCache?: boolean } = {},
): Promise<void> {
  await withTransaction(async (tx) => {
    const [variant] = await tx
      .select({ id: productVariants.id, sku: productVariants.sku })
      .from(productVariants)
      .where(and(eq(productVariants.id, variantId), eq(productVariants.productId, productId)));
    if (!variant) throw new NotFoundError("That variant does not exist on this product.");

    await tx
      .update(productVariants)
      .set({ isActive: false, availability: "OUT_OF_STOCK", updatedAt: new Date() })
      .where(eq(productVariants.id, variantId));

    await emitCatalogEvents(tx, [
      {
        eventType: "VARIANT_RETIRED",
        aggregateType: "variant",
        aggregateId: variantId,
        actorId: actor.id,
        payload: { productId, sku: variant.sku },
      },
    ]);
  });

  // Retiring sets the variant OUT_OF_STOCK and inactive, which changes the
  // listing's orderable count — same expiry requirement as creation.
  if (options.invalidateCache !== false) invalidateCatalogCache();
}

/* ── Attribute definitions (admin) ───────────────────────────────────── */

export interface AttributeDefinitionInput {
  code: string;
  name: string;
  valueType?: "TEXT" | "NUMBER" | "BOOLEAN" | "COLOR" | "ENUM";
  isVariantAxis?: boolean;
  isRequired?: boolean;
  allowCustomValues?: boolean;
  isSwatch?: boolean;
  displayOrder?: number;
  options?: { slug: string; label: string; hex?: string | null; sortOrder?: number }[];
}

/**
 * Create or update an attribute axis.
 *
 * This is how "Storage" or "Fit" is added to the platform: a row here, not a
 * schema migration and not a new column on `product_variants`.
 */
export async function upsertAttributeDefinition(
  input: AttributeDefinitionInput,
  client: DbClient = db,
): Promise<{ id: string; code: string }> {
  const code = input.code.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(code)) {
    throw new ValidationError("Attribute code must be lowercase letters, digits and underscores, 2–40 characters.");
  }
  const name = input.name.trim();
  if (name.length < 2) throw new ValidationError("Attribute name needs at least 2 characters.");

  const [row] = await client
    .insert(attributeDefinitions)
    .values({
      code,
      name,
      valueType: input.valueType ?? "TEXT",
      isVariantAxis: input.isVariantAxis ?? false,
      isRequired: input.isRequired ?? false,
      allowCustomValues: input.allowCustomValues ?? true,
      isSwatch: input.isSwatch ?? false,
      displayOrder: input.displayOrder ?? 0,
    })
    .onConflictDoUpdate({
      target: attributeDefinitions.code,
      set: {
        name,
        valueType: input.valueType ?? "TEXT",
        isVariantAxis: input.isVariantAxis ?? false,
        isRequired: input.isRequired ?? false,
        allowCustomValues: input.allowCustomValues ?? true,
        isSwatch: input.isSwatch ?? false,
        displayOrder: input.displayOrder ?? 0,
        updatedAt: new Date(),
      },
    })
    .returning({ id: attributeDefinitions.id });
  if (!row) throw new ValidationError("The attribute could not be saved.");

  for (const option of input.options ?? []) {
    const optionSlug = option.slug.trim().toLowerCase();
    const label = option.label.trim();
    if (!optionSlug || !label) continue;
    await client
      .insert(attributeOptions)
      .values({
        definitionId: row.id,
        slug: optionSlug,
        label,
        hex: option.hex ?? null,
        sortOrder: option.sortOrder ?? 0,
      })
      .onConflictDoUpdate({
        target: [attributeOptions.definitionId, attributeOptions.slug],
        set: { label, hex: option.hex ?? null, sortOrder: option.sortOrder ?? 0, updatedAt: new Date() },
      });
  }

  return { id: row.id, code };
}

/** Attach axes to a product, in order. Replaces the previous set. */
export async function setProductAxes(
  productId: string,
  axisCodes: readonly string[],
  client: DbClient = db,
): Promise<{ count: number }> {
  const definitions = await client
    .select({ id: attributeDefinitions.id, code: attributeDefinitions.code })
    .from(attributeDefinitions)
    .where(inArray(attributeDefinitions.code, [...axisCodes]));
  const byCode = new Map(definitions.map((definition) => [definition.code, definition.id]));

  const missing = axisCodes.filter((code) => !byCode.has(code));
  if (missing.length > 0) throw new ValidationError(`Unknown attribute(s): ${missing.join(", ")}.`);

  await withTransaction(async (tx) => {
    await tx.delete(productAttributeAxes).where(eq(productAttributeAxes.productId, productId));
    const values = axisCodes.map((code, index) => ({
      productId,
      definitionId: byCode.get(code)!,
      position: index,
      isRequired: true,
    }));
    if (values.length > 0) await tx.insert(productAttributeAxes).values(values);
  });
  return { count: axisCodes.length };
}
