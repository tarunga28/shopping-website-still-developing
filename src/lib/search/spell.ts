/**
 * Controlled spell correction.
 *
 * ## Why this is not "fuzzy-match everything"
 *
 * Blind fuzzy matching is how a search engine returns a refrigerator for
 * "refridgerator case". The rule here is narrow and deliberate:
 *
 *   **A token may only be corrected to a term that exists in this catalog.**
 *
 * The candidate list comes from `search_vocabulary` — real product words, brand
 * names, category names, attribute values and tags. So "iphne" becomes "iphone"
 * because "iphone" is a brand in this store, not because an edit-distance
 * function thought they were close. A token with no near neighbour in the
 * vocabulary is left alone and matched as-is.
 *
 * ## What is never corrected
 *
 *   - Pure numbers and model numbers ("17", "a17-256gb"). Correcting a model
 *     number produces a confidently wrong answer, which is worse than no answer.
 *   - Tokens of two characters or fewer, where the edit distance is dominated by
 *     noise.
 *   - Tokens that already match the vocabulary exactly.
 */

import { isProtectedToken } from "@/lib/search/normalize";
import type { QueryCorrection } from "@/lib/search/types";

/** A term the engine may correct *to*. */
export interface VocabularyTerm {
  term: string;
  source: string;
  documentCount: number;
}

/**
 * Damerau-Levenshtein distance with an early-exit ceiling.
 *
 * Transpositions count as one edit rather than two, because "ipohne" -> "iphone"
 * is a transposition and transposed adjacent letters are the most common typo
 * there is. The ceiling matters for performance: it lets the caller ask "is this
 * within one edit?" without paying for the full matrix on long strings.
 */
export function editDistance(a: string, b: string, maxDistance = 0): number {
  if (a === b) return 0;
  const pointsA = toCodePoints(a);
  const pointsB = toCodePoints(b);
  if (pointsA.length === 0) return pointsB.length;
  if (pointsB.length === 0) return pointsA.length;

  const lengthDifference = Math.abs(pointsA.length - pointsB.length);
  if (maxDistance > 0 && lengthDifference > maxDistance) return maxDistance + 1;

  let beforePrevious = new Array<number>(pointsB.length + 1);
  let previous = new Array<number>(pointsB.length + 1);
  let current = new Array<number>(pointsB.length + 1);
  for (let column = 0; column <= pointsB.length; column += 1) previous[column] = column;

  for (let i = 1; i <= pointsA.length; i += 1) {
    current[0] = i;
    let rowMinimum = current[0];

    for (let j = 1; j <= pointsB.length; j += 1) {
      const substitutionCost = pointsA[i - 1] === pointsB[j - 1] ? 0 : 1;
      let best = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + substitutionCost);

      if (
        i > 1 &&
        j > 1 &&
        pointsA[i - 1] === pointsB[j - 2] &&
        pointsA[i - 2] === pointsB[j - 1]
      ) {
        best = Math.min(best, beforePrevious[j - 2]! + 1);
      }

      current[j] = best;
      rowMinimum = Math.min(rowMinimum, best);
    }

    if (maxDistance > 0 && rowMinimum > maxDistance) return maxDistance + 1;

    const swap = beforePrevious;
    beforePrevious = previous;
    previous = current;
    current = swap;
  }

  return previous[pointsB.length]!;
}

function toCodePoints(text: string): number[] {
  return Array.from(text).map((character) => character.codePointAt(0) ?? 0);
}

/**
 * Jaro-Winkler similarity in [0, 1].
 *
 * Used as a tiebreaker between two candidate corrections at the same edit
 * distance: of "iphone" and "ipnone", the one sharing a longer prefix with the
 * query is the likelier intent, and Jaro-Winkler is the standard way to express
 * that.
 */
export function jaroWinkler(a: string, b: string, prefixScale = 0.1): number {
  const pointsA = toCodePoints(a);
  const pointsB = toCodePoints(b);
  if (pointsA.length === 0 && pointsB.length === 0) return 1;
  if (pointsA.length === 0 || pointsB.length === 0) return 0;

  const window = Math.max(0, Math.floor(Math.max(pointsA.length, pointsB.length) / 2) - 1);
  const matchedA = new Array<boolean>(pointsA.length).fill(false);
  const matchedB = new Array<boolean>(pointsB.length).fill(false);
  let matches = 0;

  for (let i = 0; i < pointsA.length; i += 1) {
    const start = Math.max(0, i - window);
    const end = Math.min(pointsB.length, i + window + 1);
    for (let j = start; j < end; j += 1) {
      if (matchedB[j] || pointsA[i] !== pointsB[j]) continue;
      matchedA[i] = true;
      matchedB[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let cursor = 0;
  for (let i = 0; i < pointsA.length; i += 1) {
    if (!matchedA[i]) continue;
    while (!matchedB[cursor]) cursor += 1;
    if (pointsA[i] !== pointsB[cursor]) transpositions += 1;
    cursor += 1;
  }

  const matchCount = matches;
  const jaro =
    (matchCount / pointsA.length +
      matchCount / pointsB.length +
      (matchCount - transpositions / 2) / matchCount) /
    3;

  let prefix = 0;
  const limit = Math.min(pointsA.length, pointsB.length, 4);
  while (prefix < limit && pointsA[prefix] === pointsB[prefix]) prefix += 1;

  return jaro + prefix * Math.min(prefixScale, 0.25) * (1 - jaro);
}

/** Character trigram (Dice) similarity — mirrors PostgreSQL's `word_similarity`. */
export function trigramSimilarity(a: string, b: string): number {
  const shinglesA = shingles(a);
  const shinglesB = shingles(b);
  if (shinglesA.size === 0 || shinglesB.size === 0) return a === b ? 1 : 0;

  const pool = new Map<string, number>();
  for (const shingle of shinglesA) pool.set(shingle, (pool.get(shingle) ?? 0) + 1);

  let intersection = 0;
  for (const shingle of shinglesB) {
    const remaining = pool.get(shingle) ?? 0;
    if (remaining > 0) {
      pool.set(shingle, remaining - 1);
      intersection += 1;
    }
  }

  return (2 * intersection) / (shinglesA.size + shinglesB.size);
}

function shingles(text: string): Set<string> {
  const out = new Set<string>();
  if (text.length < 3) {
    out.add(text);
    return out;
  }
  for (let index = 0; index + 3 <= text.length; index += 1) out.add(text.slice(index, index + 3));
  return out;
}

export interface CorrectionOptions {
  /** Maximum edit distance. 0 disables correction entirely. */
  maxEditDistance?: number;
  /** A candidate must be at least this common to be offered. */
  minDocumentCount?: number;
  /** Below this similarity a candidate is rejected even within edit distance. */
  minSimilarity?: number;
  /** Shorter tokens are corrected less aggressively — see `editDistanceFor`. */
  strictShortTokens?: boolean;
}

/**
 * The edit distance allowed for a token of this length.
 *
 * A one-edit correction on a four-letter word changes a quarter of it, which is
 * often a different word entirely. Requiring length >= 4 for one edit and >= 7
 * for two keeps corrections conservative where they matter most.
 */
export function editDistanceFor(token: string, maxEditDistance: number, strictShortTokens = true): number {
  if (maxEditDistance <= 0) return 0;
  if (!strictShortTokens) return maxEditDistance;
  if (token.length < 4) return 0;
  if (token.length < 7) return Math.min(1, maxEditDistance);
  return Math.min(2, maxEditDistance);
}

/**
 * Suggest a correction for one token.
 *
 * Returns null when the token should be left alone — which is the common case,
 * and the correct one.
 */
export function suggestCorrection(
  token: string,
  vocabulary: readonly VocabularyTerm[],
  options: CorrectionOptions = {},
): QueryCorrection | null {
  const maxEditDistance = options.maxEditDistance ?? 1;
  const minDocumentCount = options.minDocumentCount ?? 1;
  const minSimilarity = options.minSimilarity ?? 0.55;

  if (maxEditDistance <= 0) return null;
  if (isProtectedToken(token)) return null;

  const allowed = editDistanceFor(token, maxEditDistance, options.strictShortTokens ?? true);
  if (allowed <= 0) return null;

  let best: { term: VocabularyTerm; distance: number; similarity: number } | null = null;

  for (const candidate of vocabulary) {
    if (candidate.term === token) return null; // already a real term
    if (candidate.documentCount < minDocumentCount) continue;

    // Length filter first: it is far cheaper than the distance computation it
    // avoids, and strings differing in length by more than the allowed distance
    // cannot be within it.
    if (Math.abs(candidate.term.length - token.length) > allowed) continue;

    const distance = editDistance(token, candidate.term, allowed);
    if (distance > allowed) continue;

    const similarity = Math.max(jaroWinkler(token, candidate.term), trigramSimilarity(token, candidate.term));
    if (similarity < minSimilarity) continue;

    // Prefer: smaller distance, then higher similarity, then a more common term.
    // Commonality last is deliberate — a rare exact-shape match beats a common
    // loose one, because shape is the stronger evidence.
    const better =
      best === null ||
      distance < best.distance ||
      (distance === best.distance && similarity > best.similarity + 0.001) ||
      (distance === best.distance &&
        Math.abs(similarity - best.similarity) <= 0.001 &&
        candidate.documentCount > best.term.documentCount);

    if (better) best = { term: candidate, distance, similarity };
  }

  if (!best) return null;

  return {
    from: token,
    to: best.term.term,
    distance: best.distance,
    documentCount: best.term.documentCount,
  };
}

/**
 * Correct a whole query, token by token.
 *
 * Returns the corrected token list and the corrections applied. A query is only
 * rewritten when at least one token changed, so `correctedTokens` equals the
 * input when nothing was confidently fixable.
 */
export function correctQueryTokens(
  tokens: readonly string[],
  vocabulary: readonly VocabularyTerm[],
  options: CorrectionOptions = {},
): { tokens: string[]; corrections: QueryCorrection[] } {
  const corrections: QueryCorrection[] = [];
  const out: string[] = [];

  for (const token of tokens) {
    const correction = suggestCorrection(token, vocabulary, options);
    if (correction) {
      corrections.push(correction);
      out.push(correction.to);
    } else {
      out.push(token);
    }
  }

  return { tokens: out, corrections };
}

/**
 * Confidence that a correction is what the shopper meant, in [0, 1].
 *
 * Used to decide whether to *apply* the correction or merely *suggest* it. A
 * high-confidence correction ("iphne" -> "iphone", a brand with 4,000 products)
 * is applied silently; a low-confidence one is shown as "Did you mean…?" so the
 * shopper can decline.
 */
export function correctionConfidence(correction: QueryCorrection, tokenLength: number): number {
  // Shape similarity: fewer edits over a longer token is stronger evidence.
  const shapeScore = Math.max(0, 1 - correction.distance / Math.max(1, tokenLength));
  // Commonality: a correction to a term used by many products is safer.
  const commonality = Math.min(1, Math.log10(correction.documentCount + 1) / 3);
  return Math.round(Math.min(1, shapeScore * 0.6 + commonality * 0.4) * 1000) / 1000;
}

/** Above this, apply the correction without asking. Below it, suggest only. */
export const AUTO_APPLY_CONFIDENCE = 0.62;
