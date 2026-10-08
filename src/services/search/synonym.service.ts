import "server-only";

import { and, asc, eq, or, sql } from "drizzle-orm";

import { db } from "@/db";
import { searchSynonyms } from "@/db/schema";
import type { DbClient } from "@/db/utils";
import { withTransaction } from "@/db/utils";
import { ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { tokenize } from "@/lib/catalog/search-text";

/**
 * Synonym management.
 *
 * ## Why synonyms are stored, not configured
 *
 * A synonym is a merchandising decision about this store's vocabulary — "back
 * cover" means "phone case" here, and might not mean that anywhere else. Storing
 * it in the database means it is reviewable, scoped, reversible, and auditable
 * without a deploy.
 *
 * ## Direction matters
 *
 * A **one-way** synonym expands the query but not the index: searching "mobile"
 * also matches "smartphone", but searching "smartphone" does not drag in every
 * product merely tagged "mobile". A **two-way** synonym does both.
 *
 * Getting this wrong is the classic synonym failure — a broad term silently
 * swallowing a narrow one. The default here is one-way, because the safe mistake
 * is too few results, not too many.
 */

export type SynonymRow = typeof searchSynonyms.$inferSelect;

export interface SynonymInput {
  term: string;
  synonym: string;
  isBidirectional?: boolean;
  isActive?: boolean;
}

/** Validate a synonym pair. Returns problems rather than throwing. */
export function validateSynonym(input: SynonymInput): string[] {
  const errors: string[] = [];
  const term = normalizeTerm(input.term);
  const synonym = normalizeTerm(input.synonym);

  if (!term) errors.push("term is required");
  if (!synonym) errors.push("synonym is required");
  if (term && synonym && term === synonym) {
    errors.push("a term cannot be its own synonym");
  }
  if (term && term.length > 80) errors.push("term must be at most 80 characters");
  if (synonym && synonym.length > 80) errors.push("synonym must be at most 80 characters");

  // A multi-word term is fine ("cell phone"), but a whole sentence is a mistake.
  for (const value of [term, synonym]) {
    if (!value) continue;
    const tokens = tokenize(value);
    if (tokens.length > 4) errors.push(`"${value}" is too long to be a useful synonym`);
  }

  return errors;
}

function normalizeTerm(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export async function listSynonyms(
  options: { search?: string | null; includeInactive?: boolean; client?: DbClient } = {},
): Promise<SynonymRow[]> {
  const client = options.client ?? db;
  const conditions = [];
  if (!options.includeInactive) conditions.push(eq(searchSynonyms.isActive, true));
  if (options.search?.trim()) {
    const pattern = `%${normalizeTerm(options.search)}%`;
    conditions.push(
      or(
        sql`lower(${searchSynonyms.term}) like ${pattern}`,
        sql`lower(${searchSynonyms.synonym}) like ${pattern}`,
      )!,
    );
  }

  return client
    .select()
    .from(searchSynonyms)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(searchSynonyms.term));
}

export async function createSynonym(
  input: SynonymInput,
  client: DbClient = db,
): Promise<SynonymRow> {
  const errors = validateSynonym(input);
  if (errors.length) throw new ValidationError(errors[0]!, errors);

  const term = normalizeTerm(input.term);
  const synonym = normalizeTerm(input.synonym);

  return withTransaction(async (tx) => {
    // A synonym pair must be unique in each direction, otherwise the same pair
    // applied twice double-counts in the expanded query.
    const [existing] = await tx
      .select()
      .from(searchSynonyms)
      .where(
        or(
          and(eq(searchSynonyms.term, term), eq(searchSynonyms.synonym, synonym)),
          and(eq(searchSynonyms.term, synonym), eq(searchSynonyms.synonym, term)),
        ),
      )
      .limit(1);
    if (existing) {
      throw new ValidationError(`"${term}" and "${synonym}" are already linked.`);
    }

    const [row] = await tx
      .insert(searchSynonyms)
      .values({
        term,
        synonym,
        isBidirectional: input.isBidirectional ?? false,
        isActive: input.isActive ?? true,
      })
      .returning();

    invalidateSynonymCache();
    return row;
  });
}

export async function updateSynonym(
  id: string,
  input: Partial<SynonymInput>,
  client: DbClient = db,
): Promise<SynonymRow> {
  const [current] = await client.select().from(searchSynonyms).where(eq(searchSynonyms.id, id)).limit(1);
  if (!current) throw new ValidationError("Synonym not found");

  const merged: SynonymInput = {
    term: input.term ?? current.term,
    synonym: input.synonym ?? current.synonym,
    isBidirectional: input.isBidirectional ?? current.isBidirectional,
    isActive: input.isActive ?? current.isActive,
  };
  const errors = validateSynonym(merged);
  if (errors.length) throw new ValidationError(errors[0]!, errors);

  const [row] = await client
    .update(searchSynonyms)
    .set({
      term: normalizeTerm(merged.term),
      synonym: normalizeTerm(merged.synonym),
      isBidirectional: merged.isBidirectional ?? false,
      isActive: merged.isActive ?? true,
    })
    .where(eq(searchSynonyms.id, id))
    .returning();

  invalidateSynonymCache();
  return row;
}

export async function deleteSynonym(id: string, client: DbClient = db): Promise<boolean> {
  const [row] = await client.delete(searchSynonyms).where(eq(searchSynonyms.id, id)).returning({ id: searchSynonyms.id });
  invalidateSynonymCache();
  return Boolean(row);
}

/**
 * Apply a batch of synonyms from a paste or an import.
 *
 * Reports per-line results rather than failing wholesale: a 200-line synonym
 * import with one bad line should import 199, not zero.
 */
export async function importSynonyms(
  lines: readonly string[],
  client: DbClient = db,
): Promise<{ imported: number; skipped: number; errors: Array<{ line: number; message: string }> }> {
  let imported = 0;
  let skipped = 0;
  const errors: Array<{ line: number; message: string }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line || line.startsWith("#")) {
      skipped += 1;
      continue;
    }
    // Accept "a, b", "a -> b" and "a = b" so a spreadsheet paste works.
    const parts = line.split(/,|->|=>|=/).map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) {
      errors.push({ line: index + 1, message: "expected two terms separated by a comma or ->" });
      continue;
    }
    try {
      await createSynonym({ term: parts[0]!, synonym: parts[1]! }, client);
      imported += 1;
    } catch (error) {
      errors.push({
        line: index + 1,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { imported, skipped, errors };
}

/**
 * Seed synonyms that are safe almost anywhere.
 *
 * A small, conservative set. Ambiguous pairs are deliberately absent — "polo"
 * and "apple" would be actively harmful as global synonyms, and the spec is
 * explicit that dangerous synonyms must not be applied globally.
 */
export async function seedDefaultSynonyms(client: DbClient = db): Promise<number> {
  const defaults: Array<[string, string, boolean]> = [
    ["cell phone", "smartphone", true],
    ["mobile phone", "smartphone", true],
    ["cellphone", "smartphone", true],
    ["handset", "smartphone", false],
    ["tv", "television", true],
    ["sneakers", "sneaker", true],
    ["sneaker", "shoe", false],
    ["laptop computer", "laptop", true],
    ["notebook", "laptop", false],
    ["headphone", "headphones", true],
    ["earbud", "earphone", false],
    ["tshirt", "t-shirt", true],
    ["tee", "t-shirt", false],
    ["trouser", "pant", true],
    ["jumper", "hoodie", false],
    ["back cover", "phone case", false],
    ["phone cover", "phone case", false],
    ["mobile case", "phone case", false],
    ["protector", "screen protector", false],
  ];

  let written = 0;
  for (const [term, synonym, bidirectional] of defaults) {
    try {
      await createSynonym({ term, synonym, isBidirectional: bidirectional }, client);
      written += 1;
    } catch {
      // Already present, which is the expected outcome on a re-run.
    }
  }
  if (written > 0) invalidateSynonymCache();
  return written;
}

/* ── Cache ───────────────────────────────────────────────────────────── */

/**
 * The synonym map is cached in-process.
 *
 * `getSynonymMap` in the catalog search service already caches, but that cache
 * has no invalidation hook, so synonyms appeared to take effect only after a
 * restart. This wrapper adds one.
 */
let cachedMap: { map: Map<string, string[]>; builtAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

export function invalidateSynonymCache(): void {
  cachedMap = null;
}

/**
 * Synonyms as term -> expansions.
 *
 * Bidirectional pairs are added in both directions. Note this builds the *flat*
 * map used for display and for the catalog service's expansion; the search
 * pipeline uses `synonymGroups`, which preserves position so an OR stays an OR.
 */
export async function getSynonymExpansions(client: DbClient = db): Promise<Map<string, string[]>> {
  if (cachedMap && Date.now() - cachedMap.builtAt < CACHE_TTL_MS) return cachedMap.map;

  const map = new Map<string, string[]>();
  try {
    const rows = await client.select().from(searchSynonyms).where(eq(searchSynonyms.isActive, true));
    for (const row of rows) {
      const term = normalizeTerm(row.term);
      const synonym = normalizeTerm(row.synonym);
      if (!term || !synonym) continue;

      const existing = map.get(term) ?? [];
      if (!existing.includes(synonym)) existing.push(synonym);
      map.set(term, existing);

      if (row.isBidirectional) {
        const reverse = map.get(synonym) ?? [];
        if (!reverse.includes(term)) reverse.push(term);
        map.set(synonym, reverse);
      }
    }
    cachedMap = { map, builtAt: Date.now() };
    return map;
  } catch (error) {
    logger.warn("could not load synonyms; continuing without expansion", {
      error: error instanceof Error ? error.message : String(error),
    });
    return map;
  }
}

export async function synonymStats(client: DbClient = db): Promise<{
  total: number;
  bidirectional: number;
  inactive: number;
}> {
  const [row] = await client
    .select({
      total: sql<number>`count(*)::int`,
      bidirectional: sql<number>`count(*) filter (where ${searchSynonyms.isBidirectional})::int`,
      inactive: sql<number>`count(*) filter (where not ${searchSynonyms.isActive})::int`,
    })
    .from(searchSynonyms);

  return {
    total: row?.total ?? 0,
    bidirectional: row?.bidirectional ?? 0,
    inactive: row?.inactive ?? 0,
  };
}
