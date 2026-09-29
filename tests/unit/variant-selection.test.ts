import { describe, expect, it } from "vitest";
import { galleryImagesFor } from "@/lib/catalog/gallery";
import { MAX_QUANTITY, clampQuantity, quantitySchema } from "@/lib/catalog/quantity";
import {
  colorOptionState,
  defaultSelection,
  findVariant,
  optionKey,
  selectColor,
  selectSize,
  selectionFromParams,
  selectionToQuery,
  sizeOptionState,
  type SelectableVariant,
} from "@/lib/catalog/variant-selection";

const v = (id: string, color: string | null, size: string | null, state: SelectableVariant["state"] = "AVAILABLE"): SelectableVariant => ({
  id,
  color,
  size,
  state,
});

// Black: S M L (L out of stock).  Ecru: M only.  Red: S (out of stock).  No black/XL, no ecru/S.
const variants = [
  v("bs", "Black", "S"),
  v("bm", "Black", "M"),
  v("bl", "Black", "L", "OUT_OF_STOCK"),
  v("em", "Ecru", "M"),
  v("rs", "Red", "S", "OUT_OF_STOCK"),
];

describe("variant selection", () => {
  it("normalises option keys", () => {
    expect(optionKey("  Black ")).toBe("black");
    expect(optionKey("")).toBeNull();
    expect(optionKey(null)).toBeNull();
  });

  it("defaults to the first orderable variant, not an out-of-stock one", () => {
    expect(defaultSelection([v("x", "Red", "S", "OUT_OF_STOCK"), v("y", "Black", "M")])).toEqual({ color: "black", size: "m" });
    expect(defaultSelection([])).toEqual({ color: null, size: null });
    expect(defaultSelection([v("x", "Red", "S", "OUT_OF_STOCK")])).toEqual({ color: "red", size: "s" });
  });

  it("finds only combinations that really exist (never assumes a full grid)", () => {
    expect(findVariant(variants, { color: "black", size: "s" })?.id).toBe("bs");
    expect(findVariant(variants, { color: "ecru", size: "s" })).toBeNull();
    expect(findVariant(variants, { color: "black", size: "xl" })).toBeNull();
  });

  it("uses valid URL params", () => {
    expect(selectionFromParams(variants, { color: "Ecru", size: "M" })).toEqual({ color: "ecru", size: "m" });
    expect(selectionFromParams(variants, { color: "black", size: "s" })).toEqual({ color: "black", size: "s" });
  });

  it("ignores invalid URL params gracefully (?size=XXXXL&color=purple)", () => {
    expect(selectionFromParams(variants, { color: "purple", size: "XXXXL" })).toEqual(defaultSelection(variants));
    expect(selectionFromParams(variants, {})).toEqual(defaultSelection(variants));
    expect(selectionFromParams(variants, { color: "<script>", size: "' OR 1=1" })).toEqual(defaultSelection(variants));
  });

  it("keeps the valid half of a partly valid URL", () => {
    expect(selectionFromParams(variants, { color: "ecru", size: "XXXXL" })).toEqual({ color: "ecru", size: "m" });
    expect(selectionFromParams(variants, { color: "purple", size: "m" })).toEqual({ color: "black", size: "m" });
  });

  it("does not select an out-of-stock combination from the URL", () => {
    expect(selectionFromParams(variants, { color: "black", size: "l" })).toEqual({ color: "black", size: "s" });
    expect(selectionFromParams(variants, { color: "red", size: "s" })).toEqual(defaultSelection(variants));
  });

  it("changing colour keeps the size when that combination exists", () => {
    expect(selectColor(variants, { color: "black", size: "m" }, "Ecru")).toEqual({ color: "ecru", size: "m" });
  });

  it("changing colour moves to a real size when the current one does not exist", () => {
    expect(selectColor(variants, { color: "black", size: "s" }, "ecru")).toEqual({ color: "ecru", size: "m" });
  });

  it("changing size keeps the colour when possible and otherwise moves to one that has it", () => {
    expect(selectSize(variants, { color: "black", size: "s" }, "m")).toEqual({ color: "black", size: "m" });
    expect(selectSize(variants, { color: "ecru", size: "m" }, "s")).toEqual({ color: "black", size: "s" });
  });

  it("reports option states for disabling controls", () => {
    expect(colorOptionState(variants, "black")).toBe("AVAILABLE");
    expect(colorOptionState(variants, "red")).toBe("OUT_OF_STOCK");
    expect(colorOptionState(variants, "purple")).toBe("MISSING");
    const black = { color: "black", size: "m" };
    expect(sizeOptionState(variants, black, "S")).toBe("AVAILABLE");
    expect(sizeOptionState(variants, black, "L")).toBe("OUT_OF_STOCK");
    expect(sizeOptionState(variants, black, "XL")).toBe("MISSING");
    expect(sizeOptionState(variants, { color: "ecru", size: "m" }, "S")).toBe("MISSING");
  });

  it("handles products with only one option dimension or none", () => {
    const mug = [v("m1", null, null)];
    expect(defaultSelection(mug)).toEqual({ color: null, size: null });
    expect(findVariant(mug, { color: null, size: null })?.id).toBe("m1");
    const poster = [v("p1", null, "A3"), v("p2", null, "A2")];
    expect(selectSize(poster, { color: null, size: "a3" }, "A2")).toEqual({ color: null, size: "a2" });
  });

  it("serialises a clean query", () => {
    expect(selectionToQuery({ color: "black", size: "m" })).toBe("color=black&size=m");
    expect(selectionToQuery({ color: null, size: null })).toBe("");
  });
});

describe("quantity", () => {
  it("accepts 1..MAX integers only", () => {
    expect(quantitySchema.safeParse(1).success).toBe(true);
    expect(quantitySchema.safeParse(MAX_QUANTITY).success).toBe(true);
    for (const bad of [0, -1, 1.5, MAX_QUANTITY + 1, 999_999_999, Number.NaN, Infinity, "3", null]) {
      expect(quantitySchema.safeParse(bad).success).toBe(false);
    }
  });

  it("clamps UI input", () => {
    expect(clampQuantity(999_999_999)).toBe(MAX_QUANTITY);
    expect(clampQuantity(-5)).toBe(1);
    expect(clampQuantity(2.9)).toBe(2);
    expect(clampQuantity("abc")).toBe(1);
    expect(clampQuantity(Number.NaN)).toBe(1);
  });
});

describe("gallery images per colour", () => {
  const shared = { url: "/s.jpg", alt: "s", width: null, height: null, colorKey: null };
  const black = { url: "/b.jpg", alt: "b", width: null, height: null, colorKey: "black" };
  const ecru = { url: "/e.jpg", alt: "e", width: null, height: null, colorKey: "ecru" };

  it("shows a colour's own photos first, then the shared ones", () => {
    expect(galleryImagesFor([shared, black, ecru], "black").map((i) => i.url)).toEqual(["/b.jpg", "/s.jpg"]);
  });
  it("keeps the shared gallery when the colour has no photo of its own", () => {
    expect(galleryImagesFor([shared, black], "ecru").map((i) => i.url)).toEqual(["/s.jpg"]);
    expect(galleryImagesFor([shared], null).map((i) => i.url)).toEqual(["/s.jpg"]);
  });
  it("never renders an empty gallery when every photo is colour-specific", () => {
    expect(galleryImagesFor([black], "ecru")).toHaveLength(1);
    expect(galleryImagesFor([], "black")).toEqual([]);
  });
});
