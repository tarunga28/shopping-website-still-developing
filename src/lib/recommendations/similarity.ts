/**
 * Product similarity.
 *
 * Content-based: two products are similar when they share category, brand,
 * attributes, product type and price band. What they are *not* is
 * complementary — a phone case shares nothing with the phone except a
 * co-purchase history, and routing that through a similarity score is how a
 * "similar products" rail ends up full of socks.
 *
 * The weighting is category-specific because "what makes two things similar"
 * genuinely differs. Two laptops with the same CPU and RAM are near
 * substitutes; two t-shirts with the same colour are not. A single global
 * weight vector cannot express that, so each category can supply its own, and
 * a default profile covers the rest.
 */

/** A signal's weight within a category profile. Must sum to 1 to stay comparable. */
export interface SimilarityProfile {
  name: string;
  category: number;
  subcategory: number;
  brand: number;
  productType: number;
  attributes: number;
  price: number;
  text: number;
}

export const DEFAULT_SIMILARITY_PROFILE: SimilarityProfile = {
  name: "default",
  category: 0.3,
  subcategory: 0.12,
  brand: 0.18,
  productType: 0.1,
  attributes: 0.18,
  price: 0.07,
  text: 0.05,
};

/**
 * Electronics: specification-led. A different brand with the same chipset and
 * RAM is a closer substitute than the same brand at half the memory.
 */
export const ELECTRONICS_SIMILARITY_PROFILE: SimilarityProfile = {
  name: "electronics",
  category: 0.22,
  subcategory: 0.12,
  brand: 0.14,
  productType: 0.08,
  attributes: 0.32,
  price: 0.08,
  text: 0.04,
};

/**
 * Apparel: fit and look matter more than specifications, and colour carries
 * real weight because it is a primary purchase criterion.
 */
export const APPAREL_SIMILARITY_PROFILE: SimilarityProfile = {
  name: "apparel",
  category: 0.26,
  subcategory: 0.16,
  brand: 0.2,
  productType: 0.08,
  attributes: 0.2,
  price: 0.06,
  text: 0.04,
};

/** Attribute axes that decide similarity within a category family. */
export const CATEGORY_PROFILE_HINTS: Readonly<Record<string, readonly string[]>> = {
  electronics: ["ram", "storage", "cpu", "chipset", "display", "battery", "camera", "gpu"],
  apparel: ["gender", "size", "color", "material", "style", "fit"],
  laptops: ["cpu", "gpu", "ram", "storage", "display"],
  phones: ["chipset", "ram", "storage", "camera", "display", "battery"],
};

export function similarityProfileFor(
  hints: { categoryPath?: string | null; productType?: string | null; attributeAxes?: readonly string[] },
): SimilarityProfile {
  const haystack = [hints.categoryPath ?? "", hints.productType ?? "", ...(hints.attributeAxes ?? [])]
    .join(" ")
    .toLowerCase();
  const coreAxes = (hints.attributeAxes ?? []).map((axis) => axis.toLowerCase());
  const isElectronics =
    /laptop|phone|mobile|electronic|computer|tablet|camera|audio|headphone/.test(haystack) ||
    coreAxes.some((axis) => CATEGORY_PROFILE_HINTS.electronics!.includes(axis));
  if (isElectronics) return ELECTRONICS_SIMILARITY_PROFILE;

  const isApparel =
    /shirt|apparel|cloth|fashion|jean|dress|shoe|footwear|t-shirt|hoodie/.test(haystack) ||
    coreAxes.some((axis) => CATEGORY_PROFILE_HINTS.apparel!.includes(axis));
  if (isApparel) return APPAREL_SIMILARITY_PROFILE;

  return DEFAULT_SIMILARITY_PROFILE;
}

/* ── Individual signal scores ─────────────────────────────────────────── */

/** Exact category match, with a partial score for sharing a parent path. */
export function categorySimilarity(
  a: { categoryId?: string | null; categoryPath?: string | null },
  b: { categoryId?: string | null; categoryPath?: string | null },
): number {
  if (a.categoryId && b.categoryId && a.categoryId === b.categoryId) return 1;
  const pathA = (a.categoryPath ?? "").split("/").filter(Boolean);
  const pathB = (b.categoryPath ?? "").split("/").filter(Boolean);
  if (pathA.length === 0 || pathB.length === 0) return 0;
  let shared = 0;
  for (let i = 0; i < Math.min(pathA.length, pathB.length); i += 1) {
    if (pathA[i] === pathB[i]) shared += 1;
    else break;
  }
  if (shared === 0) return 0;
  // Siblings under a shared parent score high; a shared root only, low.
  return Math.min(0.85, shared / Math.max(pathA.length, pathB.length));
}

export function brandSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  return a === b ? 1 : 0;
}

export function productTypeSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  return a === b ? 1 : 0;
}

/**
 * Attribute overlap, as a Jaccard-style coefficient.
 *
 * Jaccard rather than raw intersection size because otherwise a product with
 * forty attributes would score higher against everything than a product with
 * three, purely for being more thoroughly specified.
 */
export function attributeSimilarity(
  a: readonly string[],
  b: readonly string[],
): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a.map((value) => value.toLowerCase()));
  const setB = new Set(b.map((value) => value.toLowerCase()));
  let intersection = 0;
  for (const value of setA) {
    if (setB.has(value)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Weighted attribute overlap that respects per-axis importance.
 *
 * Used when a category says "RAM matters, colour does not". Axes are compared
 * by name, and the result is the weight-normalized agreement across the axes
 * both products actually specify — an axis only one product has is skipped
 * rather than counted as a disagreement, so sparse data does not read as
 * dissimilarity.
 */
export function weightedAttributeSimilarity(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
  axisWeights: Readonly<Record<string, number>> = {},
): number {
  const axes = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (axes.size === 0) return 0;

  let weightedAgreement = 0;
  let weightedCompared = 0;
  for (const axis of axes) {
    const valueA = a[axis];
    const valueB = b[axis];
    // Only one product specifies this axis: no evidence either way.
    if (!valueA || !valueB) continue;
    const weight = axisWeights[axis] ?? 1;
    weightedCompared += weight;
    if (valueA.toLowerCase() === valueB.toLowerCase()) weightedAgreement += weight;
  }
  return weightedCompared > 0 ? weightedAgreement / weightedCompared : 0;
}

/**
 * Price proximity on a log scale.
 *
 * Logarithmic because price perception is relative: ₹1,000 vs ₹1,200 is a
 * meaningful difference, ₹90,000 vs ₹90,200 is not, and a linear ratio would
 * treat them as equally far apart in absolute terms while treating
 * ₹90,000 vs ₹180,000 as no worse than ₹1,000 vs ₹2,000.
 */
export function priceSimilarity(aPaise: number, bPaise: number): number {
  if (!Number.isFinite(aPaise) || !Number.isFinite(bPaise) || aPaise <= 0 || bPaise <= 0) return 0;
  const ratio = Math.log(Math.max(aPaise, bPaise) / Math.min(aPaise, bPaise));
  return Math.exp(-ratio);
}

/**
 * Token-overlap text similarity over name, tags and description.
 *
 * Deliberately the lowest-weighted signal. Text overlap is easy to game with
 * keyword stuffing and rewards verbose descriptions, so it acts as a tiebreaker
 * between otherwise-equivalent candidates rather than a primary driver.
 */
export function textSimilarity(aTokens: readonly string[], bTokens: readonly string[]): number {
  return attributeSimilarity(aTokens, bTokens);
}

/* ── Composite ────────────────────────────────────────────────────────── */

export interface SimilarityInput {
  categoryId?: string | null;
  subcategoryId?: string | null;
  categoryPath?: string | null;
  brandId?: string | null;
  productType?: string | null;
  attributes?: readonly string[];
  pricePaise?: number;
  textTokens?: readonly string[];
}

export interface SimilarityBreakdown {
  score: number;
  /** Per-signal contributions, weighted — this is what the debugger shows. */
  parts: Record<string, number>;
}

/**
 * Composite similarity in [0, 1].
 *
 * Returns both the score and its weighted parts, because "why are these
 * similar?" is the first question anyone asks when a recommendation looks
 * wrong, and an unexplained float cannot answer it.
 */
export function computeSimilarity(
  a: SimilarityInput,
  b: SimilarityInput,
  profile: SimilarityProfile = DEFAULT_SIMILARITY_PROFILE,
): SimilarityBreakdown {
  const raw: Record<string, number> = {
    category: categorySimilarity(
      { categoryId: a.categoryId, categoryPath: a.categoryPath },
      { categoryId: b.categoryId, categoryPath: b.categoryPath },
    ),
    subcategory:
      a.subcategoryId && b.subcategoryId && a.subcategoryId === b.subcategoryId ? 1 : 0,
    brand: brandSimilarity(a.brandId, b.brandId),
    productType: productTypeSimilarity(a.productType, b.productType),
    attributes: attributeSimilarity(a.attributes ?? [], b.attributes ?? []),
    price: priceSimilarity(a.pricePaise ?? 0, b.pricePaise ?? 0),
    text: textSimilarity(a.textTokens ?? [], b.textTokens ?? []),
  };

  const parts: Record<string, number> = {};
  let total = 0;
  let weightSum = 0;
  for (const [signal, value] of Object.entries(raw)) {
    const weight = profile[signal as keyof SimilarityProfile];
    if (typeof weight !== "number") continue;
    parts[signal] = Number((value * weight).toFixed(6));
    total += value * weight;
    weightSum += weight;
  }
  // Guard against a misconfigured profile: an unnormalized weight set would
  // otherwise produce scores above 1 and break the stored CHECK constraint.
  const score = weightSum > 0 ? total / weightSum : 0;
  return { score: Number(Math.min(1, Math.max(0, score)).toFixed(6)), parts };
}

/**
 * Rank the most similar products to a seed.
 *
 * Pure and synchronous so the offline job can be reasoned about in isolation
 * from the database that feeds it.
 */
export function rankSimilar<T extends SimilarityInput & { productId: string }>(
  seed: SimilarityInput,
  candidates: readonly T[],
  profile: SimilarityProfile = DEFAULT_SIMILARITY_PROFILE,
  options: { limit?: number; minScore?: number; exclude?: readonly string[] } = {},
): Array<{ item: T; score: number; parts: Record<string, number> }> {
  const limit = options.limit ?? 20;
  const minScore = options.minScore ?? 0.05;
  const excluded = new Set(options.exclude ?? []);

  return candidates
    .filter((candidate) => !excluded.has(candidate.productId))
    .map((candidate) => ({ item: candidate, ...computeSimilarity(seed, candidate, profile) }))
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
