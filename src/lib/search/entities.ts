/**
 * Entity extraction — pulling brand, category, and attribute meaning out of a
 * query string.
 *
 * ## What this is, and what it is not
 *
 * This is dictionary-driven matching against the store's *own* vocabulary: the
 * brands in `brands`, the categories in `categories`, and the attribute axes and
 * values in Part 11's attribute engine. It is not semantic understanding, and it
 * does not pretend to be. A query is understood to the extent that its words
 * appear in this catalog.
 *
 * The interface is deliberately shaped so a stronger model can be swapped in
 * later: callers pass a `Lexicon` and receive `ExtractedEntity[]` with a
 * confidence score. Replacing the matcher does not change the contract.
 *
 * ## Why confidence matters
 *
 * "apple" is a brand and a fruit. "polo" is a shirt style and a brand. An
 * extraction that is applied with certainty when it is ambiguous silently hides
 * products, so every entity carries a confidence and the caller decides the
 * threshold. Ambiguous terms are matched as *both* an entity and a keyword,
 * which costs a little precision and buys a lot of recall.
 */

import type { ExtractedEntity, SearchIntent } from "@/lib/search/types";

/** One entry the matcher knows about. */
export interface LexiconEntry {
  /** Folded form used for matching. */
  term: string;
  /** Extra folded aliases, e.g. "iphone" for the brand "Apple". */
  aliases?: readonly string[];
  kind: ExtractedEntity["kind"];
  /** Canonical display value. */
  value: string;
  id?: string;
  /** Attribute axis code, when kind is ATTRIBUTE/COLOR/SIZE. */
  axis?: string;
  /**
   * How many other meanings this term has in the lexicon. A term with several is
   * ambiguous and is scored down, so it is not applied as a hard filter.
   */
  ambiguity?: number;
  /** How many products carry this entity. Rare entities are weaker evidence. */
  productCount?: number;
}

export interface Lexicon {
  entries: readonly LexiconEntry[];
}

/** Below this confidence an entity is reported but not applied as a filter. */
export const ENTITY_APPLY_THRESHOLD = 0.6;

/** Gender terms, which are attributes in most apparel catalogs. */
const GENDER_TERMS: Readonly<Record<string, string>> = {
  men: "men",
  mens: "men",
  "men's": "men",
  man: "men",
  male: "men",
  women: "women",
  womens: "women",
  "women's": "women",
  woman: "women",
  female: "women",
  unisex: "unisex",
  boys: "boys",
  girls: "girls",
  kids: "kids",
  baby: "baby",
};

/**
 * Multi-word phrases are matched before single words, longest first.
 *
 * Without this, "cell phone case" would match "cell" and "phone" separately and
 * never see the phrase that actually names the category.
 */
const MAX_PHRASE_WORDS = 4;

/**
 * Build the index the matcher uses.
 *
 * Done once per request (or per cache lifetime), not per token: scanning the
 * whole lexicon for every token would be quadratic on a large catalog.
 */
export interface LexiconIndex {
  /** term -> entries carrying that term */
  byTerm: Map<string, LexiconEntry[]>;
  /** longest phrase length present, to bound the n-gram window */
  maxPhraseWords: number;
}

export function indexLexicon(lexicon: Lexicon): LexiconIndex {
  const byTerm = new Map<string, LexiconEntry[]>();
  let maxPhraseWords = 1;

  for (const entry of lexicon.entries) {
    const forms = new Set<string>([entry.term, ...(entry.aliases ?? [])]);
    for (const form of forms) {
      const folded = form.trim().toLowerCase();
      if (!folded) continue;
      const bucket = byTerm.get(folded);
      if (bucket) bucket.push(entry);
      else byTerm.set(folded, [entry]);
      maxPhraseWords = Math.max(maxPhraseWords, folded.split(/\s+/).length);
    }
  }

  // Derive ambiguity here rather than trusting the caller to pre-compute it. A
  // term with several distinct meanings in this catalog is less likely to be any
  // one of them, and that has to lower its confidence — otherwise "apple" is
  // applied as a brand filter and the fruit results silently disappear.
  for (const [term, entries] of byTerm) {
    const meanings = new Set(entries.map((entry) => `${entry.kind}:${entry.value}`));
    if (meanings.size <= 1) continue;
    for (const entry of entries) {
      const existing = entry.ambiguity ?? 1;
      entry.ambiguity = Math.max(existing, meanings.size);
    }
    void term;
  }

  return { byTerm, maxPhraseWords: Math.min(maxPhraseWords, MAX_PHRASE_WORDS) };
}

/**
 * Extract entities from a token list.
 *
 * Returns the entities found and the tokens that remain for text matching. A
 * token consumed by a *confident* entity is removed from the remaining terms; a
 * token behind an ambiguous entity is kept, because dropping it would narrow the
 * search on a guess.
 */
export function extractEntities(
  tokens: readonly string[],
  index: LexiconIndex,
  options: { applyThreshold?: number } = {},
): { entities: ExtractedEntity[]; remainingTokens: string[] } {
  const threshold = options.applyThreshold ?? ENTITY_APPLY_THRESHOLD;
  const entities: ExtractedEntity[] = [];
  const consumed = new Set<number>();

  // Longest phrase first, so "running shoe" wins over "shoe".
  const windowLimit = Math.min(index.maxPhraseWords, tokens.length);
  for (let size = windowLimit; size >= 1; size -= 1) {
    for (let start = 0; start + size <= tokens.length; start += 1) {
      if (consumed.has(start)) continue;
      let overlaps = false;
      for (let offset = 0; offset < size; offset += 1) {
        if (consumed.has(start + offset)) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;

      const phrase = tokens.slice(start, start + size).join(" ");
      const matches = index.byTerm.get(phrase);
      if (!matches || matches.length === 0) continue;

      for (const entry of matches) {
        const confidence = entityConfidence(entry, tokens.length);
        entities.push({
          kind: entry.kind,
          matched: phrase,
          value: entry.value,
          axis: entry.axis,
          id: entry.id,
          confidence,
        });

        // Consume the span only when the term is unambiguous AND confident.
        //
        // An ambiguous term ("apple" = a brand here and a fruit) is still
        // reported so facets and ranking can use it, but it must stay in the
        // search text. Removing it would turn the query into a brand filter and
        // silently delete the other meaning's results — a guess the shopper
        // never made and cannot see.
        const ambiguous = (entry.ambiguity ?? 1) > 1;
        if (!ambiguous && confidence >= threshold) {
          for (let offset = 0; offset < size; offset += 1) consumed.add(start + offset);
        }
      }
      // Continue to the next position rather than breaking: the `consumed`
      // check at the top of the loop already skips spans claimed by a longer
      // phrase, and breaking here would abandon every later token in the query.
    }
  }

  const remainingTokens = tokens.filter((_token, position) => !consumed.has(position));
  return { entities, remainingTokens };
}

/**
 * How confident we are that this entry is what the query meant.
 *
 * Penalised for ambiguity (the term means several things in this catalog) and
 * rewarded for prevalence (the term covers many products, so it is likely a real
 * shopping term rather than a stray word).
 */
export function entityConfidence(entry: LexiconEntry, queryTokenCount: number): number {
  const ambiguity = entry.ambiguity ?? 1;
  // A term with three meanings in the catalog is a third as likely to be the one
  // the shopper meant.
  const ambiguityScore = 1 / Math.max(1, ambiguity);

  const productCount = entry.productCount ?? 0;
  const prevalence = Math.min(1, Math.log10(productCount + 1) / 3);

  // A single-token query that is entirely a brand name ("nike") is almost
  // certainly a brand search. A brand mentioned inside a long query is more
  // likely incidental.
  const specificity = queryTokenCount <= 2 ? 1 : 0.85;

  const score = (ambiguityScore * 0.6 + prevalence * 0.4) * specificity;
  return Math.round(Math.min(1, score) * 1000) / 1000;
}

/**
 * Recognise a gender term.
 *
 * Kept separate from the lexicon because gender is a fixed, small, universal
 * vocabulary — it does not need a database lookup, and hard-coding it here is
 * cheaper than a table for eight words.
 */
export function extractGender(token: string): ExtractedEntity | null {
  const value = GENDER_TERMS[token.toLowerCase()];
  if (!value) return null;
  return {
    kind: "GENDER",
    matched: token,
    value,
    axis: "gender",
    confidence: 0.8,
  };
}

/**
 * Reduce extracted entities to the filters the caller should apply.
 *
 * Only entities above the confidence threshold are applied, and each axis takes
 * at most its own set of values — a query mentioning two colours filters on both,
 * which is an OR within the axis and an AND across axes, matching how shoppers
 * expect facet filters to behave.
 */
export function entitiesToFilters(
  entities: readonly ExtractedEntity[],
  options: { threshold?: number } = {},
): {
  brandIds: string[];
  categoryIds: string[];
  attributes: Record<string, string[]>;
} {
  const threshold = options.threshold ?? ENTITY_APPLY_THRESHOLD;
  const brandIds: string[] = [];
  const categoryIds: string[] = [];
  const attributes: Record<string, string[]> = {};

  for (const entity of entities) {
    if (entity.confidence < threshold) continue;

    switch (entity.kind) {
      case "BRAND":
        if (entity.id && !brandIds.includes(entity.id)) brandIds.push(entity.id);
        break;
      case "CATEGORY":
        if (entity.id && !categoryIds.includes(entity.id)) categoryIds.push(entity.id);
        break;
      case "ATTRIBUTE":
      case "COLOR":
      case "SIZE":
      case "GENDER":
      case "MATERIAL": {
        const axis = entity.axis ?? entity.kind.toLowerCase();
        const values = attributes[axis] ?? [];
        if (!values.includes(entity.value)) values.push(entity.value);
        attributes[axis] = values;
        break;
      }
    }
  }

  return { brandIds, categoryIds, attributes };
}

/**
 * Classify what the shopper is trying to do.
 *
 * Deliberately conservative: when the signals are mixed the answer is BROAD,
 * because a wrong intent silently rewrites the query. The intent is advisory —
 * it tunes ranking and presentation, it never filters results out.
 */
export function detectIntent(input: {
  tokens: readonly string[];
  entities: readonly ExtractedEntity[];
  isExactIdentifier: boolean;
}): SearchIntent {
  if (input.isExactIdentifier) return "NAVIGATIONAL";
  if (input.tokens.length === 0) return "BROAD";

  const brands = input.entities.filter((entity) => entity.kind === "BRAND");
  const categories = input.entities.filter((entity) => entity.kind === "CATEGORY");

  // A query that is only a brand name is a brand browse.
  if (brands.length > 0 && categories.length === 0 && input.tokens.length <= 2) return "BRAND";
  if (categories.length > 0) return "CATEGORY";
  if (brands.length > 0) return "BRAND";
  // A long, specific token run with no recognised entities still usually names a
  // product, and ranking it as such is the better default than BROAD.
  if (input.tokens.length >= 3) return "PRODUCT";
  return "BROAD";
}
