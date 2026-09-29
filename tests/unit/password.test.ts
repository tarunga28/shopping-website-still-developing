import { describe, expect, it } from "vitest";
import { assessPassword, hashPassword, verifyPassword } from "@/server/auth/password";

/**
 * Note: these run under node (node:crypto available); jsdom delegates to
 * the same process for node built-ins.
 */
describe("password hashing (scrypt)", () => {
  it("hashes with unique salts (same input → different hashes)", () => {
    const a = hashPassword("SecretPassphrase!42");
    const b = hashPassword("SecretPassphrase!42");
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt:")).toBe(true);
    expect(b.startsWith("scrypt:")).toBe(true);
  });

  it("verifies the correct password", () => {
    const stored = hashPassword("Correct Horse 99!");
    expect(verifyPassword(stored, "Correct Horse 99!")).toBe(true);
  });

  it("rejects a wrong password", () => {
    const stored = hashPassword("Correct Horse 99!");
    expect(verifyPassword(stored, "Wrong Horse 99!")).toBe(false);
  });

  it("is case-sensitive", () => {
    const stored = hashPassword("CaseSensitive1!");
    expect(verifyPassword(stored, "casesensitive1!")).toBe(false);
  });

  it("rejects malformed hashes without throwing a false positive", () => {
    expect(() => verifyPassword("not-a-hash", "x")).toThrow();
  });

  it("never embeds the plaintext in the stored hash", () => {
    const stored = hashPassword("PlainTextSecret123");
    expect(stored).not.toContain("PlainTextSecret123");
  });
});

describe("password strength policy", () => {
  it("accepts strong mixed passwords", () => {
    expect(assessPassword("Tr0ub4dour&9x").valid).toBe(true);
  });

  it("accepts long passphrases without symbol requirements", () => {
    expect(assessPassword("river stone quiet morning").valid).toBe(true);
  });

  it("rejects short passwords", () => {
    expect(assessPassword("Ab1!xyz").valid).toBe(false);
  });

  it("rejects weak class-poor passwords under 14 chars", () => {
    expect(assessPassword("aaaaaaaaaaaa").valid).toBe(false);
  });

  it("rejects common passwords", () => {
    expect(assessPassword("password1234").valid).toBe(false);
  });
});
