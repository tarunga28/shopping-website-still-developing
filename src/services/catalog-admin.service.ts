import "server-only";
import { randomBytes } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { invalidateCatalogCache } from "@/lib/catalog/cache";
import {
  categories,
  categorySlugHistory,
  collections,
  collectionSlugHistory,
  colors,
  designs,
  images,
  orderItems,
  podProductMappings,
  podProviders,
  podVariantMappings,
  productCategories,
  productCollections,
  productDesigns,
  productSlugHistory,
  products,
  productTags,
  productVariants,
  reviews,
  sizeCharts,
  sizeProductTypes,
  sizes,
  tags,
} from "@/db/schema";
import { withTransaction, type DbClient } from "@/db/utils";
import { locationForChild, relocateCategory } from "@/services/catalog/category.service";
import { hasProductDetails, type ProductDetails } from "@/lib/catalog/product-details";
import { sizeChartSchema } from "@/lib/catalog/size-chart";
import { inspectProductImage } from "@/lib/image-file";
import {
  assertCompareAt,
  assertHex,
  assertSchedule,
  assertSlug,
  assertVariantForType,
  bulkPhrase,
  canArchiveCategory,
  canEditCatalog,
  DEFAULT_COLORS,
  duplicateSku,
  duplicateVariantCombos,
  parseInrToPaise,
  planSlugChange,
  publishBlockers,
  SIZE_CATALOG,
  slugFromName,
  tagSlug,
  wouldCreateCategoryCycle,
  isProductType,
  type CatalogProductType,
  type SizeRule,
} from "@/lib/catalog-rules";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/services/audit.service";
import type {
  BulkInput,
  CategoryWriteInput,
  CollectionWriteInput,
  ProductWriteInput,
  VariantWriteInput,
} from "@/validations/catalog";

export interface CatalogActor {
  id: string;
  role: string;
  ip?: string;
  userAgent?: string;
}

const IMAGE_ROLES = ["PRIMARY", "GALLERY", "HOVER", "THUMBNAIL", "MOBILE", "SOCIAL"] as const;
type ImageRole = (typeof IMAGE_ROLES)[number];

function assertEditor(actor: CatalogActor) {
  if (!canEditCatalog(actor.role)) {
    throw new ForbiddenError("You don't have permission to manage the catalog.");
  }
}

function rule(work: () => void) {
  try {
    work();
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : "Invalid catalog value.");
  }
}

function empty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function optionalPaise(value: string | null | undefined): number | null {
  if (!value?.trim()) return null;
  try {
    return parseInrToPaise(value);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : "Invalid price.");
  }
}

function requiredPaise(value: string): number {
  try {
    return parseInrToPaise(value);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : "Invalid price.");
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error && "code" in error) return String((error as { code: unknown }).code);
  if (typeof error === "object" && error && "cause" in error) return errorCode((error as { cause: unknown }).cause);
  return null;
}

function rethrowUnique(error: unknown): never {
  if (errorCode(error) === "23505") {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("sku")) throw new ValidationError("That SKU is already used.");
    if (message.includes("combo")) throw new ValidationError("That size and color combination already exists.");
    if (message.includes("slug")) throw new ValidationError("That slug is already used.");
    throw new ValidationError("That value is already used.");
  }
  throw error;
}

async function audit(actor: CatalogActor, action: string, entityType: string, entityId: string, metadata?: Record<string, unknown>) {
  // Every catalog write ends here, so this is where the public cache is expired:
  // price, status, category, collection, image and content changes reach the
  // storefront on the next request instead of waiting for the TTL.
  invalidateCatalogCache();
  await writeAudit({
    action,
    entityType,
    entityId,
    actorId: actor.id,
    metadata,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}

async function loadSizeRules(client: DbClient): Promise<SizeRule[]> {
  const rows = await client
    .select({ code: sizes.code, label: sizes.label, productType: sizeProductTypes.productType })
    .from(sizes)
    .innerJoin(sizeProductTypes, eq(sizeProductTypes.sizeId, sizes.id))
    .where(eq(sizes.isActive, true));
  if (rows.length === 0) return [...SIZE_CATALOG];
  const byCode = new Map<string, SizeRule>();
  for (const row of rows) {
    const current = byCode.get(row.code) ?? { code: row.code, label: row.label, productTypes: [] };
    current.productTypes = [...current.productTypes, row.productType];
    byCode.set(row.code, current);
  }
  return [...byCode.values()];
}

async function assertKnownColor(client: DbClient, name: string | null): Promise<{ color: string | null; colorCode: string | null }> {
  if (!name) return { color: null, colorCode: null };
  const slug = tagSlug(name);
  const [row] = await client.select().from(colors).where(eq(colors.slug, slug)).limit(1);
  if (!row || !row.isActive) throw new ValidationError("Choose a color from the color catalog.");
  return { color: row.name, colorCode: row.hex };
}

async function allocateSlug(client: DbClient, desired: string, exceptId?: string, custom = false): Promise<string> {
  let candidate = desired;
  for (let attempt = 2; attempt < 40; attempt += 1) {
    const [product] = await client.select({ id: products.id }).from(products).where(eq(products.slug, candidate)).limit(1);
    const [history] = await client
      .select({ productId: productSlugHistory.productId })
      .from(productSlugHistory)
      .where(eq(productSlugHistory.slug, candidate))
      .limit(1);
    const productTaken = Boolean(product && product.id !== exceptId);
    const historyTaken = Boolean(history && history.productId !== exceptId);
    if (!productTaken && !historyTaken) {
      if (history && exceptId && history.productId === exceptId) {
        await client
          .delete(productSlugHistory)
          .where(and(eq(productSlugHistory.slug, candidate), eq(productSlugHistory.productId, exceptId)));
      }
      return candidate;
    }
    if (custom) throw new ValidationError("That slug is already used. Old public links are reserved.");
    candidate = `${desired}-${attempt}`.slice(0, 80).replace(/-+$/g, "");
  }
  throw new ValidationError("Could not allocate a unique slug.");
}

async function syncCategories(client: DbClient, productId: string, categoryIds: string[], primaryId: string | null) {
  const unique = [...new Set(categoryIds)];
  if (unique.length) {
    const found = await client.select({ id: categories.id }).from(categories).where(inArray(categories.id, unique));
    if (found.length !== unique.length) throw new ValidationError("One of the categories does not exist.");
  }
  await client.delete(productCategories).where(eq(productCategories.productId, productId));
  if (unique.length === 0) return;
  const primary = primaryId && unique.includes(primaryId) ? primaryId : unique[0]!;
  await client.insert(productCategories).values(
    unique.map((categoryId) => ({ productId, categoryId, isPrimary: categoryId === primary })),
  );
}

async function syncCollections(client: DbClient, productId: string, collectionIds: string[]) {
  const unique = [...new Set(collectionIds)];
  if (unique.length) {
    const found = await client.select({ id: collections.id }).from(collections).where(inArray(collections.id, unique));
    if (found.length !== unique.length) throw new ValidationError("One of the collections does not exist.");
  }
  await client.delete(productCollections).where(eq(productCollections.productId, productId));
  if (unique.length === 0) return;
  await client.insert(productCollections).values(unique.map((collectionId, index) => ({ productId, collectionId, displayOrder: index })));
}

async function syncTags(client: DbClient, productId: string, names: string[]) {
  const slugs = [...new Set(names.map((name) => tagSlug(name)).filter((slug) => slug && slug !== "product"))];
  await client.delete(productTags).where(eq(productTags.productId, productId));
  for (const slug of slugs) {
    const [existing] = await client.select({ id: tags.id }).from(tags).where(eq(tags.slug, slug)).limit(1);
    const tagId =
      existing?.id ??
      (
        await client
          .insert(tags)
          .values({ name: slug.replace(/-/g, " "), slug })
          .returning({ id: tags.id })
      )[0]!.id;
    await client.insert(productTags).values({ productId, tagId });
  }
}

async function syncDesign(client: DbClient, productId: string, designId: string | null, placement: ProductWriteInput["placement"]) {
  await client.delete(productDesigns).where(eq(productDesigns.productId, productId));
  if (!designId) return;
  const [design] = await client.select({ id: designs.id }).from(designs).where(eq(designs.id, designId)).limit(1);
  if (!design) throw new ValidationError("That design does not exist.");
  await client.insert(productDesigns).values({ productId, designId, placement });
}

function pricePair(priceRaw: string, compareRaw: string | null | undefined) {
  const pricePaise = requiredPaise(priceRaw);
  const compareAtPaise = optionalPaise(compareRaw);
  rule(() => assertCompareAt(pricePaise, compareAtPaise));
  return { pricePaise, compareAtPaise };
}

/** Empty copy is stored as NULL so "no details" is one representation. */
function detailsForStorage(details: NonNullable<ProductWriteInput["details"]>): ProductDetails | null {
  return hasProductDetails(details) ? details : null;
}

export async function createProduct(actor: CatalogActor, input: ProductWriteInput): Promise<{ id: string; slug: string }> {
  assertEditor(actor);
  const prices = pricePair(input.basePrice, input.compareAt);
  const shipping = optionalPaise(input.estimatedShipping);
  const fee = optionalPaise(input.estimatedPaymentFee);
  const customSlug = Boolean(input.slug?.trim());
  const desired = customSlug ? input.slug!.trim().toLowerCase() : slugFromName(input.name);
  rule(() => assertSlug(desired));

  const created = await withTransaction(async (tx) => {
    const slug = await allocateSlug(tx, desired, undefined, customSlug);
    const [row] = await tx
      .insert(products)
      .values({
        name: input.name.trim(),
        slug,
        shortDescription: empty(input.shortDescription),
        description: empty(input.description),
        productType: input.productType,
        status: "DRAFT",
        basePrice: prices.pricePaise,
        compareAtPrice: prices.compareAtPaise,
        currency: "INR",
        seoTitle: empty(input.seoTitle),
        seoDescription: empty(input.seoDescription),
        adminNotes: empty(input.adminNotes),
        estimatedShippingPaise: shipping,
        estimatedPaymentFeePaise: fee,
        supplierMappingRequired: input.supplierMappingRequired,
        details: input.details ? detailsForStorage(input.details) : null,
      })
      .returning({ id: products.id, slug: products.slug });
    if (!row) throw new ValidationError("The product could not be created.");
    await syncCategories(tx, row.id, input.categoryIds, empty(input.primaryCategoryId));
    await syncCollections(tx, row.id, input.collectionIds);
    await syncTags(tx, row.id, input.tags);
    await syncDesign(tx, row.id, empty(input.designId), input.placement);
    return row;
  }).catch(rethrowUnique);

  await audit(actor, "product.created", "product", created.id, { slug: created.slug, productType: input.productType });
  return created;
}

async function requireProduct(client: DbClient, id: string) {
  const [row] = await client.select().from(products).where(eq(products.id, id)).limit(1);
  if (!row) throw new NotFoundError("That product does not exist.");
  return row;
}

export async function updateProduct(actor: CatalogActor, id: string, input: ProductWriteInput): Promise<{ slug: string }> {
  assertEditor(actor);
  const prices = pricePair(input.basePrice, input.compareAt);
  const shipping = optionalPaise(input.estimatedShipping);
  const fee = optionalPaise(input.estimatedPaymentFee);
  const desired = input.slug?.trim() ? input.slug.trim().toLowerCase() : slugFromName(input.name);
  rule(() => assertSlug(desired));

  const updated = await withTransaction(async (tx) => {
    const current = await requireProduct(tx, id);
    const custom = Boolean(input.slug?.trim());
    const slug = current.slug === desired ? current.slug : await allocateSlug(tx, desired, id, custom);
    const change = planSlugChange(current.slug, slug);
    if (change.recordPrevious) {
      await tx.insert(productSlugHistory).values({ productId: id, slug: current.slug });
    }
    await tx
      .update(products)
      .set({
        name: input.name.trim(),
        slug,
        shortDescription: empty(input.shortDescription),
        description: empty(input.description),
        productType: input.productType,
        basePrice: prices.pricePaise,
        compareAtPrice: prices.compareAtPaise,
        currency: "INR",
        seoTitle: empty(input.seoTitle),
        seoDescription: empty(input.seoDescription),
        adminNotes: empty(input.adminNotes),
        estimatedShippingPaise: shipping,
        estimatedPaymentFeePaise: fee,
        supplierMappingRequired: input.supplierMappingRequired,
        // `undefined` leaves the stored copy untouched (API callers that do not manage it).
        ...(input.details ? { details: detailsForStorage(input.details) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(products.id, id));
    await syncCategories(tx, id, input.categoryIds, empty(input.primaryCategoryId));
    await syncCollections(tx, id, input.collectionIds);
    await syncTags(tx, id, input.tags);
    await syncDesign(tx, id, empty(input.designId), input.placement);
    return { slug, renamed: change.changed };
  }).catch(rethrowUnique);

  await audit(actor, "product.updated", "product", id, { slug: updated.slug, renamed: updated.renamed });
  return { slug: updated.slug };
}

async function supplierMapped(client: DbClient, productId: string): Promise<boolean> {
  const [productMap] = await client
    .select({ id: podProductMappings.id })
    .from(podProductMappings)
    .where(and(eq(podProductMappings.productId, productId), eq(podProductMappings.isActive, true)))
    .limit(1);
  if (!productMap) return false;
  const variants = await client.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.productId, productId));
  if (variants.length === 0) return false;
  const maps = await client
    .select({ variantId: podVariantMappings.variantId })
    .from(podVariantMappings)
    .where(
      and(
        inArray(podVariantMappings.variantId, variants.map((variant) => variant.id)),
        eq(podVariantMappings.isActive, true),
      ),
    );
  const mapped = new Set(maps.map((row) => row.variantId));
  return variants.every((variant) => mapped.has(variant.id));
}

export async function publishChecklist(productId: string): Promise<string[]> {
  const product = await requireProduct(db, productId);
  const [imageCount, categoryCount, variantCount, mapped] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(images)
      .where(and(eq(images.productId, productId), eq(images.type, "PRODUCT"))),
    db.select({ n: sql<number>`count(*)::int` }).from(productCategories).where(eq(productCategories.productId, productId)),
    db.select({ n: sql<number>`count(*)::int` }).from(productVariants).where(eq(productVariants.productId, productId)),
    supplierMapped(db, productId),
  ]);
  return publishBlockers({
    name: product.name,
    description: product.description,
    shortDescription: product.shortDescription,
    slug: product.slug,
    pricePaise: product.basePrice,
    compareAtPaise: product.compareAtPrice,
    imageCount: Number(imageCount[0]?.n ?? 0),
    categoryCount: Number(categoryCount[0]?.n ?? 0),
    variantCount: Number(variantCount[0]?.n ?? 0),
    productType: product.productType,
    supplierMappingRequired: product.supplierMappingRequired,
    supplierMapped: mapped,
  });
}

export async function publishProduct(actor: CatalogActor, id: string) {
  assertEditor(actor);
  const blockers = await publishChecklist(id);
  if (blockers.length) throw new ValidationError(blockers[0]!, blockers);
  const product = await requireProduct(db, id);
  await db
    .update(products)
    .set({ status: "ACTIVE", publishedAt: product.publishedAt ?? new Date(), updatedAt: new Date() })
    .where(eq(products.id, id));
  await audit(actor, "product.published", "product", id);
}

export async function archiveProduct(actor: CatalogActor, id: string) {
  assertEditor(actor);
  await requireProduct(db, id);
  await db.update(products).set({ status: "ARCHIVED", updatedAt: new Date() }).where(eq(products.id, id));
  await audit(actor, "product.archived", "product", id);
}

export async function discontinueProduct(actor: CatalogActor, id: string) {
  assertEditor(actor);
  await requireProduct(db, id);
  await db.update(products).set({ status: "DISCONTINUED", updatedAt: new Date() }).where(eq(products.id, id));
  await audit(actor, "product.updated", "product", id, { status: "DISCONTINUED" });
}

export async function duplicateProduct(actor: CatalogActor, id: string): Promise<{ id: string; slug: string }> {
  assertEditor(actor);
  const copy = await withTransaction(async (tx) => {
    const source = await requireProduct(tx, id);
    const slug = await allocateSlug(tx, slugFromName(`${source.name} copy`));
    const token = randomBytes(3).toString("hex").toUpperCase();
    const [created] = await tx
      .insert(products)
      .values({
        name: `Copy of ${source.name}`.slice(0, 160),
        slug,
        description: source.description,
        shortDescription: source.shortDescription,
        productType: source.productType,
        status: "DRAFT",
        basePrice: source.basePrice,
        compareAtPrice: source.compareAtPrice,
        currency: source.currency,
        brand: source.brand,
        seoTitle: source.seoTitle,
        seoDescription: source.seoDescription,
        adminNotes: source.adminNotes,
        estimatedShippingPaise: source.estimatedShippingPaise,
        estimatedPaymentFeePaise: source.estimatedPaymentFeePaise,
        supplierMappingRequired: source.supplierMappingRequired,
        details: source.details,
      })
      .returning({ id: products.id, slug: products.slug });
    if (!created) throw new ValidationError("The copy could not be created.");

    const [cats, cols, tagRows, designRows, imageRows, variantRows] = await Promise.all([
      tx.select().from(productCategories).where(eq(productCategories.productId, id)),
      tx.select().from(productCollections).where(eq(productCollections.productId, id)),
      tx.select().from(productTags).where(eq(productTags.productId, id)),
      tx.select().from(productDesigns).where(eq(productDesigns.productId, id)),
      tx.select().from(images).where(eq(images.productId, id)),
      tx.select().from(productVariants).where(eq(productVariants.productId, id)),
    ]);
    if (cats.length) {
      await tx.insert(productCategories).values(cats.map((row) => ({ productId: created.id, categoryId: row.categoryId, isPrimary: row.isPrimary })));
    }
    if (cols.length) {
      await tx.insert(productCollections).values(cols.map((row) => ({ productId: created.id, collectionId: row.collectionId, displayOrder: row.displayOrder })));
    }
    if (tagRows.length) await tx.insert(productTags).values(tagRows.map((row) => ({ productId: created.id, tagId: row.tagId })));
    if (designRows.length) {
      await tx.insert(productDesigns).values(
        designRows.map((row) => ({
          productId: created.id,
          designId: row.designId,
          placement: row.placement,
          printFileKey: row.printFileKey,
          displayOrder: row.displayOrder,
        })),
      );
    }
    const variantIdMap = new Map<string, string>();
    for (const variant of variantRows) {
      const [copyVariant] = await tx
        .insert(productVariants)
        .values({
          productId: created.id,
          sku: duplicateSku(variant.sku, token),
          name: variant.name,
          size: variant.size,
          color: variant.color,
          colorCode: variant.colorCode,
          price: variant.price,
          compareAtPrice: variant.compareAtPrice,
          availability: variant.availability,
          weightGrams: variant.weightGrams,
        })
        .returning({ id: productVariants.id });
      if (copyVariant) variantIdMap.set(variant.id, copyVariant.id);
    }

    if (imageRows.length) {
      await tx.insert(images).values(
        imageRows.map((row) => ({
          type: row.type,
          url: row.url,
          storageKey: row.storageKey,
          altText: row.altText,
          width: row.width,
          height: row.height,
          mimeType: row.mimeType,
          fileSizeBytes: row.fileSizeBytes,
          sortOrder: row.sortOrder,
          role: row.role,
          productId: created.id,
          // Keep a variant-specific photo attached to the COPY of its variant, never the original's.
          variantId: row.variantId ? (variantIdMap.get(row.variantId) ?? null) : null,
        })),
      );
    }

    const productMaps = await tx.select().from(podProductMappings).where(eq(podProductMappings.productId, id));
    if (productMaps.length) {
      await tx.insert(podProductMappings).values(
        productMaps.map((row) => ({
          providerId: row.providerId,
          productId: created.id,
          supplierProductId: row.supplierProductId,
          supplierSku: row.supplierSku,
          baseCost: row.baseCost,
          currency: row.currency,
          isActive: row.isActive,
        })),
      );
    }
    const oldVariantIds = [...variantIdMap.keys()];
    if (oldVariantIds.length) {
      const variantMaps = await tx.select().from(podVariantMappings).where(inArray(podVariantMappings.variantId, oldVariantIds));
      const copies = variantMaps
        .map((row) => {
          const variantId = variantIdMap.get(row.variantId);
          if (!variantId) return null;
          return {
            providerId: row.providerId,
            variantId,
            supplierVariantId: row.supplierVariantId,
            supplierSku: row.supplierSku,
            cost: row.cost,
            currency: row.currency,
            supplierAvailability: row.supplierAvailability,
            isActive: row.isActive,
          };
        })
        .filter((row): row is NonNullable<typeof row> => Boolean(row));
      if (copies.length) await tx.insert(podVariantMappings).values(copies);
    }
    return created;
  }).catch(rethrowUnique);

  await audit(actor, "product.duplicated", "product", copy.id, { sourceId: id });
  return copy;
}

async function assertComboFree(client: DbClient, productId: string, size: string | null, color: string | null, exceptId?: string) {
  const rows = await client
    .select({ id: productVariants.id, size: productVariants.size, color: productVariants.color })
    .from(productVariants)
    .where(eq(productVariants.productId, productId));
  const next = rows.filter((row) => row.id !== exceptId).concat([{ id: "next", size, color }]);
  if (duplicateVariantCombos(next).length) {
    throw new ValidationError("That size and color combination already exists.");
  }
}

export async function addVariant(actor: CatalogActor, productId: string, input: VariantWriteInput) {
  assertEditor(actor);
  const prices = pricePair(input.price, input.compareAt);
  const created = await withTransaction(async (tx) => {
    const product = await requireProduct(tx, productId);
    const catalog = await loadSizeRules(tx);
    const size = empty(input.size)?.toUpperCase() ?? null;
    rule(() => assertVariantForType(product.productType, size, catalog));
    const color = await assertKnownColor(tx, empty(input.color));
    await assertComboFree(tx, productId, size, color.color);
    const [row] = await tx
      .insert(productVariants)
      .values({
        productId,
        sku: input.sku.trim().toUpperCase(),
        name: input.name.trim(),
        size,
        color: color.color,
        colorCode: color.colorCode,
        price: prices.pricePaise,
        compareAtPrice: prices.compareAtPaise,
        availability: input.availability,
        weightGrams: input.weightGrams ?? null,
      })
      .returning({ id: productVariants.id, sku: productVariants.sku });
    if (!row) throw new ValidationError("The variant could not be created.");
    return row;
  }).catch(rethrowUnique);
  await audit(actor, "variant.created", "variant", created.id, { productId, sku: created.sku });
  return created;
}

export async function updateVariant(actor: CatalogActor, variantId: string, input: VariantWriteInput) {
  assertEditor(actor);
  const prices = pricePair(input.price, input.compareAt);
  await withTransaction(async (tx) => {
    const [current] = await tx.select().from(productVariants).where(eq(productVariants.id, variantId)).limit(1);
    if (!current) throw new NotFoundError("That variant does not exist.");
    const product = await requireProduct(tx, current.productId);
    const catalog = await loadSizeRules(tx);
    const size = empty(input.size)?.toUpperCase() ?? null;
    rule(() => assertVariantForType(product.productType, size, catalog));
    const color = await assertKnownColor(tx, empty(input.color));
    await assertComboFree(tx, current.productId, size, color.color, variantId);
    await tx
      .update(productVariants)
      .set({
        sku: input.sku.trim().toUpperCase(),
        name: input.name.trim(),
        size,
        color: color.color,
        colorCode: color.colorCode,
        price: prices.pricePaise,
        compareAtPrice: prices.compareAtPaise,
        availability: input.availability,
        weightGrams: input.weightGrams ?? null,
        updatedAt: new Date(),
      })
      .where(eq(productVariants.id, variantId));
  }).catch(rethrowUnique);
  await audit(actor, "variant.updated", "variant", variantId);
}

export async function retireVariant(actor: CatalogActor, variantId: string) {
  assertEditor(actor);
  const [current] = await db.select().from(productVariants).where(eq(productVariants.id, variantId)).limit(1);
  if (!current) throw new NotFoundError("That variant does not exist.");
  const [ordered] = await db.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.variantId, variantId)).limit(1);
  if (ordered) {
    await db.update(productVariants).set({ availability: "OUT_OF_STOCK", updatedAt: new Date() }).where(eq(productVariants.id, variantId));
    await audit(actor, "variant.updated", "variant", variantId, { availability: "OUT_OF_STOCK", reason: "order-history" });
    return { deleted: false };
  }
  await db.delete(productVariants).where(eq(productVariants.id, variantId));
  await audit(actor, "variant.updated", "variant", variantId, { removed: true });
  return { deleted: true };
}

async function putLocalImage(filename: string, data: Buffer) {
  if (process.env.STORAGE_DRIVER === "s3") {
    throw new ValidationError("Object storage is not connected yet. Product images stay on the local upload provider.");
  }
  const root = path.join(process.cwd(), "public", "uploads", "products");
  await mkdir(root, { recursive: true });
  const safe = path.basename(filename);
  const target = path.resolve(root, safe);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new ValidationError("Invalid storage key.");
  await writeFile(target, data);
  return { url: `/uploads/products/${safe}`, storageKey: `products/${safe}` };
}

export async function uploadProductImage(
  actor: CatalogActor,
  productId: string,
  file: { bytes: Buffer; declaredMime: string; alt: string; role: string },
) {
  assertEditor(actor);
  if (!IMAGE_ROLES.includes(file.role as ImageRole)) throw new ValidationError("Choose a valid image role.");
  const role = file.role as ImageRole;
  let inspected;
  try {
    inspected = inspectProductImage(file.bytes, file.declaredMime);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : "That image was rejected.");
  }
  await requireProduct(db, productId);
  const stored = await putLocalImage(`${randomBytes(16).toString("hex")}.${inspected.ext}`, file.bytes);
  const image = await withTransaction(async (tx) => {
    if (role === "PRIMARY") {
      await tx.update(images).set({ role: "GALLERY" }).where(and(eq(images.productId, productId), eq(images.role, "PRIMARY")));
    }
    const [row] = await tx
      .insert(images)
      .values({
        type: "PRODUCT",
        url: stored.url,
        storageKey: stored.storageKey,
        altText: file.alt.trim().slice(0, 180),
        width: inspected.width,
        height: inspected.height,
        mimeType: inspected.mime,
        fileSizeBytes: inspected.bytes,
        sortOrder: role === "PRIMARY" ? 0 : 10,
        role,
        productId,
      })
      .returning({ id: images.id });
    if (!row) throw new ValidationError("The image could not be saved.");
    return row;
  });
  await audit(actor, "image.uploaded", "image", image.id, { productId, role, bytes: inspected.bytes });
  return image;
}

export async function uploadOwnedImage(
  actor: CatalogActor,
  owner: { categoryId?: string; collectionId?: string },
  file: { bytes: Buffer; declaredMime: string; alt: string },
) {
  assertEditor(actor);
  if (!owner.categoryId && !owner.collectionId) throw new ValidationError("Choose a category or collection.");
  let inspected;
  try {
    inspected = inspectProductImage(file.bytes, file.declaredMime);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : "That image was rejected.");
  }
  const stored = await putLocalImage(`${randomBytes(16).toString("hex")}.${inspected.ext}`, file.bytes);
  const [row] = await db
    .insert(images)
    .values({
      type: owner.categoryId ? "CATEGORY" : "COLLECTION",
      url: stored.url,
      storageKey: stored.storageKey,
      altText: file.alt.trim().slice(0, 180),
      width: inspected.width,
      height: inspected.height,
      mimeType: inspected.mime,
      fileSizeBytes: inspected.bytes,
      sortOrder: 0,
      role: "PRIMARY",
      categoryId: owner.categoryId ?? null,
      collectionId: owner.collectionId ?? null,
    })
    .returning({ id: images.id });
  if (!row) throw new ValidationError("The image could not be saved.");
  await audit(actor, "image.uploaded", "image", row.id, owner);
  return row;
}

export async function deleteProductImage(actor: CatalogActor, imageId: string) {
  assertEditor(actor);
  const [image] = await db.select().from(images).where(eq(images.id, imageId)).limit(1);
  if (!image || !image.productId) throw new NotFoundError("That image does not exist.");
  const product = await requireProduct(db, image.productId);
  if (product.status === "ACTIVE") {
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(images)
      .where(and(eq(images.productId, image.productId), eq(images.type, "PRODUCT")));
    if (Number(count?.n ?? 0) <= 1) {
      throw new ValidationError("A published product needs at least one image. Archive it first, or upload a replacement.");
    }
  }
  await db.delete(images).where(eq(images.id, imageId));
  if (image.storageKey?.startsWith("products/")) {
    const root = path.join(process.cwd(), "public", "uploads");
    const target = path.resolve(root, image.storageKey);
    if (target.startsWith(path.resolve(root) + path.sep)) await unlink(target).catch(() => undefined);
  }
  await audit(actor, "image.deleted", "image", imageId, { productId: image.productId });
}

export async function reorderProductImages(actor: CatalogActor, productId: string, orderedIds: string[]) {
  assertEditor(actor);
  await requireProduct(db, productId);
  await withTransaction(async (tx) => {
    for (const [index, imageId] of orderedIds.entries()) {
      await tx
        .update(images)
        .set({ sortOrder: index, role: index === 0 ? "PRIMARY" : "GALLERY" })
        .where(and(eq(images.id, imageId), eq(images.productId, productId), eq(images.type, "PRODUCT")));
    }
  });
  await audit(actor, "image.uploaded", "product", productId, { reordered: orderedIds.length });
}

export async function bulkCatalog(actor: CatalogActor, input: BulkInput) {
  assertEditor(actor);
  if (input.confirmation !== bulkPhrase(input.action, input.productIds.length)) {
    throw new ValidationError("Confirmation did not match. Nothing was changed.");
  }
  const failures: { id: string; reason: string }[] = [];
  if (input.action === "ARCHIVE") {
    await db.update(products).set({ status: "ARCHIVED", updatedAt: new Date() }).where(inArray(products.id, input.productIds));
  } else if (input.action === "PUBLISH") {
    for (const id of input.productIds) {
      const blockers = await publishChecklist(id);
      if (blockers.length) {
        failures.push({ id, reason: blockers[0]! });
        continue;
      }
      const product = await requireProduct(db, id);
      await db
        .update(products)
        .set({ status: "ACTIVE", publishedAt: product.publishedAt ?? new Date(), updatedAt: new Date() })
        .where(eq(products.id, id));
    }
  } else if (input.action === "CHANGE_CATEGORY") {
    if (!input.categoryId) throw new ValidationError("Choose a category.");
    const [category] = await db.select({ id: categories.id }).from(categories).where(eq(categories.id, input.categoryId)).limit(1);
    if (!category) throw new ValidationError("That category does not exist.");
    await withTransaction(async (tx) => {
      await tx.delete(productCategories).where(inArray(productCategories.productId, input.productIds));
      await tx.insert(productCategories).values(input.productIds.map((productId) => ({ productId, categoryId: input.categoryId!, isPrimary: true })));
    });
    await audit(actor, "category.changed", "category", input.categoryId, { products: input.productIds.length });
  } else if (input.action === "ADD_COLLECTION" || input.action === "REMOVE_COLLECTION") {
    if (!input.collectionId) throw new ValidationError("Choose a collection.");
    if (input.action === "REMOVE_COLLECTION") {
      await db
        .delete(productCollections)
        .where(and(eq(productCollections.collectionId, input.collectionId), inArray(productCollections.productId, input.productIds)));
    } else {
      await db
        .insert(productCollections)
        .values(input.productIds.map((productId) => ({ productId, collectionId: input.collectionId!, displayOrder: 0 })))
        .onConflictDoNothing();
    }
  }
  await audit(actor, input.action === "PUBLISH" ? "product.published" : "product.updated", "product", input.productIds[0]!, {
    bulk: input.action,
    count: input.productIds.length,
    failed: failures.length,
  });
  return { updated: input.productIds.length - failures.length, failures };
}


/**
 * Renaming a public category/collection keeps the old URL alive: the previous
 * slug is stored so the storefront can 308 to the new one. A slug that an
 * another entity used to own stays reserved, so old links never point at
 * different content.
 */
async function recordSlugChange(
  client: DbClient,
  kind: "category" | "collection",
  id: string,
  currentSlug: string,
  nextSlug: string,
) {
  const reservedBy =
    kind === "category"
      ? (
          await client
            .select({ owner: categorySlugHistory.categoryId })
            .from(categorySlugHistory)
            .where(eq(categorySlugHistory.slug, nextSlug))
            .limit(1)
        )[0]?.owner
      : (
          await client
            .select({ owner: collectionSlugHistory.collectionId })
            .from(collectionSlugHistory)
            .where(eq(collectionSlugHistory.slug, nextSlug))
            .limit(1)
        )[0]?.owner;
  if (reservedBy && reservedBy !== id) {
    throw new ValidationError("That slug is reserved by an older public link. Choose another.");
  }
  if (kind === "category") {
    // Returning to a previous slug: it is current again, so it leaves history.
    if (reservedBy) await client.delete(categorySlugHistory).where(eq(categorySlugHistory.slug, nextSlug));
    if (currentSlug !== nextSlug) {
      await client.insert(categorySlugHistory).values({ categoryId: id, slug: currentSlug }).onConflictDoNothing();
    }
  } else {
    if (reservedBy) await client.delete(collectionSlugHistory).where(eq(collectionSlugHistory.slug, nextSlug));
    if (currentSlug !== nextSlug) {
      await client.insert(collectionSlugHistory).values({ collectionId: id, slug: currentSlug }).onConflictDoNothing();
    }
  }
}

export async function createCategory(actor: CatalogActor, input: CategoryWriteInput) {
  assertEditor(actor);
  const slug = input.slug?.trim() ? input.slug.trim().toLowerCase() : slugFromName(input.name);
  rule(() => assertSlug(slug));
  const [reserved] = await db
    .select({ id: categorySlugHistory.id })
    .from(categorySlugHistory)
    .where(eq(categorySlugHistory.slug, slug))
    .limit(1);
  if (reserved) throw new ValidationError("That slug is reserved by an older public link. Choose another.");
  const parentId = empty(input.parentId);
  // Materialized path is derived from the parent chain, never supplied by the client.
  const location = await locationForChild(parentId, slug);
  const [row] = await db
    .insert(categories)
    .values({
      name: input.name.trim(),
      slug,
      path: location.path,
      depth: location.depth,
      ancestorIds: location.ancestorIds,
      description: empty(input.description),
      parentId,
      seoTitle: empty(input.seoTitle),
      seoDescription: empty(input.seoDescription),
      displayOrder: input.displayOrder,
      isActive: true,
    })
    // `path` and `depth` are returned because they are server-derived: a caller
    // that creates a category has no other way to learn where it landed in the
    // tree, and the materialized path is what the storefront routes on.
    .returning({ id: categories.id, path: categories.path, depth: categories.depth })
    .catch(rethrowUnique);
  if (!row) throw new ValidationError("The category could not be created.");
  await audit(actor, "category.changed", "category", row.id, { created: true });
  return row;
}

export async function updateCategory(actor: CatalogActor, id: string, input: CategoryWriteInput) {
  assertEditor(actor);
  const slug = input.slug?.trim() ? input.slug.trim().toLowerCase() : slugFromName(input.name);
  rule(() => assertSlug(slug));
  const parentId = empty(input.parentId);
  const rows = await db
    .select({ id: categories.id, parentId: categories.parentId, slug: categories.slug })
    .from(categories);
  const parentOf = new Map(rows.map((row) => [row.id, row.parentId]));
  const current = rows.find((row) => row.id === id);
  if (!current) throw new NotFoundError("That category does not exist.");
  if (wouldCreateCategoryCycle(id, parentId, parentOf)) throw new ValidationError("A category cannot be its own parent.");
  await withTransaction(async (tx) => {
    await recordSlugChange(tx, "category", id, current.slug, slug);
    // Rewrite the materialized path of this node and every descendant.
    await relocateCategory(tx, id, { parentId, slug });
    await tx
      .update(categories)
      .set({
        name: input.name.trim(),
        slug,
        description: empty(input.description),
        parentId,
        seoTitle: empty(input.seoTitle),
        seoDescription: empty(input.seoDescription),
        displayOrder: input.displayOrder,
        updatedAt: new Date(),
      })
      .where(eq(categories.id, id));
  }).catch(rethrowUnique);
  await audit(actor, "category.changed", "category", id);
}

export async function archiveCategory(actor: CatalogActor, id: string, reassignToId: string | null) {
  assertEditor(actor);
  const [active] = await db
    .select({ n: sql<number>`count(distinct ${products.id})::int` })
    .from(productCategories)
    .innerJoin(products, eq(products.id, productCategories.productId))
    .where(and(eq(productCategories.categoryId, id), eq(products.status, "ACTIVE")));
  const decision = canArchiveCategory(Number(active?.n ?? 0), reassignToId, id);
  if (!decision.ok) throw new ValidationError(decision.reason);
  await withTransaction(async (tx) => {
    if (reassignToId) {
      const links = await tx.select().from(productCategories).where(eq(productCategories.categoryId, id));
      for (const link of links) {
        await tx
          .insert(productCategories)
          .values({ productId: link.productId, categoryId: reassignToId, isPrimary: link.isPrimary })
          .onConflictDoNothing();
      }
      await tx.delete(productCategories).where(eq(productCategories.categoryId, id));
    }
    await tx.update(categories).set({ isActive: false, updatedAt: new Date() }).where(eq(categories.id, id));
  });
  await audit(actor, "category.changed", "category", id, { archived: true, reassignToId });
}

function parseDate(value: string | null | undefined): Date | null {
  const raw = empty(value);
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new ValidationError("Enter a valid date.");
  return date;
}

export async function saveCollection(actor: CatalogActor, input: CollectionWriteInput, id?: string) {
  assertEditor(actor);
  const slug = input.slug?.trim() ? input.slug.trim().toLowerCase() : slugFromName(input.name);
  rule(() => assertSlug(slug));
  const startsAt = parseDate(input.startsAt);
  const endsAt = parseDate(input.endsAt);
  rule(() => assertSchedule(startsAt, endsAt));
  const saved = await withTransaction(async (tx) => {
    const values = {
      name: input.name.trim(),
      slug,
      description: empty(input.description),
      status: input.status,
      seoTitle: empty(input.seoTitle),
      seoDescription: empty(input.seoDescription),
      displayOrder: input.displayOrder,
      startsAt,
      endsAt,
      updatedAt: new Date(),
    };
    if (!id) {
      const [reserved] = await tx
        .select({ id: collectionSlugHistory.id })
        .from(collectionSlugHistory)
        .where(eq(collectionSlugHistory.slug, slug))
        .limit(1);
      if (reserved) throw new ValidationError("That slug is reserved by an older public link. Choose another.");
    }
    if (id) {
      const [existing] = await tx.select({ slug: collections.slug }).from(collections).where(eq(collections.id, id)).limit(1);
      if (!existing) throw new NotFoundError("That collection does not exist.");
      await recordSlugChange(tx, "collection", id, existing.slug, slug);
    }
    const row = id
      ? (await tx.update(collections).set(values).where(eq(collections.id, id)).returning({ id: collections.id }))[0]
      : (await tx.insert(collections).values(values).returning({ id: collections.id }))[0];
    if (!row) throw new NotFoundError("That collection does not exist.");
    if (!id || input.productIds.length > 0) {
      if (input.productIds.length) {
        const found = await tx.select({ id: products.id }).from(products).where(inArray(products.id, input.productIds));
        if (found.length !== new Set(input.productIds).size) throw new ValidationError("One of the products does not exist.");
      }
      await tx.delete(productCollections).where(eq(productCollections.collectionId, row.id));
      if (input.productIds.length) {
        await tx.insert(productCollections).values(
          input.productIds.map((productId, index) => ({ productId, collectionId: row.id, displayOrder: index })),
        );
      }
    }
    return row;
  }).catch(rethrowUnique);
  await audit(actor, "product.updated", "collection", saved.id, { products: input.productIds.length });
  return saved;
}

export async function saveSupplierMapping(
  actor: CatalogActor,
  productId: string,
  input: { supplierProductId: string; variants: { variantId: string; supplierVariantId: string; supplierSku: string | null }[] },
) {
  assertEditor(actor);
  if (!input.supplierProductId.trim()) throw new ValidationError("A supplier product id is required.");
  await withTransaction(async (tx) => {
    await requireProduct(tx, productId);
    const [provider] = await tx.select({ id: podProviders.id }).from(podProviders).where(eq(podProviders.code, "unconnected")).limit(1);
    const providerId =
      provider?.id ??
      (
        await tx
          .insert(podProviders)
          .values({
            name: "Unconnected supplier",
            code: "unconnected",
            status: "TESTING",
            isDefault: false,
            config: { connected: false },
          })
          .returning({ id: podProviders.id })
      )[0]!.id;
    await tx
      .insert(podProductMappings)
      .values({
        providerId,
        productId,
        supplierProductId: input.supplierProductId.trim(),
        isActive: true,
      })
      .onConflictDoUpdate({
        target: [podProductMappings.providerId, podProductMappings.productId],
        set: { supplierProductId: input.supplierProductId.trim(), isActive: true, updatedAt: new Date() },
      });
    for (const variant of input.variants) {
      if (!variant.supplierVariantId.trim()) continue;
      await tx
        .insert(podVariantMappings)
        .values({
          providerId,
          variantId: variant.variantId,
          supplierVariantId: variant.supplierVariantId.trim(),
          supplierSku: variant.supplierSku,
          isActive: true,
        })
        .onConflictDoUpdate({
          target: [podVariantMappings.providerId, podVariantMappings.variantId],
          set: {
            supplierVariantId: variant.supplierVariantId.trim(),
            supplierSku: variant.supplierSku,
            isActive: true,
            updatedAt: new Date(),
          },
        });
    }
  });
  await audit(actor, "product.updated", "product", productId, { supplierMapping: true });
}

export async function createColor(actor: CatalogActor, name: string, hex: string) {
  assertEditor(actor);
  const cleanHex = assertHex(hex);
  const slug = tagSlug(name);
  rule(() => assertSlug(slug));
  const [row] = await db
    .insert(colors)
    .values({ name: name.trim(), slug, hex: cleanHex, isActive: true })
    .returning({ id: colors.id })
    .catch(rethrowUnique);
  if (!row) throw new ValidationError("The color could not be saved.");
  return row;
}

export async function ensureCatalogDefaults() {
  const existingSizes = await db.select({ id: sizes.id }).from(sizes).limit(1);
  if (existingSizes.length === 0) {
    for (const [index, size] of SIZE_CATALOG.entries()) {
      const [row] = await db
        .insert(sizes)
        .values({ code: size.code, label: size.label, displayOrder: index, isActive: true })
        .onConflictDoNothing()
        .returning({ id: sizes.id });
      const sizeId = row?.id ?? (await db.select({ id: sizes.id }).from(sizes).where(eq(sizes.code, size.code)).limit(1))[0]?.id;
      if (!sizeId) continue;
      if (size.productTypes.length) {
        await db
          .insert(sizeProductTypes)
          .values(size.productTypes.map((productType) => ({ sizeId, productType })))
          .onConflictDoNothing();
      }
    }
  }
  const existingColors = await db.select({ id: colors.id }).from(colors).limit(1);
  if (existingColors.length === 0) {
    await db
      .insert(colors)
      .values(DEFAULT_COLORS.map((color, index) => ({ name: color.name, slug: tagSlug(color.name), hex: color.hex, displayOrder: index, isActive: true })))
      .onConflictDoNothing();
  }
}

export async function listEditorOptions() {
  await ensureCatalogDefaults();
  const [categoryRows, collectionRows, colorRows, sizeRows, designRows, tagRows] = await Promise.all([
    db.select().from(categories).orderBy(asc(categories.displayOrder), asc(categories.name)),
    db.select().from(collections).orderBy(asc(collections.displayOrder), asc(collections.name)),
    db.select().from(colors).where(eq(colors.isActive, true)).orderBy(asc(colors.displayOrder), asc(colors.name)),
    db
      .select({ code: sizes.code, label: sizes.label, productType: sizeProductTypes.productType })
      .from(sizes)
      .innerJoin(sizeProductTypes, eq(sizeProductTypes.sizeId, sizes.id))
      .where(eq(sizes.isActive, true)),
    db.select({ id: designs.id, name: designs.name }).from(designs).orderBy(asc(designs.name)),
    db.select({ name: tags.name, slug: tags.slug }).from(tags).orderBy(asc(tags.name)).limit(100),
  ]);
  return { categories: categoryRows, collections: collectionRows, colors: colorRows, sizes: sizeRows, designs: designRows, tags: tagRows };
}

/**
 * Create or replace the active size chart for a product type. The chart is
 * validated (every row as wide as the header, plain-text cells only) so the
 * storefront can render it without further checks.
 */
export async function saveSizeChart(actor: CatalogActor, productType: CatalogProductType, input: unknown) {
  assertEditor(actor);
  const parsed = sizeChartSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "That size chart isn't valid.");
  if (!isProductType(productType)) throw new ValidationError("Unknown product type.");
  const chart = parsed.data;
  const saved = await withTransaction(async (tx) => {
    const [current] = await tx
      .select({ id: sizeCharts.id })
      .from(sizeCharts)
      .where(and(eq(sizeCharts.productType, productType), eq(sizeCharts.isActive, true)))
      .limit(1);
    const values = {
      title: chart.title,
      unit: chart.unit,
      columns: chart.columns,
      rows: chart.rows,
      notes: chart.notes,
    };
    if (current) {
      await tx.update(sizeCharts).set({ ...values, updatedAt: new Date() }).where(eq(sizeCharts.id, current.id));
      return current.id;
    }
    const [created] = await tx.insert(sizeCharts).values({ productType, ...values }).returning({ id: sizeCharts.id });
    if (!created) throw new ValidationError("The size chart could not be saved.");
    return created.id;
  });
  await audit(actor, "size_chart.saved", "size_chart", saved, { productType });
  return { id: saved };
}

export async function getAdminProduct(id: string) {
  const product = await requireProduct(db, id);
  const [variantRows, imageRows, categoryRows, collectionRows, tagRows, designRows, costRows] = await Promise.all([
    db.select().from(productVariants).where(eq(productVariants.productId, id)).orderBy(asc(productVariants.name)),
    db.select().from(images).where(and(eq(images.productId, id), eq(images.type, "PRODUCT"))).orderBy(asc(images.sortOrder)),
    db.select().from(productCategories).where(eq(productCategories.productId, id)),
    db.select().from(productCollections).where(eq(productCollections.productId, id)),
    db
      .select({ name: tags.name })
      .from(productTags)
      .innerJoin(tags, eq(tags.id, productTags.tagId))
      .where(eq(productTags.productId, id)),
    db.select().from(productDesigns).where(eq(productDesigns.productId, id)).limit(1),
    db
      .select({ baseCost: podProductMappings.baseCost })
      .from(podProductMappings)
      .where(and(eq(podProductMappings.productId, id), eq(podProductMappings.isActive, true)))
      .limit(1),
  ]);
  const blockers = await publishChecklist(id);
  const [reviewHit, orderHit] = await Promise.all([
    db.select({ id: reviews.id }).from(reviews).where(eq(reviews.productId, id)).limit(1),
    db.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.productId, id)).limit(1),
  ]);
  return {
    product,
    variants: variantRows,
    images: imageRows,
    categoryIds: categoryRows.map((row) => row.categoryId),
    primaryCategoryId: categoryRows.find((row) => row.isPrimary)?.categoryId ?? categoryRows[0]?.categoryId ?? null,
    collectionIds: collectionRows.map((row) => row.collectionId),
    tags: tagRows.map((row) => row.name),
    designId: designRows[0]?.designId ?? null,
    placement: designRows[0]?.placement ?? "FRONT",
    supplierCostPaise: costRows[0]?.baseCost ?? null,
    blockers,
    referenced: Boolean(reviewHit[0] || orderHit[0]),
  };
}

export function sizesForProduct(type: CatalogProductType, sizeRows: { code: string; label: string; productType: string }[]) {
  const matches = sizeRows.filter((row) => row.productType === type);
  const unique = new Map<string, { code: string; label: string }>();
  for (const row of matches) unique.set(row.code, { code: row.code, label: row.label });
  return [...unique.values()];
}
