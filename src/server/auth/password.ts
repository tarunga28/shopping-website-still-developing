import "server-only";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password security — scrypt (memory-hard KDF, node:crypto, no external
 * dependency risk). Format: `scrypt:N:salt:hash` so parameters are
 * self-describing and future migrations stay possible.
 *
 * Rules enforced everywhere:
 *  - never store plain text
 *  - per-password random salt
 *  - constant-time comparison (no timing oracle)
 *  - hashes never leave the server boundary
 */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

export class PasswordFormatError extends Error {}

export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(plain, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${salt}:${derived.toString("hex")}`;
}

/** Constant-time verification. Accepts the seeded `scrypt:salt:hash`
 *  legacy format (default parameters) as well. */
export function verifyPassword(stored: string, candidate: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 3 && parts.length !== 4) throw new PasswordFormatError("Unknown password hash format");

  const [scheme, ...rest] = parts;
  if (scheme !== "scrypt") throw new PasswordFormatError(`Unsupported scheme: ${scheme}`);

  const [nRaw, salt, expectedHex] = parts.length === 4 ? rest : ["16384", ...rest];
  const n = Number.parseInt(nRaw, 10);
  if (!Number.isFinite(n)) throw new PasswordFormatError("Invalid scrypt params");

  const candidateHash = scryptSync(candidate, salt, KEY_LEN, { N: n, r: SCRYPT_R, p: SCRYPT_P });
  const expected = Buffer.from(expectedHex, "hex");
  return expected.length === candidateHash.length && timingSafeEqual(expected, candidateHash);
}

export interface PasswordAssessment {
  valid: boolean;
  errors: string[];
}

/**
 * Strength policy — strong but not hostile:
 * ≥10 chars with three of four character classes, or ≥14 chars "phrase".
 */
export function assessPassword(plain: string): PasswordAssessment {
  const errors: string[] = [];
  const hasLower = /[a-z]/.test(plain);
  const hasUpper = /[A-Z]/.test(plain);
  const hasDigit = /\d/.test(plain);
  const hasSymbol = /[^A-Za-z0-9]/.test(plain);
  const classes = [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length;

  if (plain.length < 10) {
    errors.push("Use at least 10 characters.");
  } else if (plain.length < 14 && classes < 3) {
    errors.push("Mix at least three of: lowercase, uppercase, numbers, symbols — or use 14+ characters.");
  }
  if (/^(.)\1{5,}$/.test(plain)) errors.push("Avoid repeating a single character.");
  if (/^(password|qwerty|letmein|welcome)[$\d!@#]*$/i.test(plain)) errors.push("That password is too common.");

  return { valid: errors.length === 0, errors };
}
