import "server-only";

import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  categories,
  collections,
  designs,
  images,
  productVariants,
  products,
  type ProductImage,
} from "@/db/schema";
import type { DbClient } from "@/db/utils";
import { withTransaction } from "@/db/utils";
import { emitCatalogEvent } from "@/services/catalog/events.service";
import { NotFoundError, ValidationError } from "@/lib/errors";
import {
  IMAGE_ROLES,
  MAX_ALT_TEXT_LENGTH,
  MAX_MEDIA_PER_PRODUCT,
  MAX_MEDIA_PER_VARIANT,
  MEDIA_KINDS,
  groupMedia,
  normalizeMedia,
  validateMedia,
  type ImageRole,
  type MediaGroup,
  type MediaInput,
  type NormalizedMedia,
} from "@/lib/catalog/media";
import type { MediaKind } from "@/db/schema/enums";

/**
 * Media service — images, video, and 360 sets for products, variants,
 * categories, collections, and designs.
 *
 * Storage rules, all enforced here rather than in the UI:
 *
 * 1. **Object storage or CDN only.** A `url` is an absolute http(s) address or a
 *    storage key. Local paths and `file:`/`javascript:` URLs are rejected,
 *    because this value is rendered into an `src` attribute for shoppers.
 * 2. **Every row has exactly one owner.** The table is polymorphic across five
 *    owners but each row points at one, and the foreign key cascades with it, so
 *    deleting a product cannot leave orphaned media behind.
 * 3. **Counts are bounded.** A product with 40 images is a merchandising mistake
 *    and a page-weight problem; the cap is enforced on write, not on render.
 */

export interface ImageRow extends ProductImage {}

export type MediaOwner =
  | { kind: "product"; id: string }
  | { kind: "variant"; id: string }
  | { kind: "category"; id: string }
  | { kind: "collection"; id: string }
  | { kind: "design"; id: string };

function ownerColumns(owner: MediaOwner) {
  switch (owner.kind) {
    case "product":
      return { column: images.productId, max: MAX_MEDIA_PER_PRODUCT, type: "PRODUCT" as const };
    case "variant":
      return { column: images.variantId, max: MAX_MEDIA_PER_VARIANT, type: "PRODUCT" as const };
    case "category":
      return { column: images.categoryId, max: 2, type: "CATEGORY" as const };
    case "collection":
      return { column: images.collectionId, max: 4, type: "COLLECTION" as const };
    case "design":
      return { column: images.designId, max: 6, type: "DESIGN" as const };
  }
}

/** Assert the owner row exists, so media cannot be attached to nothing. */
async function assertOwnerExists(owner: MediaOwner, client: DbClient): Promise<void> {
  const checks: Record<MediaOwner["kind"], Promise<unknown[]>> = {
    product: client.select({ id: products.id }).from(products).where(eq(products.id, owner.id)).limit(1),
    variant: client
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(eq(productVariants.id, owner.id))
      .limit(1),
    category: client.select({ id: categories.id }).from(categories).where(eq(categories.id, owner.id)).limit(1),
    collection: client
      .select({ id: collections.id })
      .from(collections)
      .where(eq(collections.id, owner.id))
      .limit(1),
    design: client.select({ id: designs.id }).from(designs).where(eq(designs.id, owner.id)).limit(1),
  };
  const rows = await checks[owner.kind];
  if (!rows.length) throw new NotFoundError(`Cannot attach media: ${owner.kind} not found`);
}

/* ── reads ───────────────────────────────────────────────────────────── */

export async function listMedia(
  owner: MediaOwner,
  client: DbClient = db,
): Promise<ImageRow[]> {
  const { column } = ownerColumns(owner);
  return client.select().from(images).where(eq(column, owner.id)).orderBy(asc(images.sortOrder), asc(images.createdAt));
}

/** All media for a set of products in one query — the listing-page path. */
export async function listMediaForProducts(
  productIds: readonly string[],
  client: DbClient = db,
): Promise<Map<string, ImageRow[]>> {
  const ids = [...new Set(productIds)];
  if (!ids.length) return new Map();

  const rows = await client
    .select()
    .from(images)
    .where(eq(images.productId, sql`any(${ids})` as never))
    .orderBy(asc(images.sortOrder));

  // `inArray` is the portable form; the cast above keeps drizzle happy about the
  // parameter type for a large id list.
  const filtered = rows.filter((row) => row.productId && ids.includes(row.productId));
  const out = new Map<string, ImageRow[]>();
  for (const row of filtered) {
    const list = out.get(row.productId!) ?? [];
    list.push(row);
    out.set(row.productId!, list);
  }
  return out;
}

function toNormalized(row: ImageRow): NormalizedMedia {
  return {
    url: row.url,
    storageKey: row.storageKey,
    thumbnailUrl: row.thumbnailUrl,
    externalUrl: row.externalUrl,
    altText: row.altText,
    mediaKind: row.mediaKind,
    format: row.format,
    width: row.width,
    height: row.height,
    fileSizeBytes: row.fileSizeBytes,
    durationMs: row.durationMs,
    frameCount: row.frameCount,
    role: row.role as ImageRole,
    sortOrder: row.sortOrder,
    productId: row.productId,
    variantId: row.variantId,
  };
}

/** Media grouped into the shape the PDP and cards consume. */
export async function getProductMediaGroup(
  productId: string,
  client: DbClient = db,
): Promise<MediaGroup> {
  // A product's gallery includes its variants' images, because the PDP shows
  // the selected colourway — but groupMedia keeps them out of `main`.
  const variantIds = await client
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(eq(productVariants.productId, productId));

  const ownerFilters = [eq(images.productId, productId)];
  if (variantIds.length) {
    ownerFilters.push(inArray(images.variantId, variantIds.map((row) => row.id)));
  }

  const rows = await client
    .select()
    .from(images)
    .where(or(...ownerFilters))
    .orderBy(asc(images.sortOrder), asc(images.createdAt));

  return groupMedia(rows.map(toNormalized));
}

/* ── writes ──────────────────────────────────────────────────────────── */

export async function addMedia(
  owner: MediaOwner,
  input: MediaInput,
  options: { actorId?: string | null } = {},
): Promise<ImageRow> {
  const issues = validateMedia(input);
  if (issues.length) {
    throw new ValidationError(issues[0]!.message, issues);
  }

  const { column, max, type } = ownerColumns(owner);

  return withTransaction(async (tx) => {
    await assertOwnerExists(owner, tx);

    const [countRow] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(images)
      .where(eq(column, owner.id));
    const existing = countRow?.total ?? 0;
    if (existing >= max) {
      throw new ValidationError(
        `This ${owner.kind} already has the maximum of ${max} media item${max === 1 ? "" : "s"}.`,
      );
    }

    const value = normalizeMedia(input);
    const [row] = await tx
      .insert(images)
      .values({
        type,
        mediaKind: value.mediaKind,
        url: value.url,
        storageKey: value.storageKey,
        thumbnailUrl: value.thumbnailUrl,
        externalUrl: value.externalUrl,
        format: value.format,
        durationMs: value.durationMs,
        frameCount: value.frameCount,
        altText: value.altText,
        width: value.width,
        height: value.height,
        mimeType: value.format
          ? `${value.mediaKind === "VIDEO" ? "video" : "image"}/${value.format}`
          : null,
        fileSizeBytes: value.fileSizeBytes,
        sortOrder: value.sortOrder || existing * 10,
        role: value.role,
        productId: owner.kind === "product" ? owner.id : value.productId,
        variantId: owner.kind === "variant" ? owner.id : value.variantId,
        categoryId: owner.kind === "category" ? owner.id : null,
        collectionId: owner.kind === "collection" ? owner.id : null,
        designId: owner.kind === "design" ? owner.id : null,
      })
      .returning();

    await emitCatalogEvent(tx, {
      eventType: "MEDIA_CHANGED",
      aggregateType: owner.kind === "variant" ? "variant" : owner.kind,
      aggregateId: owner.id,
      payload: { change: "added", imageId: row.id, mediaKind: row.mediaKind },
      actorId: options.actorId ?? null,
    });

    return row;
  });
}

export async function updateMedia(
  imageId: string,
  input: Partial<MediaInput>,
  options: { actorId?: string | null } = {},
): Promise<ImageRow> {
  const [current] = await db.select().from(images).where(eq(images.id, imageId)).limit(1);
  if (!current) throw new NotFoundError("Media not found");

  // Validate the merged row: a partial patch that would produce an invalid
  // record has to be rejected, not half-applied.
  const merged: MediaInput = {
    url: input.url ?? current.url,
    storageKey: input.storageKey === undefined ? current.storageKey : input.storageKey,
    thumbnailUrl: input.thumbnailUrl === undefined ? current.thumbnailUrl : input.thumbnailUrl,
    externalUrl: input.externalUrl === undefined ? current.externalUrl : input.externalUrl,
    altText: input.altText === undefined ? current.altText : input.altText,
    mediaKind: input.mediaKind ?? current.mediaKind,
    format: input.format === undefined ? current.format : input.format,
    width: input.width === undefined ? current.width : input.width,
    height: input.height === undefined ? current.height : input.height,
    fileSizeBytes: input.fileSizeBytes === undefined ? current.fileSizeBytes : input.fileSizeBytes,
    durationMs: input.durationMs === undefined ? current.durationMs : input.durationMs,
    frameCount: input.frameCount === undefined ? current.frameCount : input.frameCount,
    role: input.role ?? (current.role as ImageRole),
  };
  const issues = validateMedia(merged);
  if (issues.length) throw new ValidationError(issues[0]!.message, issues);

  const value = normalizeMedia(merged);

  return withTransaction(async (tx) => {
    const [row] = await tx
      .update(images)
      .set({
        mediaKind: value.mediaKind,
        url: value.url,
        storageKey: value.storageKey,
        thumbnailUrl: value.thumbnailUrl,
        externalUrl: value.externalUrl,
        format: value.format,
        durationMs: value.durationMs,
        frameCount: value.frameCount,
        altText: value.altText,
        width: value.width,
        height: value.height,
        fileSizeBytes: value.fileSizeBytes,
        role: value.role,
        sortOrder: input.sortOrder ?? current.sortOrder,
      })
      .where(eq(images.id, imageId))
      .returning();

    await emitCatalogEvent(tx, {
      eventType: "MEDIA_CHANGED",
      aggregateType: row.variantId ? "variant" : "product",
      aggregateId: row.variantId ?? row.productId ?? imageId,
      payload: { change: "updated", imageId: row.id },
      actorId: options.actorId ?? null,
    });

    return row;
  });
}

export async function deleteMedia(
  imageId: string,
  options: { actorId?: string | null } = {},
): Promise<void> {
  await withTransaction(async (tx) => {
    const [row] = await tx.delete(images).where(eq(images.id, imageId)).returning();
    if (!row) throw new NotFoundError("Media not found");

    await emitCatalogEvent(tx, {
      eventType: "MEDIA_CHANGED",
      aggregateType: row.variantId ? "variant" : "product",
      aggregateId: row.variantId ?? row.productId ?? imageId,
      payload: { change: "removed", imageId: row.id, url: row.url },
      actorId: options.actorId ?? null,
    });
  });
}

/**
 * Apply a new ordering.
 *
 * Takes the full ordered id list rather than a swap, because a drag-and-drop
 * reorder in the admin UI is a permutation and applying it pairwise would
 * briefly violate the intended sequence.
 */
export async function reorderOwnerMedia(
  owner: MediaOwner,
  orderedIds: readonly string[],
  options: { actorId?: string | null } = {},
): Promise<void> {
  const { column } = ownerColumns(owner);

  await withTransaction(async (tx) => {
    const rows = await tx.select().from(images).where(eq(column, owner.id));
    const owned = new Set(rows.map((row) => row.id));
    const foreign = orderedIds.filter((id) => !owned.has(id));
    if (foreign.length) {
      // Rejecting rather than ignoring: silently skipping an id would leave the
      // admin looking at an order that was never saved.
      throw new ValidationError("Some of those media items do not belong to this owner.");
    }

    const nextOrders = new Map<string, number>();
    orderedIds.forEach((id, index) => nextOrders.set(id, index * 10));

    for (const row of rows) {
      const next = nextOrders.get(row.id);
      if (next === undefined || next === row.sortOrder) continue;
      await tx.update(images).set({ sortOrder: next }).where(eq(images.id, row.id));
    }

    await emitCatalogEvent(tx, {
      eventType: "MEDIA_CHANGED",
      aggregateType: owner.kind === "variant" ? "variant" : owner.kind,
      aggregateId: owner.id,
      payload: { change: "reordered", count: orderedIds.length },
      actorId: options.actorId ?? null,
    });
  });
}

/**
 * Promote one image to be the product's primary.
 *
 * Demotes the previous primary in the same transaction, so there is never a
 * moment with two primaries or none.
 */
export async function setPrimaryMedia(
  imageId: string,
  options: { actorId?: string | null } = {},
): Promise<ImageRow> {
  return withTransaction(async (tx) => {
    const [target] = await tx.select().from(images).where(eq(images.id, imageId)).limit(1);
    if (!target) throw new NotFoundError("Media not found");
    if (!target.productId) {
      throw new ValidationError("Only product-level media can be the primary image.");
    }
    if (target.mediaKind !== "IMAGE") {
      throw new ValidationError("The primary media must be a still image.");
    }

    await tx
      .update(images)
      .set({ role: "GALLERY" })
      .where(
        and(
          eq(images.productId, target.productId),
          eq(images.role, "PRIMARY"),
          isNull(images.variantId),
          sql`${images.id} <> ${imageId}`,
        ),
      );

    const [row] = await tx
      .update(images)
      .set({ role: "PRIMARY", sortOrder: 0 })
      .where(eq(images.id, imageId))
      .returning();

    await emitCatalogEvent(tx, {
      eventType: "MEDIA_CHANGED",
      aggregateType: "product",
      aggregateId: target.productId,
      payload: { change: "primary", imageId },
      actorId: options.actorId ?? null,
    });

    return row;
  });
}

/** Media missing alt text — an accessibility to-do list for merchandising. */
export async function listMediaWithoutAltText(
  limit = 100,
  client: DbClient = db,
): Promise<ImageRow[]> {
  return client
    .select()
    .from(images)
    .where(and(eq(images.mediaKind, "IMAGE"), sql`coalesce(${images.altText}, '') = ''`))
    .orderBy(asc(images.createdAt))
    .limit(limit);
}

export const MEDIA_LIMITS = {
  MAX_MEDIA_PER_PRODUCT,
  MAX_MEDIA_PER_VARIANT,
  MAX_ALT_TEXT_LENGTH,
  IMAGE_ROLES,
  MEDIA_KINDS,
} as const;

export type { MediaKind };
