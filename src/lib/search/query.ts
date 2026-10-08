/**
 * The query processing pipeline.
 *
 *   raw input
 *     → normalize          (fold, collapse, bound length)
 *     → tokenize           (keep identifiers intact)
 *     → price extraction   ("under 50k" → maxPricePaise)
 *     → abbreviation pass  ("laptops" → also "laptop")
 *     → spell correction   (only to terms that exist in this catalog)
 *     → synonym expansion
 *     → entity extraction  (brand / category / attribute)
 *     → intent detection
 *     → ProcessedQuery
 *
 * Every step is pure: the pipeline takes the query plus the data it needs
 * (vocabulary, synonyms, lexicon) and returns a `ProcessedQuery`. Nothing here
 * touches the database, which is what makes the whole thing unit-testable and
 * lets a future worker run the same pipeline off the request path.
 *
 * The order is load-bearing. Price is extracted before tokenizing for matching so
 * "50000" never becomes a search term; spell correction runs before entity
 * extraction so "adiddas" is recognised as the brand "Adidas" rather than being
 * discarded as an unknown word.
 */

import {
  expandAbbreviations,
  extractPriceConstraint,
  normalizeQuery,
  type NormalizedQuery,
} from "@/lib/search/normalize";
import {
  AUTO_APPLY_CONFIDENCE,
  correctQueryTokens,
  correctionConfidence,
  type CorrectionOptions,
  type VocabularyTerm,
} from "@/lib/search/spell";
import {
  detectIntent,
  extractEntities,
  extractGender,
  type LexiconIndex,
} from "@/lib/search/entities";
import type { PriceConstraint, ProcessedQuery } from "@/lib/search/types";
import { expandWithSynonyms, synonymGroups } from "@/lib/catalog/search-text";

export interface PipelineInput {
  /** Spell-correction dictionary, from `search_vocabulary`. */
  vocabulary?: readonly VocabularyTerm[];
  /** Synonym map, from `search_synonyms`. */
  synonyms?: ReadonlyMap<string, string[]>;
  /** Brand/category/attribute lexicon for entity extraction. */
  lexicon?: LexiconIndex;
  /** Override correction behaviour. */
  correction?: CorrectionOptions;
  /** Set false to disable correction entirely (e.g. a SKU search). */
  autoCorrect?: boolean;
}

export interface PipelineResult extends ProcessedQuery {
  /** The intermediate forms, exposed for logging and the admin debug view. */
  stages: {
    sanitized: string;
    normalized: string;
    priceStripped: string;
    afterCorrection: string;
    afterSynonyms: string[];
  };
  /**
   * True when a correction was applied to the executed query rather than merely
   * suggested. Drives whether the UI says "Showing results for X".
   */
  correctionApplied: boolean;
  /** Corrections that were found but not confident enough to apply. */
  suggestedCorrections: Array<{ from: string; to: string; confidence: number }>;
  /** Canonical form of the corrected query; the analytics and cache key. */
  correctedQueryCanonical: string | null;
}

/**
 * Run the full pipeline over a raw query.
 *
 * Never throws: a malformed query yields an empty-but-valid result rather than a
 * 500, because search is the one endpoint a shopper hits without thinking.
 */
export function processQuery(rawQuery: string, input: PipelineInput = {}): PipelineResult {
  const autoCorrect = input.autoCorrect ?? true;

  // ── Stage 1-2: normalize and tokenize ────────────────────────────────
  const normalized: NormalizedQuery = normalizeQuery(rawQuery, { keepStopWords: false });

  if (!normalized.raw.trim()) {
    return emptyPipelineResult(normalized, []);
  }

  // An SKU or barcode search must match exactly. Running it through spell
  // correction would "fix" the identifier, which is the worst possible outcome.
  if (normalized.isExactIdentifier) {
    return {
      ...emptyPipelineResult(normalized, normalized.rawTokens),
      intent: "NAVIGATIONAL",
      isExactIdentifier: true,
      stages: {
        sanitized: normalized.raw,
        normalized: normalized.normalized,
        priceStripped: normalized.normalized,
        afterCorrection: normalized.normalized,
        afterSynonyms: normalized.rawTokens,
      },
      correctionApplied: false,
      suggestedCorrections: [],
      correctedQueryCanonical: null,
    };
  }

  // ── Stage 3: price extraction ────────────────────────────────────────
  const { constraint, remaining } = extractPriceConstraint(normalized.normalized);
  const priceQuery = remaining ? normalizeQuery(remaining, { keepStopWords: false }) : normalized;
  const baseTokens = expandAbbreviations(priceQuery.terms.length ? priceQuery.terms : normalized.terms);

  // ── Stage 4: spell correction ────────────────────────────────────────
  const vocabulary = input.vocabulary ?? [];
  const correctionOptions: CorrectionOptions = {
    maxEditDistance: input.correction?.maxEditDistance ?? 1,
    minDocumentCount: input.correction?.minDocumentCount ?? 1,
    minSimilarity: input.correction?.minSimilarity ?? 0.55,
    strictShortTokens: input.correction?.strictShortTokens ?? true,
  };

  const corrected =
    autoCorrect && vocabulary.length > 0
      ? correctQueryTokens(baseTokens, vocabulary, correctionOptions)
      : { tokens: baseTokens, corrections: [] };

  // Only corrections the evidence supports are applied; the rest are offered as
  // "did you mean?" so the shopper decides.
  const applied: typeof corrected.corrections = [];
  const suggested: Array<{ from: string; to: string; confidence: number }> = [];
  const executedTokens = corrected.tokens.map((token, index) => {
    const correction = corrected.corrections.find((entry) => entry.to === token);
    if (!correction) return token;
    const original = baseTokens[index] ?? correction.from;
    const confidence = correctionConfidence(correction, original.length);
    if (confidence >= AUTO_APPLY_CONFIDENCE) {
      applied.push(correction);
      return token;
    }
    suggested.push({ from: correction.from, to: correction.to, confidence });
    // Below the threshold the original token is what gets searched.
    return original;
  });

  const afterCorrection = executedTokens.join(" ");

  // ── Stage 5: synonym expansion ───────────────────────────────────────
  const synonyms = input.synonyms ?? new Map<string, string[]>();
  const expanded = executedTokens.length
    ? expandWithSynonyms(afterCorrection, synonyms)
    : [];

  // ── Stage 6: entity extraction ───────────────────────────────────────
  // Entities are extracted from the corrected tokens, so "adiddas" resolves to
  // the brand rather than being dropped as noise.
  const extracted = input.lexicon
    ? extractEntities(executedTokens, input.lexicon)
    : { entities: [], remainingTokens: executedTokens };

  // Gender is a fixed vocabulary, so it is recognised without a lexicon.
  const genderEntities = executedTokens
    .map((token) => extractGender(token))
    .filter((entity): entity is NonNullable<typeof entity> => entity !== null);

  const entities = [...extracted.entities, ...genderEntities];
  const remainingTerms = dedupe([
    ...extracted.remainingTokens,
    ...genderEntities.filter((entity) => entity.confidence < 0.6).map((entity) => entity.matched),
  ]);

  // ── Stage 7: intent ──────────────────────────────────────────────────
  const intent = detectIntent({
    tokens: executedTokens,
    entities,
    isExactIdentifier: false,
  });

  // The display form is the query as the shopper will see it echoed back; the
  // canonical form is what the cache and analytics key on. Both are needed
  // because they answer different questions.
  const correctedDisplay =
    applied.length > 0 ? normalizeQuery(applied.map((entry) => entry.to).join(" ")).normalized : null;

  return {
    raw: normalized.raw,
    normalized: normalized.normalized,
    canonical: canonicalOf(executedTokens),
    tokens: executedTokens,
    remainingTerms,
    intent,
    entities,
    price: constraint as PriceConstraint | null,
    corrections: applied,
    correctedQuery: correctedDisplay,
    synonymsApplied: expanded,
    isExactIdentifier: false,
    stages: {
      sanitized: normalized.raw,
      normalized: normalized.normalized,
      priceStripped: priceQuery.normalized,
      afterCorrection,
      afterSynonyms: expanded,
    },
    correctionApplied: applied.length > 0,
    suggestedCorrections: suggested,
    correctedQueryCanonical: applied.length > 0 ? canonicalOf(applied.map((entry) => entry.to)) : null,
  };
}

function canonicalOf(tokens: readonly string[]): string {
  return [...new Set(tokens)].sort().join(" ");
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/**
 * The shape every code path returns, so a caller never has to special-case an
 * empty or identifier query.
 */
function emptyPipelineResult(normalized: NormalizedQuery, terms: string[]): PipelineResult {
  return {
    raw: normalized.raw,
    normalized: normalized.normalized,
    canonical: normalized.canonical,
    tokens: terms,
    remainingTerms: terms,
    intent: "BROAD",
    entities: [],
    price: null,
    corrections: [],
    correctedQuery: null,
    synonymsApplied: [],
    isExactIdentifier: normalized.isExactIdentifier,
    stages: {
      sanitized: normalized.raw,
      normalized: normalized.normalized,
      priceStripped: normalized.normalized,
      afterCorrection: terms.join(" "),
      afterSynonyms: terms,
    },
    correctionApplied: false,
    suggestedCorrections: [],
    correctedQueryCanonical: null,
  };
}

/**
 * The synonym groups for the executed query.
 *
 * Returned separately from `synonymsApplied` because the database needs the
 * grouped form (OR within a group, AND across groups) while the UI needs the
 * flat list. Handing out both avoids a caller re-deriving one from the other.
 */
export function querySynonymGroups(
  processed: Pick<ProcessedQuery, "tokens">,
  synonyms: ReadonlyMap<string, string[]>,
): string[][] {
  return synonymGroups(processed.tokens.join(" "), synonyms);
}

/** A short, stable signature of the active filters — safe to log and to cache on. */
export function filterSignature(filters: {
  categoryIds?: string[];
  brandIds?: string[];
  minPricePaise?: number | null;
  maxPricePaise?: number | null;
  minRating?: number | null;
  availability?: string;
  attributes?: Record<string, string[]>;
}): string {
  const parts: string[] = [];
  if (filters.categoryIds?.length) parts.push(`c:${[...filters.categoryIds].sort().join(",")}`);
  if (filters.brandIds?.length) parts.push(`b:${[...filters.brandIds].sort().join(",")}`);
  if (filters.minPricePaise != null) parts.push(`p>:${filters.minPricePaise}`);
  if (filters.maxPricePaise != null) parts.push(`p<:${filters.maxPricePaise}`);
  if (filters.minRating != null) parts.push(`r:${filters.minRating}`);
  if (filters.availability && filters.availability !== "any") parts.push(`a:${filters.availability}`);
  for (const axis of Object.keys(filters.attributes ?? {}).sort()) {
    const values = (filters.attributes ?? {})[axis] ?? [];
    if (values.length) parts.push(`${axis}:${[...values].sort().join(",")}`);
  }
  return parts.join("|");
}
