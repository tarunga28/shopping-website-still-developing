/**
 * Category tree engine (pure).
 *
 * Categories form an unlimited-depth tree. Two representations are kept:
 *
 *   `parentId`   the normalized relation — the source of truth for the tree
 *   `path`       materialized slug chain ("electronics/mobiles/smartphones")
 *
 * The materialized path exists because the two hottest category operations are
 * subtree queries and breadcrumb rendering. With a path, "everything under
 * Electronics" is one index range scan (`path LIKE 'electronics/%'`) instead of
 * a recursive CTE per request, and the storefront URL for a nested category is
 * literally its path, so no join is needed to render it.
 *
 * The cost is that a move or rename must rewrite descendants. That is handled
 * here in one place so every caller rewrites consistently.
 *
 * Everything in this file is pure — no database, no side effects — so the tree
 * rules are unit-testable without a server.
 */

export const PATH_SEPARATOR = "/";
export const ANCESTOR_SEPARATOR = ",";
/** Guard against pathological trees; no real catalog goes anywhere near this. */
export const MAX_CATEGORY_DEPTH = 20;

export interface CategoryNode {
  id: string;
  slug: string;
  parentId: string | null;
}

export interface CategoryLocation {
  path: string;
  depth: number;
  /** Comma-joined ancestor ids, root-first, excluding the node itself. */
  ancestorIds: string;
}

export function joinPath(parentPath: string | null | undefined, slug: string): string {
  const clean = (parentPath ?? "").replace(/^\/+|\/+$/g, "");
  return clean ? `${clean}${PATH_SEPARATOR}${slug}` : slug;
}

export function depthFromPath(path: string): number {
  if (!path) return 0;
  return path.split(PATH_SEPARATOR).length - 1;
}

/** True when `candidate` is the same node as, or inside, `ancestor`. */
export function isWithinSubtree(candidatePath: string, ancestorPath: string): boolean {
  if (!ancestorPath) return false;
  return candidatePath === ancestorPath || candidatePath.startsWith(`${ancestorPath}${PATH_SEPARATOR}`);
}

/** SQL LIKE pattern matching a whole subtree, excluding the root itself. */
export function subtreeLikePattern(ancestorPath: string): string {
  return `${ancestorPath}${PATH_SEPARATOR}%`;
}

/**
 * Resolve every node's location from the parent/child edges.
 *
 * Nodes whose ancestor chain cannot be resolved (orphans created by a
 * `parent_id` that no longer exists) fall back to root-level placement rather
 * than being dropped — a broken row must not make the whole tree disappear.
 */
export function computeCategoryLocations(nodes: readonly CategoryNode[]): Map<string, CategoryLocation> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const resolved = new Map<string, CategoryLocation>();

  const resolve = (id: string, guard: Set<string>): CategoryLocation => {
    const cached = resolved.get(id);
    if (cached) return cached;

    const node = byId.get(id);
    if (!node) {
      // Referenced parent is missing — treat as a root.
      const fallback: CategoryLocation = { path: id, depth: 0, ancestorIds: "" };
      resolved.set(id, fallback);
      return fallback;
    }

    // A cycle in the data would recurse forever; break it and treat as root.
    if (!node.parentId || guard.has(id) || guard.size >= MAX_CATEGORY_DEPTH) {
      const root: CategoryLocation = { path: node.slug, depth: 0, ancestorIds: "" };
      resolved.set(id, root);
      return root;
    }

    const nextGuard = new Set(guard).add(id);
    const parent = resolve(node.parentId, nextGuard);
    const location: CategoryLocation = {
      path: joinPath(parent.path, node.slug),
      depth: parent.depth + 1,
      ancestorIds: parent.ancestorIds ? `${parent.ancestorIds}${ANCESTOR_SEPARATOR}${node.parentId}` : node.parentId,
    };
    resolved.set(id, location);
    return location;
  };

  for (const node of nodes) resolve(node.id, new Set());
  return resolved;
}

export interface PathRewrite {
  id: string;
  from: string;
  to: string;
  depth: number;
  ancestorIds: string;
}

/**
 * Plan the path/depth/ancestor updates after a category moves or is renamed.
 *
 * Rather than doing prefix string surgery (easy to get wrong for deep trees),
 * this recomputes the whole tree with the change applied and returns only the
 * rows whose location actually changed — so moving one leaf rewrites one row.
 */
export function planSubtreeRewrite(
  nodes: readonly CategoryNode[],
  movedId: string,
  change: { parentId?: string | null; slug?: string },
): PathRewrite[] {
  const before = computeCategoryLocations(nodes);
  const mutated = nodes.map((node) =>
    node.id === movedId
      ? {
          ...node,
          parentId: change.parentId === undefined ? node.parentId : change.parentId,
          slug: change.slug ?? node.slug,
        }
      : node,
  );
  const after = computeCategoryLocations(mutated);

  const rewrites: PathRewrite[] = [];
  for (const node of nodes) {
    const was = before.get(node.id);
    const now = after.get(node.id);
    if (!was || !now) continue;
    if (was.path === now.path && was.depth === now.depth && was.ancestorIds === now.ancestorIds) continue;
    rewrites.push({ id: node.id, from: was.path, to: now.path, depth: now.depth, ancestorIds: now.ancestorIds });
  }
  return rewrites;
}

/** Location a category would have under a new parent/slug, before committing. */
export function previewLocation(
  nodes: readonly CategoryNode[],
  categoryId: string,
  change: { parentId?: string | null; slug?: string },
): CategoryLocation | null {
  const mutated = nodes.map((node) =>
    node.id === categoryId
      ? {
          ...node,
          parentId: change.parentId === undefined ? node.parentId : change.parentId,
          slug: change.slug ?? node.slug,
        }
      : node,
  );
  return computeCategoryLocations(mutated).get(categoryId) ?? null;
}

/**
 * Would setting `newParentId` on `categoryId` create a cycle?
 * A category cannot become its own ancestor, and cannot be re-parented under
 * one of its own descendants.
 */
export function wouldCreateCycle(
  categoryId: string,
  newParentId: string | null,
  parentOf: ReadonlyMap<string, string | null>,
): boolean {
  if (!newParentId) return false;
  if (newParentId === categoryId) return true;
  const seen = new Set<string>([categoryId]);
  let cursor: string | null = newParentId;
  while (cursor) {
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = parentOf.get(cursor) ?? null;
    if (seen.size > MAX_CATEGORY_DEPTH) return true;
  }
  return false;
}

/** Breadcrumb chain, root-first, for rendering and canonical URLs. */
export function breadcrumbChain(
  path: string,
  byPath: ReadonlyMap<string, { id: string; name: string }>,
): { id: string; name: string; slug: string; path: string }[] {
  const segments = path ? path.split(PATH_SEPARATOR) : [];
  const chain: { id: string; name: string; slug: string; path: string }[] = [];
  let cursor = "";
  for (const segment of segments) {
    cursor = cursor ? `${cursor}${PATH_SEPARATOR}${segment}` : segment;
    const node = byPath.get(cursor);
    if (!node) continue;
    chain.push({ id: node.id, name: node.name, slug: segment, path: cursor });
  }
  return chain;
}

export interface ReorderMove {
  id: string;
  displayOrder: number;
}

/**
 * Reorder siblings. `orderedIds` is the desired order of the sibling set that
 * contains `movedId`; every affected row gets a new, gap-tolerant position so a
 * later insert can always slot in between two existing rows.
 */
export function planReorder(orderedIds: readonly string[]): ReorderMove[] {
  const step = 10;
  return orderedIds.map((id, index) => ({ id, displayOrder: index * step }));
}

/** Split the difference — lets a UI drop an item between two others. */
export function positionBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 0;
  if (before === null) return (after as number) - 5;
  if (after === null) return before + 10;
  if (after <= before) return before + 5;
  return Math.round((before + after) / 2);
}

/**
 * Validate a proposed depth. Unlimited depth is supported, but a hard ceiling
 * keeps a bad import from building a 10,000-level chain that no query plan can
 * handle and no breadcrumb can render.
 */
export function assertDepthWithinLimit(depth: number, limit = MAX_CATEGORY_DEPTH): void {
  if (!Number.isInteger(depth) || depth < 0) throw new Error("Category depth is invalid.");
  if (depth > limit) {
    throw new Error(`Categories can be nested at most ${limit} levels deep.`);
  }
}
