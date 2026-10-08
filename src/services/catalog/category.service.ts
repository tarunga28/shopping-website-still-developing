import "server-only";
import { and, asc, eq, inArray, like, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { categories, productCategories, products, type Category } from "@/db/schema";
import type { DbClient } from "@/db/utils";
import {
  assertDepthWithinLimit,
  computeCategoryLocations,
  isWithinSubtree,
  joinPath,
  planReorder,
  planSubtreeRewrite,
  subtreeLikePattern,
  wouldCreateCycle,
  type CategoryLocation,
  type CategoryNode,
} from "@/lib/catalog/category-path";
import { NotFoundError, ValidationError } from "@/lib/errors";

/**
 * Category tree operations.
 *
 * The tree is stored two ways — `parent_id` (normalized, authoritative) and
 * `path`/`depth`/`ancestor_ids` (materialized, for subtree queries and
 * breadcrumbs). Every write here keeps both in sync inside one transaction, so
 * the denormalized columns can never drift from the edges.
 */

export interface CategoryRow extends Category {}

/** All rows needed to resolve the tree. Deliberately narrow — no descriptions. */
export async function loadCategoryNodes(client: DbClient = db): Promise<CategoryNode[]> {
  const rows = await client
    .select({ id: categories.id, slug: categories.slug, parentId: categories.parentId })
    .from(categories);
  return rows;
}

/** Location a new child of `parentId` would occupy. */
export async function locationForChild(
  parentId: string | null,
  slug: string,
  client: DbClient = db,
): Promise<CategoryLocation> {
  if (!parentId) {
    assertDepthWithinLimit(0);
    return { path: slug, depth: 0, ancestorIds: "" };
  }
  const nodes = await loadCategoryNodes(client);
  const locations = computeCategoryLocations(nodes);
  const parent = locations.get(parentId);
  if (!parent) throw new ValidationError("That parent category does not exist.");
  const location: CategoryLocation = {
    path: joinPath(parent.path, slug),
    depth: parent.depth + 1,
    ancestorIds: parent.ancestorIds ? `${parent.ancestorIds},${parentId}` : parentId,
  };
  assertDepthWithinLimit(location.depth);
  return location;
}

/**
 * Move and/or rename a category, rewriting the parent edge and every descendant
 * path in one pass. Rejects moves that would create a cycle.
 *
 * This owns the *tree* columns (`parent_id`, `slug`, `path`, `depth`,
 * `ancestor_ids`). Callers update the presentational columns (name, description,
 * SEO) separately — keeping the two apart means a rename of the display name
 * never has to touch the tree, and a move can never forget the path rewrite.
 */
export async function relocateCategory(
  client: DbClient,
  categoryId: string,
  change: { parentId?: string | null; slug?: string },
): Promise<{ rewrites: number; path: string }> {
  const nodes = await loadCategoryNodes(client);
  const current = nodes.find((node) => node.id === categoryId);
  if (!current) throw new NotFoundError("That category does not exist.");

  const parentOf = new Map(nodes.map((node) => [node.id, node.parentId]));
  if (change.parentId !== undefined && wouldCreateCycle(categoryId, change.parentId, parentOf)) {
    throw new ValidationError("A category cannot be moved inside itself or one of its own subcategories.");
  }
  if (change.parentId && !nodes.some((node) => node.id === change.parentId)) {
    throw new ValidationError("That parent category does not exist.");
  }

  // `planSubtreeRewrite` is a no-op when neither the parent nor the slug changed,
  // but the parent edge still has to be written, so handle it separately.
  const rewrites = planSubtreeRewrite(nodes, categoryId, change);
  for (const rewrite of rewrites) {
    assertDepthWithinLimit(rewrite.depth);
    await client
      .update(categories)
      .set({ path: rewrite.to, depth: rewrite.depth, ancestorIds: rewrite.ancestorIds, updatedAt: new Date() })
      .where(eq(categories.id, rewrite.id));
  }

  const edge: { parentId?: string | null; slug?: string; updatedAt: Date } = { updatedAt: new Date() };
  if (change.parentId !== undefined) edge.parentId = change.parentId;
  if (change.slug !== undefined) edge.slug = change.slug;
  await client.update(categories).set(edge).where(eq(categories.id, categoryId));

  const moved = rewrites.find((rewrite) => rewrite.id === categoryId);
  return { rewrites: rewrites.length, path: moved?.to ?? change.slug ?? current.slug };
}

/**
 * Ids of a category plus every descendant.
 *
 * One indexed range scan over `path` — this is why the path column exists. A
 * listing page filtered to "Electronics" must include phones and laptops that
 * sit three levels down.
 */
export async function categorySubtreeIds(categoryId: string, client: DbClient = db): Promise<string[]> {
  const [self] = await client.select({ path: categories.path }).from(categories).where(eq(categories.id, categoryId));
  if (!self) return [];
  const rows = await client
    .select({ id: categories.id })
    .from(categories)
    .where(or(eq(categories.path, self.path), like(categories.path, subtreeLikePattern(self.path))));
  return rows.map((row) => row.id);
}

/** Resolve a nested storefront path ("electronics/mobiles") to a category. */
export async function findByPath(path: string, client: DbClient = db): Promise<Category | null> {
  const clean = path.replace(/^\/+|\/+$/g, "");
  if (!clean) return null;
  const [row] = await client.select().from(categories).where(eq(categories.path, clean)).limit(1);
  return row ?? null;
}

/** Root-first ancestor chain for breadcrumbs. */
export async function ancestorsOf(categoryId: string, client: DbClient = db): Promise<Category[]> {
  const [self] = await client
    .select({ path: categories.path, ancestorIds: categories.ancestorIds })
    .from(categories)
    .where(eq(categories.id, categoryId));
  if (!self) return [];
  const ids = self.ancestorIds ? self.ancestorIds.split(",").filter(Boolean) : [];
  if (ids.length === 0) return [];
  const rows = await client.select().from(categories).where(inArray(categories.id, ids));
  // Preserve root-first order rather than whatever the planner returns.
  return ids.map((id) => rows.find((row) => row.id === id)).filter((row): row is Category => Boolean(row));
}

/** Direct children, ordered. */
export async function childrenOf(categoryId: string | null, client: DbClient = db): Promise<Category[]> {
  const rows = await client
    .select()
    .from(categories)
    .where(categoryId ? eq(categories.parentId, categoryId) : sql`${categories.parentId} IS NULL`)
    .orderBy(asc(categories.displayOrder), asc(categories.name));
  return rows;
}

/** Reorder siblings. `orderedIds` must all share the same parent. */
export async function reorderSiblings(
  orderedIds: readonly string[],
  client: DbClient = db,
): Promise<{ updated: number }> {
  if (orderedIds.length === 0) return { updated: 0 };
  const rows = await client
    .select({ id: categories.id, parentId: categories.parentId })
    .from(categories)
    .where(inArray(categories.id, [...orderedIds]));
  if (rows.length !== orderedIds.length) throw new ValidationError("One of those categories does not exist.");
  const parents = new Set(rows.map((row) => row.parentId ?? "root"));
  if (parents.size > 1) throw new ValidationError("Only categories with the same parent can be reordered together.");

  const plan = planReorder(orderedIds);
  for (const move of plan) {
    await client.update(categories).set({ displayOrder: move.displayOrder, updatedAt: new Date() }).where(eq(categories.id, move.id));
  }
  return { updated: plan.length };
}

/** Enable/disable a category and, optionally, its whole subtree. */
export async function setCategoryActive(
  categoryId: string,
  isActive: boolean,
  options: { includeDescendants?: boolean } = {},
  client: DbClient = db,
): Promise<{ updated: number }> {
  const ids = options.includeDescendants ? await categorySubtreeIds(categoryId, client) : [categoryId];
  if (ids.length === 0) throw new NotFoundError("That category does not exist.");
  await client.update(categories).set({ isActive, updatedAt: new Date() }).where(inArray(categories.id, ids));
  return { updated: ids.length };
}

/** Exact product count per category, used for facet labels. */
export async function categoryProductCounts(client: DbClient = db): Promise<Record<string, number>> {
  const rows = await client
    .select({ categoryId: productCategories.categoryId, count: sql<number>`count(*)::int` })
    .from(productCategories)
    .innerJoin(products, eq(products.id, productCategories.productId))
    .where(and(eq(products.status, "ACTIVE"), eq(products.visibility, "PUBLIC")))
    .groupBy(productCategories.categoryId);
  return Object.fromEntries(rows.map((row) => [row.categoryId, row.count]));
}

/** True when a category row still carries the denormalized path of `path`. */
export function pathMatches(path: string, candidate: string): boolean {
  return isWithinSubtree(candidate, path);
}
