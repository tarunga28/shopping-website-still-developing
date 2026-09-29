import { describe, expect, it } from "vitest";
import { cn, stableFlip } from "@/lib/utils";

describe("cn (class merging)", () => {
  it("joins conditional classes", () => {
    expect(cn("a", false, "b", undefined)).toBe("a b");
  });

  it("resolves conflicting Tailwind utilities (last wins)", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("text-ink", "text-smoke")).toBe("text-smoke");
  });
});

describe("stableFlip", () => {
  it("is deterministic for the same seed", () => {
    expect(stableFlip("sample-01")).toBe(stableFlip("sample-01"));
    expect(stableFlip("order-99")).toBe(stableFlip("order-99"));
  });
});
