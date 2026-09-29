import { describe, expect, it } from "vitest";
import { formatFromPrice, formatPrice } from "@/lib/format";

describe("formatPrice (INR, paise → rupees)", () => {
  it("formats whole rupees without decimals by default", () => {
    expect(formatPrice(89900)).toContain("₹");
    expect(formatPrice(89900)).toContain("899");
    expect(formatPrice(89900)).not.toContain(".00");
  });

  it("formats lakhs with Indian digit grouping", () => {
    expect(formatPrice(149900)).toContain("1,499");
    expect(formatPrice(10000000)).toContain("1,00,000");
  });

  it("optionally keeps decimals", () => {
    expect(formatPrice(89950, { withDecimals: true })).toContain("899.5");
  });

  it("rounds zero correctly", () => {
    expect(formatPrice(0)).toContain("0");
  });
});

describe("formatFromPrice", () => {
  it('prefixes the amount with "from"', () => {
    expect(formatFromPrice(49900).toLowerCase()).toContain("from");
    expect(formatFromPrice(49900)).toContain("499");
  });
});
