/**
 * Pure category-tree helpers. The category table is small taxonomy data, so
 * the service loads it once (cached) and resolves visibility, ancestry and
 * descendants here — no per-request recursive queries.
 */

export interface CategoryRow {
  id: string;
  parentId: string | null;
  slug: string;
  name: string;
  description: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  displayOrder: number;
  isActive: boolean;
  image: { url: string; alt: string } | null;
}

export interface PublicCategory extends Omit<CategoryRow, "isActive"> {
  depth: number;
}

const MAX_DEPTH = 5;

/**
 * A category is public only if it and every ancestor are active, and the
 * chain terminates (cycles or over-deep chains are treated as not public).
 */
export function buildPublicCategories(rows: CategoryRow[]): PublicCategory[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const result: PublicCategory[] = [];
  for (const row of rows) {
    let depth = 0;
    let cursor: CategoryRow | undefined = row;
    let valid = true;
    const seen = new Set<string>();
    while (cursor) {
      if (!cursor.isActive || seen.has(cursor.id) || depth >= MAX_DEPTH) {
        valid = false;
        break;
      }
      seen.add(cursor.id);
      if (!cursor.parentId) break;
      cursor = byId.get(cursor.parentId);
      if (!cursor) {
        // Dangling parent: treat as a root rather than hiding the category.
        break;
      }
      depth += 1;
    }
    if (valid) {
      result.push({
        id: row.id,
        parentId: row.parentId,
        slug: row.slug,
        name: row.name,
        description: row.description,
        seoTitle: row.seoTitle,
        seoDescription: row.seoDescription,
        displayOrder: row.displayOrder,
        image: row.image,
        depth,
      });
    }
  }
  return result.sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name));
}

export function findCategory(categories: PublicCategory[], slug: string): PublicCategory | null {
  return categories.find((category) => category.slug === slug) ?? null;
}

export function childrenOf(categories: PublicCategory[], id: string | null): PublicCategory[] {
  const ids = new Set(categories.map((category) => category.id));
  return categories.filter((category) =>
    id === null ? category.parentId === null || !ids.has(category.parentId) : category.parentId === id,
  );
}

/** The category itself plus every public descendant. */
export function descendantIds(categories: PublicCategory[], id: string): string[] {
  const out = [id];
  const queue = [id];
  const seen = new Set(out);
  while (queue.length) {
    const current = queue.shift()!;
    for (const child of categories) {
      if (child.parentId === current && !seen.has(child.id)) {
        seen.add(child.id);
        out.push(child.id);
        queue.push(child.id);
      }
    }
  }
  return out;
}

/** Root → … → parent (excludes the category itself). */
export function ancestorsOf(categories: PublicCategory[], id: string): PublicCategory[] {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const chain: PublicCategory[] = [];
  let cursor = byId.get(id);
  const seen = new Set<string>();
  while (cursor?.parentId && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    const parent = byId.get(cursor.parentId);
    if (!parent) break;
    chain.unshift(parent);
    cursor = parent;
  }
  return chain;
}
