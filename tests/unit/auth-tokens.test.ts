import { describe, expect, it } from "vitest";
import { generateRawToken, hashToken, isTokenUsable, TOKEN_TTL_MINUTES } from "@/server/auth/tokens";

describe("auth tokens", () => {
  it("generates URL-safe random tokens, unique per call", () => {
    const a = generateRawToken();
    const b = generateRawToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(/^[A-Za-z0-9_-]+$/.test(a)).toBe(true); // base64url — no / + = chars
  });

  it("hashes deterministically (sha256 hex)", () => {
    const raw = "sample-raw-token";
    expect(hashToken(raw)).toBe(hashToken(raw));
    expect(hashToken(raw)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never exposes the raw token through the hash trivially", () => {
    expect(hashToken(generateRawToken())).not.toContain("scrypt");
  });

  it("isTokenUsable rejects consumed and expired tokens", () => {
    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60_000);
    expect(isTokenUsable({ expiresAt: future, consumedAt: null })).toBe(true);
    expect(isTokenUsable({ expiresAt: future, consumedAt: new Date() })).toBe(false);
    expect(isTokenUsable({ expiresAt: past, consumedAt: null })).toBe(false);
  });

  it("reset tokens are short-lived, verification tokens longer", () => {
    expect(TOKEN_TTL_MINUTES.PASSWORD_RESET).toBeLessThanOrEqual(60);
    expect(TOKEN_TTL_MINUTES.EMAIL_VERIFICATION).toBeGreaterThanOrEqual(60 * 12);
  });
});
