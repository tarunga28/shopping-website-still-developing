import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "@/lib/rate-limit";

describe("createRateLimiter (fixed window)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("allows requests up to the limit, then blocks", () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, namespace: "test-a" });

    expect(limiter.check("client").success).toBe(true);
    expect(limiter.check("client").success).toBe(true);
    expect(limiter.check("client").success).toBe(true);

    const blocked = limiter.check("client");
    expect(blocked.success).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it("tracks keys independently", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, namespace: "test-b" });

    expect(limiter.check("alice").success).toBe(true);
    expect(limiter.check("bob").success).toBe(true);
    expect(limiter.check("alice").success).toBe(false);
  });

  it("resets after the window elapses", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 30_000, namespace: "test-c" });

    expect(limiter.check("client").success).toBe(true);
    expect(limiter.check("client").success).toBe(false);

    vi.advanceTimersByTime(31_000);
    expect(limiter.check("client").success).toBe(true);
  });
});
