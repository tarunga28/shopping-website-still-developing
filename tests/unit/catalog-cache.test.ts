import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidateTag = vi.fn();
const revalidatePath = vi.fn();

vi.mock("next/cache", () => ({ revalidateTag, revalidatePath, unstable_cache: (fn: unknown) => fn }));

describe("catalog cache invalidation", () => {
  beforeEach(() => {
    revalidateTag.mockReset();
    revalidatePath.mockReset();
  });

  it("expires the catalog tag immediately and revalidates every listing path", async () => {
    const { invalidateCatalogCache } = await import("@/lib/catalog/cache");
    invalidateCatalogCache();
    expect(revalidateTag).toHaveBeenCalledWith("catalog", { expire: 0 });
    const paths = revalidatePath.mock.calls.map((call) => call[0]);
    expect(paths).toEqual(expect.arrayContaining(["/shop", "/collections", "/categories", "/category/[slug]", "/collection/[slug]", "/product/[slug]"]));
  });

  it("never throws, so a save cannot fail because of invalidation", async () => {
    revalidateTag.mockImplementation(() => {
      throw new Error("Invariant: static generation store missing");
    });
    const { invalidateCatalogCache } = await import("@/lib/catalog/cache");
    expect(() => invalidateCatalogCache()).not.toThrow();
  });
});
