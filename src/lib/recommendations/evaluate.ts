/**
 * Offline recommendation quality metrics.
 *
 * These exist so a ranking change can be judged before it ships. CTR tells you
 * what shoppers did; these tell you whether the list was any good, and the
 * difference matters — a rail can earn clicks by showing one obvious product
 * and nothing else.
 *
 * Two families:
 *
 *   Accuracy   precision@K, recall@K, MAP@K, NDCG@K — did we surface the items
 *              the shopper actually went on to engage with, and how high?
 *   Beyond-accuracy
 *              coverage, diversity, novelty — is the system showing the whole
 *              catalog, or the same slice of it to everyone?
 *
 * The second family is not optional garnish. A recommender can maximize
 * accuracy and still be a bad recommender, by converging on a handful of
 * popular items and starving every seller outside that set.
 */

/** Ground truth: the items a shopper actually engaged with. */
export interface EvaluationCase {
  /** Product ids in the order the system recommended them. */
  recommended: readonly string[];
  /** Product ids the shopper actually engaged with (clicked, bought). */
  relevant: readonly string[];
}

/**
 * Precision@K: of the first K recommendations, how many were relevant.
 *
 * Answers "was the rail mostly right?" — the metric a shopper feels, since
 * they only ever see the top of the list.
 */
export function precisionAtK(recommended: readonly string[], relevant: readonly string[], k: number): number {
  if (k <= 0 || recommended.length === 0) return 0;
  const top = recommended.slice(0, k);
  const relevantSet = new Set(relevant);
  const hits = top.filter((id) => relevantSet.has(id)).length;
  return hits / Math.min(k, top.length || 1);
}

/**
 * Recall@K: of everything relevant, how much did the first K surface.
 *
 * The counterpart to precision. A rail showing one perfect item has precision
 * 1.0 and recall near zero; only looking at both reveals which it is.
 */
export function recallAtK(recommended: readonly string[], relevant: readonly string[], k: number): number {
  if (relevant.length === 0) return 0;
  const top = recommended.slice(0, k);
  const relevantSet = new Set(relevant);
  const hits = top.filter((id) => relevantSet.has(id)).length;
  return hits / relevant.length;
}

/**
 * Mean Average Precision@K.
 *
 * Averages precision at each relevant position, so *where* a hit lands matters.
 * Two rails with identical precision@10 can differ sharply here: one put the
 * hits at positions 1–3, the other at 8–10.
 */
export function averagePrecisionAtK(
  recommended: readonly string[],
  relevant: readonly string[],
  k: number,
): number {
  if (relevant.length === 0 || k <= 0) return 0;
  const relevantSet = new Set(relevant);
  const top = recommended.slice(0, k);

  let hits = 0;
  let sumPrecision = 0;
  for (let i = 0; i < top.length; i += 1) {
    if (!relevantSet.has(top[i]!)) continue;
    hits += 1;
    sumPrecision += hits / (i + 1);
  }
  const denominator = Math.min(relevant.length, k);
  return denominator > 0 ? sumPrecision / denominator : 0;
}

export function mapAtK(cases: readonly EvaluationCase[], k: number): number {
  if (cases.length === 0) return 0;
  const total = cases.reduce(
    (sum, testCase) => sum + averagePrecisionAtK(testCase.recommended, testCase.relevant, k),
    0,
  );
  return total / cases.length;
}

/**
 * Normalized Discounted Cumulative Gain@K.
 *
 * Position-discounted relevance, normalized against the ideal ordering. Unlike
 * MAP it accepts graded relevance, so a purchase can count for more than a
 * click — which is the distinction that makes this the right metric for a rail
 * whose purpose is conversion rather than browsing.
 */
export function ndcgAtK(
  recommended: readonly string[],
  gradedRelevance: Readonly<Record<string, number>>,
  k: number,
): number {
  if (k <= 0) return 0;
  const gainOf = (id: string): number => gradedRelevance[id] ?? 0;

  let dcg = 0;
  const top = recommended.slice(0, k);
  for (let i = 0; i < top.length; i += 1) {
    // log2(i+2) because position 1 should divide by log2(2) = 1, i.e. no discount.
    dcg += gainOf(top[i]!) / Math.log2(i + 2);
  }

  const ideal = Object.values(gradedRelevance)
    .filter((value) => value > 0)
    .sort((a, b) => b - a)
    .slice(0, k);
  let idcg = 0;
  for (let i = 0; i < ideal.length; i += 1) {
    idcg += ideal[i]! / Math.log2(i + 2);
  }
  return idcg > 0 ? dcg / idcg : 0;
}

/* ── Beyond accuracy ──────────────────────────────────────────────────── */

/**
 * Catalog coverage: the fraction of products the system is willing to show.
 *
 * Low coverage means the recommender has quietly decided most of the catalog
 * does not exist. For a marketplace that is a fairness problem before it is a
 * relevance problem: sellers outside the popular set never get impressions, so
 * they never accumulate the signals that would get them shown.
 */
export function coverage(
  recommendedAcrossCases: Iterable<readonly string[]>,
  catalogSize: number,
): number {
  if (catalogSize <= 0) return 0;
  const seen = new Set<string>();
  for (const list of recommendedAcrossCases) {
    for (const id of list) seen.add(id);
  }
  return Math.min(1, seen.size / catalogSize);
}

/**
 * Intra-list diversity: mean pairwise dissimilarity within a single rail.
 *
 * Computed over category, because that is the axis on which a repetitive rail
 * is actually visible to a shopper. 1.0 means no two items share a category.
 */
export function intraListDiversity(categories: ReadonlyArray<string | null>): number {
  const present = categories.filter((value): value is string => Boolean(value));
  if (present.length < 2) return 1;

  let pairs = 0;
  let different = 0;
  for (let i = 0; i < present.length; i += 1) {
    for (let j = i + 1; j < present.length; j += 1) {
      pairs += 1;
      if (present[i] !== present[j]) different += 1;
    }
  }
  return pairs > 0 ? different / pairs : 1;
}

/**
 * Novelty: how much of the rail is *not* already popular.
 *
 * A rail made entirely of bestsellers has novelty near zero even when every
 * item is relevant. Measured against a popularity rank so the threshold is
 * relative to the catalog rather than an absolute sales figure.
 */
export function novelty(
  recommended: readonly string[],
  popularityRank: Readonly<Record<string, number>>,
  options: { popularThresholdPercentile?: number } = {},
): number {
  if (recommended.length === 0) return 0;
  const threshold = options.popularThresholdPercentile ?? 0.1;
  const nonPopular = recommended.filter((id) => {
    const percentile = popularityRank[id];
    // An unknown product is novel by definition — it has no popularity yet.
    return typeof percentile !== "number" || percentile > threshold;
  });
  return nonPopular.length / recommended.length;
}

/**
 * Aggregate a set of cases into the headline numbers.
 *
 * Reported together because any one of them can be gamed: precision can be
 * maximized by recommending nothing but safe items, coverage by recommending
 * at random. Reading them as a set is what makes a regression visible.
 */
export interface EvaluationReport {
  cases: number;
  precisionAtK: number;
  recallAtK: number;
  mapAtK: number;
  ndcgAtK: number;
  coverage: number;
  intraListDiversity: number;
  novelty: number;
  /** Share of cases where the rail returned nothing at all. */
  zeroResultRate: number;
}

export function evaluateRecommendations(
  input: {
    cases: readonly EvaluationCase[];
    /** Per-case recommended categories, aligned with `cases`. */
    categories?: ReadonlyArray<ReadonlyArray<string | null>>;
    catalogSize?: number;
    popularityRank?: Readonly<Record<string, number>>;
    k?: number;
    /** Optional graded relevance, for NDCG. Defaults to binary. */
    gradedRelevance?: Readonly<Record<string, Record<string, number>>>;
  },
): EvaluationReport {
  const k = input.k ?? 10;
  const cases = input.cases;
  if (cases.length === 0) {
    return {
      cases: 0,
      precisionAtK: 0,
      recallAtK: 0,
      mapAtK: 0,
      ndcgAtK: 0,
      coverage: 0,
      intraListDiversity: 0,
      novelty: 0,
      zeroResultRate: 0,
    };
  }

  let precisionSum = 0;
  let recallSum = 0;
  let ndcgSum = 0;
  let zeroResults = 0;

  for (let i = 0; i < cases.length; i += 1) {
    const testCase = cases[i]!;
    if (testCase.recommended.length === 0) zeroResults += 1;
    precisionSum += precisionAtK(testCase.recommended, testCase.relevant, k);
    recallSum += recallAtK(testCase.recommended, testCase.relevant, k);
    const graded = input.gradedRelevance?.[String(i)] ?? binaryGrades(testCase.relevant);
    ndcgSum += ndcgAtK(testCase.recommended, graded, k);
  }

  const categoryLists = input.categories ?? [];
  const diversityValues = categoryLists.map((list) => intraListDiversity(list));
  const meanDiversity =
    diversityValues.length > 0
      ? diversityValues.reduce((sum, value) => sum + value, 0) / diversityValues.length
      : 0;

  return {
    cases: cases.length,
    precisionAtK: round(precisionSum / cases.length),
    recallAtK: round(recallSum / cases.length),
    mapAtK: round(mapAtK(cases, k)),
    ndcgAtK: round(ndcgSum / cases.length),
    coverage: round(coverage(cases.map((testCase) => testCase.recommended), input.catalogSize ?? 0)),
    intraListDiversity: round(meanDiversity),
    novelty: round(
      novelty(
        cases.flatMap((testCase) => testCase.recommended),
        input.popularityRank ?? {},
      ),
    ),
    zeroResultRate: round(zeroResults / cases.length),
  };
}

function binaryGrades(relevant: readonly string[]): Record<string, number> {
  const grades: Record<string, number> = {};
  for (const id of relevant) grades[id] = 1;
  return grades;
}

function round(value: number, places = 4): number {
  if (!Number.isFinite(value)) return 0;
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
}

/* ── Business metrics (§39) ───────────────────────────────────────────── */

/**
 * CTR, add-to-cart rate, conversion rate and revenue per impression.
 *
 * All four are reported rather than just CTR, because a rail can have a
 * healthy CTR and convert nothing — which is a relevance problem, not a
 * checkout problem, and the two look identical if you only measure clicks.
 */
export function recommendationBusinessMetrics(counts: {
  impressions: number;
  clicks: number;
  addToCarts: number;
  purchases: number;
  revenuePaise: number;
}): {
  ctr: number;
  addToCartRate: number;
  conversionRate: number;
  revenuePerImpressionPaise: number;
} {
  const { impressions, clicks, addToCarts, purchases, revenuePaise } = counts;
  if (impressions <= 0) {
    return { ctr: 0, addToCartRate: 0, conversionRate: 0, revenuePerImpressionPaise: 0 };
  }
  return {
    ctr: round(clicks / impressions, 6),
    addToCartRate: round(addToCarts / impressions, 6),
    conversionRate: round(purchases / impressions, 6),
    revenuePerImpressionPaise: Math.round(revenuePaise / impressions),
  };
}
