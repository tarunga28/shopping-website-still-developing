import "server-only";

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { brands, products, type Brand } from "@/db/schema";
import type { DbClient } from "@/db/utils";
import { emitCatalogEvent } from "@/services/catalog/events.service";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { assertSlug, slugFromName } from "@/lib/catalog-rules";
import { isRemoteMediaReference } from "@/lib/catalog/media";
import { withTransaction } from "@/db/utils";

/**
 * Brand directory.
 *
 * Two rules drive this module:
 *
 * 1. **A brand is referenced by id, never by name.** Products hold `brand_id`;
 *    the free-text `products.brand` column predates Part 11 and is kept only so
 *    older rows keep rendering. Everything written here goes through the id.
 * 2. **Names are unique case-insensitively.** The database enforces
 *    `unique(lower(name))`, so a duplicate surfaces as a constraint violation
 *    rather than two "Nike" brands in the admin list.
 */

export interface BrandRow extends Brand {}

export interface BrandSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  logoUrl: string | null;
  bannerUrl: string | null;
  website: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  displayOrder: number;
  isActive: boolean;
  productCount: number;
}

export interface BrandInput {
  name: string;
  slug?: string | null;
  description?: string | null;
  logoUrl?: string | null;
  bannerUrl?: string | null;
  website?: string | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  displayOrder?: number | null;
  isActive?: boolean | null;
  sellerId?: string | null;
}

/**
 * Brands with their live product counts.
 *
 * The count is a correlated subquery rather than a join-and-group, so brands with
 * zero products still appear — an empty brand is a merchandising signal, not a
 * reason to hide the row.
 */
export async function listBrands(
  options: { includeInactive?: boolean; search?: string | null; limit?: number } = {},
  client: DbClient = db,
): Promise<BrandSummary[]> {
  const { includeInactive = false, search = null, limit = 100 } = options;

  // A raw SQL field in a subquery needs an explicit alias: without one,
  // referencing `productCount.total` from the outer select throws at query-build
  // time rather than returning a count.
  const productCount = db
    .select({
      brandId: products.brandId,
      total: sql<number>`count(*)::int`.as("total"),
    })
    .from(products)
    .where(eq(products.status, "ACTIVE"))
    .groupBy(products.brandId)
    .as("brand_product_counts");

  const filters = [];
  if (!includeInactive) filters.push(eq(brands.isActive, true));
  if (search && search.trim()) {
    const pattern = `%${search.trim().toLowerCase()}%`;
    filters.push(sql`lower(${brands.name}) like ${pattern}`);
  }

  const rows = await client
    .select({
      id: brands.id,
      name: brands.name,
      slug: brands.slug,
      description: brands.description,
      logoUrl: brands.logoUrl,
      bannerUrl: brands.bannerUrl,
      website: brands.website,
      seoTitle: brands.seoTitle,
      seoDescription: brands.seoDescription,
      displayOrder: brands.displayOrder,
      isActive: brands.isActive,
      productCount: sql<number>`coalesce(${productCount.total}, 0)::int`,
    })
    .from(brands)
    .leftJoin(productCount, eq(productCount.brandId, brands.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(brands.displayOrder), asc(brands.name))
    .limit(limit);

  return rows;
}

export async function getBrand(slugOrId: string, client: DbClient = db): Promise<BrandRow | null> {
  const [row] = await client
    .select()
    .from(brands)
    .where(sql`${brands.slug} = ${slugOrId} OR ${brands.id} = ${slugOrId}::uuid`)
    .limit(1);
  return row ?? null;
}

export async function getBrandById(id: string, client: DbClient = db): Promise<BrandRow> {
  const [row] = await client.select().from(brands).where(eq(brands.id, id)).limit(1);
  if (!row) throw new NotFoundError("Brand not found");
  return row;
}

/**
 * Validate a brand write. Returns issues rather than throwing so a form can show
 * every problem at once instead of one per round trip.
 */
export function validateBrandInput(input: BrandInput): string[] {
  const errors: string[] = [];

  const name = (input.name ?? "").trim();
  if (!name) {
    errors.push("Brand name is required.");
  } else if (name.length > 120) {
    errors.push("Brand name must be at most 120 characters.");
  }

  if (input.slug) {
    // `assertSlug` signals an invalid slug by throwing and returns the cleaned
    // slug on success — it does not return an error message. Reading its return
    // value as an issue pushed the slug itself into `errors`, which rejected
    // every brand that supplied one.
    try {
      assertSlug(input.slug);
    } catch {
      errors.push("Slug must be lowercase, URL-safe, and unique-ready.");
    }
  }

  for (const field of ["logoUrl", "bannerUrl"] as const) {
    const value = input[field];
    if (value && !isRemoteMediaReference(value)) {
      errors.push(`${field} must be an absolute http(s) URL or a storage key.`);
    }
  }

  if (input.website) {
    const website = input.website.trim();
    // A brand website is shown to shoppers as a link, so it has to be absolute
    // and http(s) — anything else is a javascript:/data: injection vector.
    if (!/^https?:\/\/[^\s]+\.[^\s]+$/i.test(website)) {
      errors.push("website must be an absolute http(s) URL.");
    }
  }

  if (input.description && input.description.length > 2000) {
    errors.push("Description must be at most 2000 characters.");
  }
  if (input.seoTitle && input.seoTitle.length > 70) {
    errors.push("SEO title must be at most 70 characters.");
  }
  if (input.seoDescription && input.seoDescription.length > 170) {
    errors.push("SEO description must be at most 170 characters.");
  }
  if (
    input.displayOrder !== null &&
    input.displayOrder !== undefined &&
    (!Number.isInteger(input.displayOrder) || input.displayOrder < 0)
  ) {
    errors.push("displayOrder must be a non-negative whole number.");
  }

  return errors;
}

async function assertNameAvailable(
  name: string,
  client: DbClient,
  excludeId?: string,
): Promise<void> {
  const [existing] = await client
    .select({ id: brands.id })
    .from(brands)
    .where(
      excludeId
        ? and(sql`lower(${brands.name}) = lower(${name})`, sql`${brands.id} <> ${excludeId}`)
        : sql`lower(${brands.name}) = lower(${name})`,
    )
    .limit(1);
  if (existing) {
    // Checked before insert so the caller gets a readable message; the unique
    // index remains the real guarantee under concurrent writes.
    throw new ValidationError(`A brand named "${name}" already exists.`);
  }
}

async function assertSlugAvailable(
  slug: string,
  client: DbClient,
  excludeId?: string,
): Promise<void> {
  const [existing] = await client
    .select({ id: brands.id })
    .from(brands)
    .where(excludeId ? and(eq(brands.slug, slug), sql`${brands.id} <> ${excludeId}`) : eq(brands.slug, slug))
    .limit(1);
  if (existing) throw new ValidationError(`The slug "${slug}" is already in use.`);
}

export async function createBrand(
  input: BrandInput,
  options: { actorId?: string | null } = {},
): Promise<BrandRow> {
  const errors = validateBrandInput(input);
  if (errors.length) throw new ValidationError(errors[0]!, errors);

  const name = input.name.trim();
  const slug = (input.slug?.trim() || slugFromName(name)).toLowerCase();

  return withTransaction(async (tx) => {
    await assertNameAvailable(name, tx);
    await assertSlugAvailable(slug, tx);

    const [row] = await tx
      .insert(brands)
      .values({
        name,
        slug,
        description: input.description?.trim() || null,
        logoUrl: input.logoUrl?.trim() || null,
        bannerUrl: input.bannerUrl?.trim() || null,
        website: input.website?.trim() || null,
        seoTitle: input.seoTitle?.trim() || null,
        seoDescription: input.seoDescription?.trim() || null,
        displayOrder: input.displayOrder ?? 0,
        isActive: input.isActive ?? true,
        sellerId: input.sellerId ?? null,
      })
      .returning();

    await emitCatalogEvent(tx, {
      eventType: "BRAND_CREATED",
      aggregateType: "brand",
      aggregateId: row.id,
      payload: { name: row.name, slug: row.slug },
      actorId: options.actorId ?? null,
    });

    return row;
  });
}

export async function updateBrand(
  id: string,
  input: Partial<BrandInput>,
  options: { actorId?: string | null } = {},
): Promise<BrandRow> {
  const current = await getBrandById(id);

  // Validate the merged result, not the patch: a partial update that would
  // produce an invalid brand has to be rejected too.
  const merged: BrandInput = { ...current, ...input, name: input.name?.trim() || current.name };
  const errors = validateBrandInput(merged);
  if (errors.length) throw new ValidationError(errors[0]!, errors);

  return withTransaction(async (tx) => {
    if (input.name && input.name.trim() !== current.name) {
      await assertNameAvailable(input.name.trim(), tx, id);
    }
    if (input.slug && input.slug.trim() !== current.slug) {
      await assertSlugAvailable(input.slug.trim().toLowerCase(), tx, id);
    }

    const [row] = await tx
      .update(brands)
      .set({
        name: merged.name.trim(),
        slug: input.slug ? input.slug.trim().toLowerCase() : current.slug,
        description: input.description === undefined ? current.description : input.description?.trim() || null,
        logoUrl: input.logoUrl === undefined ? current.logoUrl : input.logoUrl?.trim() || null,
        bannerUrl: input.bannerUrl === undefined ? current.bannerUrl : input.bannerUrl?.trim() || null,
        website: input.website === undefined ? current.website : input.website?.trim() || null,
        seoTitle: input.seoTitle === undefined ? current.seoTitle : input.seoTitle?.trim() || null,
        seoDescription:
          input.seoDescription === undefined
            ? current.seoDescription
            : input.seoDescription?.trim() || null,
        displayOrder: input.displayOrder ?? current.displayOrder,
        isActive: input.isActive ?? current.isActive,
      })
      .where(eq(brands.id, id))
      .returning();

    await emitCatalogEvent(tx, {
      eventType: "BRAND_UPDATED",
      aggregateType: "brand",
      aggregateId: row.id,
      payload: { slug: row.slug, isActive: row.isActive },
      actorId: options.actorId ?? null,
    });

    return row;
  });
}

/**
 * Deactivate rather than delete when products still reference the brand.
 *
 * Deleting a brand with live products would either orphan them or cascade a
 * deletion nobody asked for. Deactivation is reversible and keeps history
 * intact, which is what an order line referring to that brand needs.
 */
export async function deactivateBrand(
  id: string,
  options: { actorId?: string | null } = {},
): Promise<BrandRow> {
  return withTransaction(async (tx) => {
    const [row] = await tx.update(brands).set({ isActive: false }).where(eq(brands.id, id)).returning();
    if (!row) throw new NotFoundError("Brand not found");

    await emitCatalogEvent(tx, {
      eventType: "BRAND_UPDATED",
      aggregateType: "brand",
      aggregateId: row.id,
      payload: { isActive: false, reason: "deactivated" },
      actorId: options.actorId ?? null,
    });
    return row;
  });
}

/** Products still attached to a brand — the blocker report for deletion. */
export async function brandProductCount(id: string, client: DbClient = db): Promise<number> {
  const [row] = await client
    .select({ total: sql<number>`count(*)::int` })
    .from(products)
    .where(eq(products.brandId, id));
  return row?.total ?? 0;
}

/**
 * Delete a brand outright. Refuses when products reference it.
 *
 * Offered for the genuine "created by mistake, never used" case; the normal
 * admin action is `deactivateBrand`.
 */
export async function deleteBrand(
  id: string,
  options: { actorId?: string | null } = {},
): Promise<void> {
  await withTransaction(async (tx) => {
    const attached = await brandProductCount(id, tx);
    if (attached > 0) {
      throw new ValidationError(
        `This brand is used by ${attached} product${attached === 1 ? "" : "s"}. Deactivate it instead of deleting it.`,
      );
    }
    const [row] = await tx.delete(brands).where(eq(brands.id, id)).returning({ id: brands.id });
    if (!row) throw new NotFoundError("Brand not found");

    await emitCatalogEvent(tx, {
      eventType: "BRAND_DELETED",
      aggregateType: "brand",
      aggregateId: id,
      payload: {},
      actorId: options.actorId ?? null,
    });
  });
}

/** Active brands as `{value,label}` for a select control. */
export async function brandOptions(
  client: DbClient = db,
): Promise<Array<{ value: string; label: string }>> {
  const rows = await client
    .select({ id: brands.id, name: brands.name })
    .from(brands)
    .where(eq(brands.isActive, true))
    .orderBy(asc(brands.displayOrder), asc(brands.name));
  return rows.map((row) => ({ value: row.id, label: row.name }));
}

/** The platform's own house brand — products with no seller-assigned brand. */
export async function findHouseBrands(client: DbClient = db): Promise<BrandRow[]> {
  return client.select().from(brands).where(isNull(brands.sellerId)).orderBy(asc(brands.name));
}

/** Brands by id, for hydrating a product list in one query. */
export async function getBrandsByIds(
  ids: readonly string[],
  client: DbClient = db,
): Promise<Map<string, BrandRow>> {
  if (!ids.length) return new Map();
  const rows = await client.select().from(brands).where(inArray(brands.id, [...new Set(ids)]));
  return new Map(rows.map((row) => [row.id, row]));
}

/** Most-referenced active brands, for a storefront brand rail. */
export async function topBrands(limit = 12, client: DbClient = db): Promise<BrandSummary[]> {
  const rows = await client
    .select({
      id: brands.id,
      name: brands.name,
      slug: brands.slug,
      description: brands.description,
      logoUrl: brands.logoUrl,
      bannerUrl: brands.bannerUrl,
      website: brands.website,
      seoTitle: brands.seoTitle,
      seoDescription: brands.seoDescription,
      displayOrder: brands.displayOrder,
      isActive: brands.isActive,
      productCount: sql<number>`count(${products.id})::int`,
    })
    .from(brands)
    .innerJoin(products, and(eq(products.brandId, brands.id), eq(products.status, "ACTIVE")))
    .where(eq(brands.isActive, true))
    .groupBy(brands.id)
    .orderBy(desc(sql`count(${products.id})`), asc(brands.name))
    .limit(limit);
  return rows;
}
