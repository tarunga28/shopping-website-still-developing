/**
 * Search document construction (pure).
 *
 * The search index stores one weighted `tsvector` per product. This module is
 * the single definition of *what goes into it and at which weight*, and the
 * C++ ranking engine (`native/cpp-search`) implements the same tokenizer so
 * both sides agree on token identity. If they diverge, a product indexed by one
 * becomes unfindable by the other — so the rules here are mirrored there and
 * covered by tests on both sides.
 *
 * FIELD WEIGHTS (PostgreSQL A > B > C > D)
 *   A  product name                    — the strongest signal
 *   B  brand, category path            — "nike running shoes" must match brand
 *   C  tags, attribute values, SKUs    — "256gb" finds the variant
 *   D  short/full description          — weakest; long text dilutes rank
 */

export const FIELD_WEIGHTS = {
  name: "A",
  brand: "B",
  category: "B",
  tags: "C",
  attributes: "C",
  sku: "C",
  description: "D",
} as const;

export type SearchField = keyof typeof FIELD_WEIGHTS;

/** Longest query we will process; anything longer is noise or an attack. */
export const MAX_QUERY_LENGTH = 80;
export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_TOKENS = 8;
/** Shortest prefix that triggers autocomplete. */
export const MIN_SUGGEST_LENGTH = 2;

/** Characters treated as token separators. Matches `native/cpp-search/tokenizer.cpp`. */
const SEPARATOR = /[^\p{L}\p{N}]+/u;

/**
 * Normalize and tokenize text.
 *
 * Steps: Unicode NFKC normalize (so "ﬁ" → "fi" and full-width digits fold),
 * strip combining marks (so "café" → "cafe" and an unaccented search matches),
 * lowercase, split on any run of non-letter/non-digit.
 *
 * Accent folding is done in the application as well as via the `unaccent`
 * extension so the indexed text and the query text are folded identically.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .normalize("NFKC")
    .toLowerCase()
    .split(SEPARATOR)
    .filter((token) => token.length > 0);
}

/** Collapse whitespace and bound the length. Used for stored display text. */
export function normalizeText(text: string | null | undefined, maxLength = 4000): string {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/** Sanitize a user-supplied query. Returns "" when it is not worth searching. */
export function sanitizeQuery(raw: string | null | undefined): string {
  if (!raw) return "";
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, MAX_QUERY_LENGTH);
}

/**
 * Canonical form used for query logging and synonym lookup.
 * Sorted so "iphone case" and "case iphone" collapse to one row.
 */
export function canonicalQuery(query: string): string {
  const tokens = tokenize(query);
  return [...new Set(tokens)].sort().join(" ");
}

export interface SearchDocument {
  name: string;
  brand: string | null;
  categoryPath: string | null;
  tags: string;
  attributes: string;
  skus: string;
  description: string;
}

/**
 * Flatten a product into the fields that get indexed.
 *
 * Accepts a pre-joined shape rather than a Drizzle row so this stays pure and
 * testable, and so the caller controls exactly which columns are read — no
 * chance of indexing an internal field by accident.
 */
export function buildSearchDocument(input: {
  name: string;
  brandName?: string | null;
  categoryPath?: string | null;
  tags?: readonly string[];
  /** Attribute values across all active variants, e.g. ["black", "256gb"]. */
  attributeValues?: readonly string[];
  skus?: readonly string[];
  barcodes?: readonly string[];
  shortDescription?: string | null;
  description?: string | null;
}): SearchDocument {
  return {
    name: normalizeText(input.name, 300),
    brand: input.brandName ? normalizeText(input.brandName, 120) : null,
    categoryPath: input.categoryPath ? normalizeText(input.categoryPath.replace(/\//g, " "), 300) : null,
    tags: normalizeText((input.tags ?? []).join(" "), 500),
    attributes: normalizeText((input.attributeValues ?? []).join(" "), 800),
    skus: normalizeText([...(input.skus ?? []), ...(input.barcodes ?? [])].join(" "), 500),
    description: normalizeText(
      [input.shortDescription ?? "", input.description ?? ""].filter(Boolean).join(" "),
      4000,
    ),
  };
}

/**
 * Trigram fallback text.
 *
 * Full-text search requires whole-word matches, so a typo ("ipohne") or a
 * partial word ("ipho") returns nothing. The trigram index over this column is
 * what catches those. It deliberately holds the name, brand and attribute values
 * — the fields a shopper actually types — and not the description, where
 * trigram matching would produce nonsense hits.
 */
export function buildTrigramText(document: SearchDocument): string {
  return normalizeText([document.name, document.brand ?? "", document.attributes, document.tags].join(" "), 500);
}

/**
 * Build the PostgreSQL expression that assembles the weighted vector.
 *
 * Returned as parameterised SQL fragments rather than interpolated strings —
 * every value is bound, never concatenated, so a product name containing quotes
 * or SQL cannot affect the statement.
 */
export function searchVectorExpression(): {
  sql: string;
  fields: SearchField[];
} {
  return {
    sql: [
      "setweight(to_tsvector('simple', coalesce($name, '')), 'A')",
      "|| setweight(to_tsvector('simple', coalesce($brand, '')), 'B')",
      "|| setweight(to_tsvector('simple', coalesce($category, '')), 'B')",
      "|| setweight(to_tsvector('simple', coalesce($tags, '')), 'C')",
      "|| setweight(to_tsvector('simple', coalesce($attributes, '')), 'C')",
      "|| setweight(to_tsvector('simple', coalesce($skus, '')), 'C')",
      "|| setweight(to_tsvector('simple', coalesce($description, '')), 'D')",
    ].join(" "),
    fields: ["name", "brand", "category", "tags", "attributes", "sku", "description"],
  };
}

/**
 * Expand a query with synonyms, preserving position.
 *
 * Returns one group per query token: the token itself plus every synonym that
 * maps to it. Groups must stay positional, because the alternatives within a
 * group are OR-ed while the groups themselves are AND-ed — "tee shirt" means
 * (tee OR t-shirt) AND (shirt), not "any of these four words".
 *
 * A synonym phrase is tokenized like any other text, so "t-shirt" contributes
 * the terms "t" and "shirt"; matching happens on those terms.
 */
export function synonymGroups(query: string, synonyms: ReadonlyMap<string, string[]>): string[][] {
  return tokenize(query).map((token) => {
    const alternatives = new Set<string>([token]);
    for (const synonym of synonyms.get(token) ?? []) {
      for (const part of tokenize(synonym)) alternatives.add(part);
    }
    return [...alternatives];
  });
}

/** Flat list of every term a query expands to — for display and debugging. */
export function expandWithSynonyms(query: string, synonyms: ReadonlyMap<string, string[]>): string[] {
  const expanded = new Set<string>();
  for (const group of synonymGroups(query, synonyms)) {
    for (const term of group) expanded.add(term);
  }
  return [...expanded];
}

/**
 * Build a `tsquery` expression from positional synonym groups.
 *
 * Within a group the terms are OR-ed (`tee:* | t | shirt`); between groups they
 * are AND-ed. The last group is prefix-matched so typing mid-word returns
 * results, but only the shopper's own token gets `:*` — prefixing a synonym too
 * would let "tee" match "titanium".
 *
 * Every term arrives already tokenized (letters and digits only), so the
 * assembled expression cannot carry SQL.
 */
export function groupsToTsQuery(groups: readonly (readonly string[])[]): string {
  const parts: string[] = [];
  groups.slice(0, MAX_QUERY_TOKENS).forEach((group, index) => {
    const clean = group.filter((term) => /^[\p{L}\p{N}]+$/u.test(term));
    if (clean.length === 0) return;
    const isLast = index === Math.min(groups.length, MAX_QUERY_TOKENS) - 1;
    const terms = clean.map((term, termIndex) => (isLast && termIndex === 0 ? `${term}:*` : term));
    parts.push(terms.length === 1 ? terms[0] : `(${terms.join(" | ")})`);
  });
  return parts.join(" & ");
}

/** Is this query worth running at all? */
export function isSearchableQuery(query: string): boolean {
  const clean = sanitizeQuery(query);
  return clean.length >= MIN_QUERY_LENGTH;
}

/** Highlight-friendly token overlap score in 0..1 — used for suggestion ordering. */
export function tokenOverlap(query: string, candidate: string): number {
  const queryTokens = new Set(tokenize(query));
  const candidateTokens = tokenize(candidate);
  if (queryTokens.size === 0 || candidateTokens.length === 0) return 0;
  let hits = 0;
  for (const token of queryTokens) {
    if (candidateTokens.some((candidateToken) => candidateToken.startsWith(token))) hits += 1;
  }
  return hits / queryTokens.size;
}
