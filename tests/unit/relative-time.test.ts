import { describe, expect, it } from "vitest";
import { relativeTime } from "@/lib/relative-time";

const NOW = new Date("2026-06-15T12:00:00Z");

describe("relativeTime", () => {
  it("covers the key buckets", () => {
    expect(relativeTime(new Date("2026-06-15T11:59:40Z"), NOW)).toBe("just now");
    expect(relativeTime(new Date("2026-06-15T11:30:00Z"), NOW)).toBe("30 minutes ago");
    expect(relativeTime(new Date("2026-06-15T09:00:00Z"), NOW)).toBe("3 hours ago");
    expect(relativeTime(new Date("2026-06-14T12:00:00Z"), NOW)).toBe("yesterday");
    expect(relativeTime(new Date("2026-06-12T12:00:00Z"), NOW)).toBe("3 days ago");
    expect(relativeTime(new Date("2026-06-01T12:00:00Z"), NOW)).toBe("2 weeks ago");
  });

  it("handles future dates gracefully", () => {
    expect(relativeTime(new Date("2026-06-15T13:00:00Z"), NOW)).toBe("just now");
  });
});
