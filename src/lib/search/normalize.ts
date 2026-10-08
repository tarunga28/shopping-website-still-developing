/**
 * Query normalization.
 *
 * Everything in here is pure and synchronous, so the whole normalization
 * behaviour is testable without a database and identical on the server and in
 * any future worker.
 *
 * Two rules shape the design:
 *
 * 1. **Never destroy an identifier.** Folding case and collapsing whitespace is
 *    safe; "correcting" `a17-256gb` is not. Tokenization therefore keeps the
 *    raw token alongside the split pieces, so an SKU stays searchable exactly
 *    even though its parts are searchable too.
 * 2. **A bare number is not a price filter.** "50k" normalizes to `50000`, but
 *    it only becomes a constraint when the query says something directional —
 *    "under 50k". Guessing that "laptop 50000" means "laptop below ₹50000"
 *    would silently hide products the shopper was looking for.
 */

import { canonicalQuery as canonicalize, sanitizeQuery, tokenize } from "@/lib/catalog/search-text";

/** Rupee amounts in a query are whole rupees; the catalog stores paise. */
export const PAISE_PER_RUPEE = 100;

/** Longest query accepted. Longer input is truncated, not rejected. */
export const MAX_QUERY_LENGTH = 120;

/**
 * Multipliers for Indian shorthand.
 *
 * `m` is deliberately absent: in a catalog it means meters as often as million,
 * and guessing wrong produces a nonsense price band.
 */
const AMOUNT_SUFFIXES: Readonly<Record<string, number>> = {
  k: 1_000,
  l: 100_000,
  lakh: 100_000,
  lakhs: 100_000,
  cr: 10_000_000,
  crore: 10_000_000,
  crores: 10_000_000,
};

/**
 * Shopping abbreviations expanded before matching.
 *
 * Kept deliberately small and unambiguous. Every entry here is a place where a
 * shopper's word and the catalog's word genuinely differ, and where expanding
 * cannot make the query mean something else.
 */
const ABBREVIATIONS: Readonly<Record<string, string>> = {
  mobiles: "mobile",
  phones: "phone",
  laptop: "laptop",
  laptops: "laptop",
  tvs: "tv",
  television: "tv",
  headphones: "headphone",
  earphones: "earphone",
  sneakers: "sneaker",
  shoes: "shoe",
  shirts: "shirt",
  tshirt: "tshirt",
  tshirts: "tshirt",
  smartphone: "smartphone",
  watch: "watch",
  watches: "watch",
};

/** Words that carry no retrieval signal and only add noise to matching. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "with",
  "in",
  "on",
  "of",
  "to",
  "is",
  "are",
  "best",
  "good",
  "cheap",
  "buy",
  "new",
  "online",
  "price",
  "prices",
  "rate",
  "rates",
]);

/**
 * Words that express a direction on price.
 *
 * Grouped by the bound they set, because "under" and "below" behave identically
 * and keeping them in one list is what stops them drifting apart.
 */
const MAX_PRICE_WORDS: ReadonlySet<string> = new Set([
  "under",
  "below",
  "upto",
  "up",
  "less",
  "max",
  "maximum",
  "cheaper",
]);
const MIN_PRICE_WORDS: ReadonlySet<string> = new Set([
  "above",
  "over",
  "more",
  "min",
  "minimum",
  "greater",
  "atleast",
]);
/** Words that only matter as part of a phrase ("less than", "more than"). */
const COMPARATOR_TAILS: ReadonlySet<string> = new Set(["than", "then"]);

export interface NormalizedQuery {
  /** Sanitized original: control characters stripped, length bounded. */
  raw: string;
  /** Folded and collapsed. */
  normalized: string;
  /** Sorted, deduplicated tokens — the cache and analytics key. */
  canonical: string;
  /**
   * Tokens after folding and stop-word removal. This is what gets matched.
   */
  terms: string[];
  /** Raw tokens before stop-word removal, preserving identifiers. */
  rawTokens: string[];
  /** True when the query looks like a bare SKU or barcode. */
  isExactIdentifier: boolean;
}

/** Fold a single token: lowercase, trim punctuation, keep alphanumerics. */
export function foldToken(token: string): string {
  return token
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/**
 * Collapse an over-long run of a repeated character: "iphooone" -> "iphone".
 *
 * Capped at two repeats rather than one, because English legitimately doubles
 * letters ("dress", "coffee") and collapsing those would break real words.
 */
export function collapseRepeats(token: string, maxRun = 2): string {
  if (maxRun < 1) return token;
  return token.replace(/(.)\1{2,}/g, (_match, character: string) => character.repeat(maxRun));
}

/**
 * Parse an Indian-market amount into paise.
 *
 * Handles the forms that actually appear in queries: `50000`, `50,000`, `50k`,
 * `1.5l`, `₹50000`, `rs 50000`, `50000 rupees`. Returns null for anything that
 * is not an amount, so a model number like `17` is left alone by the caller.
 */
export function parseAmountPaise(text: string): number | null {
  const cleaned = text
    .trim()
    // A leading currency symbol or word is decoration, not part of the number.
    .replace(/^(?:₹|rs\.?|inr|₨)\s*/i, "")
    .replace(/\s*(?:rupees|rupee|rs\.?)$/i, "")
    .replace(/,/g, "");

  if (!cleaned) return null;

  const match = /^(\d+(?:\.\d{1,2})?)([a-z]*)$/i.exec(cleaned);
  if (!match) return null;

  const numeric = Number.parseFloat(match[1]!);
  if (!Number.isFinite(numeric) || numeric < 0) return null;

  const suffix = match[2]!.toLowerCase();
  const multiplier = suffix ? AMOUNT_SUFFIXES[suffix] : 1;
  if (multiplier === undefined) return null;

  const rupees = numeric * multiplier;
  // Rounded, not truncated: ₹1.005 is 100.5 paise and a half-paise cannot exist.
  return Math.round(rupees * PAISE_PER_RUPEE);
}

/**
 * Extract a price constraint from a query.
 *
 * Returns the constraint and the query with the price phrase removed, so the
 * remaining text can be matched as product terms without "under" and "50000"
 * polluting the search.
 */
export function extractPriceConstraint(
  query: string,
): { constraint: { minPaise: number | null; maxPaise: number | null; source: string } | null; remaining: string } {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { constraint: null, remaining: query };

  // Detect a range first. "between 30000 and 50000" and "1000 to 2000" contain
  // no comparator word at all, so without this pass neither number is recognised
  // as an amount and the range is silently ignored.
  const rangeIndices = findRangeIndices(tokens);

  const amounts: Array<{ index: number; paise: number }> = [];
  tokens.forEach((token, index) => {
    // Only treat a token as an amount when it carries a price marker, sits next
    // to a comparator, or is one end of a range. Otherwise a model number like
    // the "17" in "iphone 17" becomes a price band.
    const looksLikePrice = /^(?:₹|rs\.?|inr)/i.test(token) || /(k|l|lakh|cr|crore)$/i.test(token) || /rupees?$/i.test(token);
    const paise = parseAmountPaise(token);
    if (paise === null) return;
    if (looksLikePrice || rangeIndices.has(index) || hasAdjacentComparator(tokens, index)) {
      amounts.push({ index, paise });
    }
  });

  if (amounts.length === 0) return { constraint: null, remaining: query };

  const consumed = new Set<number>();
  let minPaise: number | null = null;
  let maxPaise: number | null = null;
  const sourceParts: string[] = [];

  for (const amount of amounts) {
    const before = tokens[amount.index - 1]?.toLowerCase() ?? "";
    const twoBefore = tokens[amount.index - 2]?.toLowerCase() ?? "";

    consumed.add(amount.index);
    sourceParts.push(tokens[amount.index]!);

    const setsMax = MAX_PRICE_WORDS.has(before) || (MAX_PRICE_WORDS.has(twoBefore) && COMPARATOR_TAILS.has(before));
    const setsMin = MIN_PRICE_WORDS.has(before) || (MIN_PRICE_WORDS.has(twoBefore) && COMPARATOR_TAILS.has(before));

    if (setsMax) {
      maxPaise = maxPaise === null ? amount.paise : Math.min(maxPaise, amount.paise);
      consumed.add(amount.index - 1);
      if (COMPARATOR_TAILS.has(before)) consumed.add(amount.index - 2);
      sourceParts.unshift(tokens[amount.index - 1]!);
    } else if (setsMin) {
      minPaise = minPaise === null ? amount.paise : Math.max(minPaise, amount.paise);
      consumed.add(amount.index - 1);
      if (COMPARATOR_TAILS.has(before)) consumed.add(amount.index - 2);
      sourceParts.unshift(tokens[amount.index - 1]!);
    } else if (amounts.length >= 2) {
      // "between 30000 and 50000" / "30000 to 80000": the smaller is the floor.
      const other = amounts.find((candidate) => candidate.index !== amount.index);
      if (other) {
        minPaise = Math.min(amount.paise, other.paise);
        maxPaise = Math.max(amount.paise, other.paise);
        consumed.add(other.index);
        // Drop the connective ("and", "to", "-") too.
        for (const between of [amount.index - 1, other.index - 1]) {
          if (between >= 0) consumed.add(between);
        }
        sourceParts.push(tokens[other.index]!);
        break;
      }
    }
    // A bare amount with no comparator and no partner is not a filter; leaving
    // it unconsumed keeps it as a searchable term.
  }

  if (minPaise === null && maxPaise === null) return { constraint: null, remaining: query };
  // Consume the "between"/"from" lead-in when present.
  tokens.forEach((token, index) => {
    const lower = token.toLowerCase();
    if ((lower === "between" || lower === "from") && consumed.has(index + 1)) consumed.add(index);
  });

  const remaining = tokens
    .filter((_token, index) => !consumed.has(index))
    .join(" ")
    .trim();

  return {
    constraint: {
      minPaise,
      maxPaise,
      source: tokens
        .filter((_token, index) => consumed.has(index))
        .join(" ")
        .trim() || sourceParts.join(" "),
    },
    remaining,
  };
}

/**
 * Indices of the two amounts in a range expression.
 *
 * Recognises "between A and B", "from A to B", and "A to B" / "A - B". Returning
 * indices rather than values keeps the caller's existing bookkeeping (which
 * tracks which tokens were consumed) intact.
 */
function findRangeIndices(tokens: readonly string[]): Set<number> {
  const isAmount = (token: string | undefined) =>
    token !== undefined && /^\d[\d,.]*(?:k|l|lakh|cr|crore)?$/i.test(token);

  const CONNECTIVES = new Set(["to", "-", "–", "and", "&"]);

  for (let index = 0; index < tokens.length - 2; index += 1) {
    const lead = tokens[index]!.toLowerCase();
    const startsRange = lead === "between" || lead === "from";
    const firstIndex = startsRange ? index + 1 : index;
    const first = tokens[firstIndex];
    if (!isAmount(first)) continue;

    // Scan forward past the connective(s) for the second amount.
    let cursor = firstIndex + 1;
    let connectives = 0;
    while (cursor < tokens.length && CONNECTIVES.has(tokens[cursor]!.toLowerCase())) {
      connectives += 1;
      cursor += 1;
    }
    // "between A and B" needs the "and"; a bare "A B" is not a range.
    if (connectives === 0) continue;
    const second = tokens[cursor];
    if (!isAmount(second)) continue;

    return new Set([firstIndex, cursor]);
  }

  return new Set();
}

function hasAdjacentComparator(tokens: string[], index: number): boolean {
  const before = tokens[index - 1]?.toLowerCase() ?? "";
  const twoBefore = tokens[index - 2]?.toLowerCase() ?? "";
  if (MAX_PRICE_WORDS.has(before) || MIN_PRICE_WORDS.has(before)) return true;
  return COMPARATOR_TAILS.has(before) && (MAX_PRICE_WORDS.has(twoBefore) || MIN_PRICE_WORDS.has(twoBefore));
}

/**
 * True when the query is a bare identifier rather than a description.
 *
 * The shape that matters: contains a digit, contains a hyphen or is a single
 * long alphanumeric run, and has no spaces. "a17-256gb" and "8901234567890"
 * qualify; "iphone 17" does not, because a shopper typing that wants the phone,
 * not an exact SKU row.
 */
export function looksLikeIdentifier(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (!/\d/.test(trimmed)) return false;
  // A barcode is 8–14 digits; an SKU usually mixes letters, digits and a hyphen.
  if (/^\d{8,14}$/.test(trimmed)) return true;
  return /^[A-Za-z0-9][A-Za-z0-9_-]{4,63}$/.test(trimmed);
}

/**
 * Normalize a raw query into the forms the rest of the pipeline needs.
 *
 * `keepStopWords` exists because ranking wants the stop words gone but the
 * "did you mean" display and the history list want the query the shopper
 * recognises.
 */
export function normalizeQuery(raw: string, options: { keepStopWords?: boolean } = {}): NormalizedQuery {
  const bounded = sanitizeQuery(raw).slice(0, MAX_QUERY_LENGTH);
  const folded = bounded
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  const rawTokens = tokenize(folded);
  const terms = rawTokens
    .map((token) => collapseRepeats(token))
    .filter((token) => token.length > 0)
    .filter((token) => options.keepStopWords || !STOP_WORDS.has(token));

  const isExactIdentifier = looksLikeIdentifier(bounded);

  return {
    raw: bounded,
    normalized: folded,
    canonical: canonicalize(folded),
    terms,
    rawTokens,
    isExactIdentifier,
  };
}

/** Apply the abbreviation table to a token. Unknown tokens pass through. */
export function expandAbbreviation(token: string): string {
  return ABBREVIATIONS[token] ?? token;
}

/**
 * Tokens with abbreviations expanded, de-duplicated.
 *
 * Both the original and the expansion are returned when they differ, because a
 * catalog may use either spelling and dropping one would lose matches.
 */
export function expandAbbreviations(terms: readonly string[]): string[] {
  const out = new Set<string>();
  for (const term of terms) {
    out.add(term);
    const expanded = expandAbbreviation(term);
    if (expanded !== term) out.add(expanded);
  }
  return [...out];
}

/** Is this token one the engine should not try to spell-correct? */
export function isProtectedToken(token: string): boolean {
  // Model numbers and SKUs are where fuzzy matching does the most damage:
  // "17" corrected to "7" is not a typo recovery, it is a wrong answer.
  if (/^\d+$/.test(token)) return true;
  if (/\d/.test(token) && /[a-z]/.test(token) && /\d/.test(token.slice(-1))) return true;
  return token.length <= 2;
}

export const NORMALIZATION_INTERNALS = {
  ABBREVIATIONS,
  STOP_WORDS,
  MAX_PRICE_WORDS,
  MIN_PRICE_WORDS,
  AMOUNT_SUFFIXES,
} as const;
