import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The candidate cache, tested against a *simulated* Next.js cache.
 *
 * The integration suite mocks `next/cache` to a pass-through, which means the
 * HIT/MISS accounting is never exercised there — every call computes, so every
 * status reads MISS and a bug in the accounting would be invisible. This store
 * memoizes like the real thing so a second call genuinely skips the generator.
 */
const store = new Map<string, unknown>();

vi.mock("next/cache", () => ({
  unstable_cache:
    <T,>(fn: () => Promise<T>, keyParts: string[]) =>
    async (): Promise<T> => {
      const key = keyParts.join("|");
      if (store.has(key)) return store.get(key) as T;
      const value = await fn();
      store.set(key, value);
      return value;
    },
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

const { cachedCandidates, candidateCacheKey, isCacheableType } = await import(
  "@/services/recommendations/cached.service"
);

beforeEach(() => {
  store.clear();
});

describe("candidate cache key", () => {
  it("separates two different seed products", () => {
    const a = candidateCacheKey("SIMILAR_PRODUCTS", { productId: "p1" });
    const b = candidateCacheKey("SIMILAR_PRODUCTS", { productId: "p2" });
    expect(a.join("|")).not.toBe(b.join("|"));
  });

  it("separates two recommendation types for the same seed", () => {
    // A similarity rail and a cross-sell rail for one product must not share an
    // entry — they propose opposite kinds of product.
    const similar = candidateCacheKey("SIMILAR_PRODUCTS", { productId: "p1" });
    const cross = candidateCacheKey("CROSS_SELL", { productId: "p1" });
    expect(similar.join("|")).not.toBe(cross.join("|"));
  });

  it("includes the candidate limit so a small pool is not served to a large request", () => {
    const small = candidateCacheKey("SIMILAR_PRODUCTS", { productId: "p1", candidateLimit: 6 });
    const large = candidateCacheKey("SIMILAR_PRODUCTS", { productId: "p1", candidateLimit: 40 });
    expect(small.join("|")).not.toBe(large.join("|"));
  });

  it("includes the category so category-scoped rails do not collide", () => {
    const a = candidateCacheKey("POPULAR_IN_CATEGORY", { categoryId: "c1" });
    const b = candidateCacheKey("POPULAR_IN_CATEGORY", { categoryId: "c2" });
    expect(a.join("|")).not.toBe(b.join("|"));
  });

  it("is stable for the same inputs", () => {
    const a = candidateCacheKey("TRENDING_PRODUCTS", { categoryId: "c1", candidateLimit: 12 });
    const b = candidateCacheKey("TRENDING_PRODUCTS", { categoryId: "c1", candidateLimit: 12 });
    expect(a).toEqual(b);
  });
});

describe("cacheable types", () => {
  it("caches types whose candidates depend only on the seed", () => {
    for (const type of [
      "SIMILAR_PRODUCTS",
      "RELATED_PRODUCTS",
      "FREQUENTLY_BOUGHT_TOGETHER",
      "CUSTOMER_ALSO_BOUGHT",
      "CUSTOMER_ALSO_VIEWED",
      "CROSS_SELL",
      "UPSELL",
      "TRENDING_PRODUCTS",
      "POPULAR_IN_CATEGORY",
    ] as const) {
      expect(isCacheableType(type), `${type} should be cacheable`).toBe(true);
    }
  });

  it("never caches subject-dependent types", () => {
    // Caching these by seed alone would serve one shopper's rail to another —
    // wrong in the dangerous direction, and silently so.
    for (const type of [
      "PERSONALIZED_FOR_YOU",
      "CONTINUE_SHOPPING",
      "RECENTLY_VIEWED",
      "CART_RECOMMENDATIONS",
      "CHECKOUT_RECOMMENDATIONS",
      "POST_PURCHASE_RECOMMENDATIONS",
      "NEW_USER_RECOMMENDATIONS",
      "ANONYMOUS_RECOMMENDATIONS",
    ] as const) {
      expect(isCacheableType(type), `${type} must not be cacheable`).toBe(false);
    }
  });
});

describe("hit and miss accounting", () => {
  it("reports MISS when the generator runs and HIT when it is skipped", async () => {
    let calls = 0;
    const generate = async () => {
      calls += 1;
      return { seeds: [{ productId: "p1", source: "SIMILARITY" as const, strength: 1 }] };
    };
    const key = candidateCacheKey("SIMILAR_PRODUCTS", { productId: "p1" });

    const first = await cachedCandidates(key, generate);
    expect(first.fromCache).toBe(false);
    expect(calls).toBe(1);

    const second = await cachedCandidates(key, generate);
    expect(second.fromCache).toBe(true);
    // The generator must not have run again — that is the whole point.
    expect(calls).toBe(1);
    expect(second.value).toEqual(first.value);
  });

  it("does not share an entry between different seeds", async () => {
    let calls = 0;
    const generate = async () => {
      calls += 1;
      return { n: calls };
    };
    await cachedCandidates(candidateCacheKey("SIMILAR_PRODUCTS", { productId: "p1" }), generate);
    await cachedCandidates(candidateCacheKey("SIMILAR_PROPERTIES" as never, { productId: "p2" }) as never, generate);
    expect(calls).toBe(2);
  });

  it("still generates when the cache layer is unavailable", async () => {
    /* Regression: `unstable_cache` throws "Invariant: incrementalCache missing"
     * outside a Next.js request — the offline job, a script, or a test that
     * does not mock next/cache. Propagating that made every cacheable rail
     * fall through to the popularity fallback, which returns plausible-looking
     * but WRONG results: the worst failure mode, because nothing looks broken
     * and only a content assertion notices. */
    const throwing = vi.fn(async () => {
      throw new Error("Invariant: incrementalCache missing in unstable_cache");
    });
    vi.doMock("next/cache", () => ({
      unstable_cache: throwing,
      revalidateTag: vi.fn(),
      revalidatePath: vi.fn(),
    }));
    vi.resetModules();
    const { cachedCandidates: uncached } = await import("@/services/recommendations/cached.service");

    let generated = 0;
    const result = await uncached(["rec:candidates", "unavailable"], async () => {
      generated += 1;
      return { seeds: ["real"] };
    });

    // The caller still gets real candidates, reported as a MISS.
    expect(throwing).toHaveBeenCalled();
    expect(generated).toBe(1);
    expect(result.value).toEqual({ seeds: ["real"] });
    expect(result.fromCache).toBe(false);

    vi.doUnmock("next/cache");
    vi.resetModules();
  });

  it("propagates a generator failure rather than caching it", async () => {
    const key = candidateCacheKey("SIMILAR_PRODUCTS", { productId: "boom" });
    await expect(
      cachedCandidates(key, async () => {
        throw new Error("generation failed");
      }),
    ).rejects.toThrow("generation failed");
    // Nothing cached, so a retry runs the generator again instead of replaying
    // a stored failure.
    expect(store.has(key.join("|"))).toBe(false);
  });
});
