import { describe, expect, it } from "vitest";
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  normalizeEmail,
  registerSchema,
  resetPasswordSchema,
} from "@/validations/auth";

const validRegistration = {
  name: "Asha Kapoor",
  email: "asha@example.com",
  phone: "9876543210",
  password: "Tr0ub4dour&9x",
  confirmPassword: "Tr0ub4dour&9x",
  acceptTerms: true as const,
};

describe("registerSchema", () => {
  it("accepts a valid registration", () => {
    expect(registerSchema.safeParse(validRegistration).success).toBe(true);
  });

  it("rejects an invalid email", () => {
    expect(registerSchema.safeParse({ ...validRegistration, email: "not-an-email" }).success).toBe(false);
  });

  it("rejects weak passwords (min length)", () => {
    expect(registerSchema.safeParse({ ...validRegistration, password: "short1", confirmPassword: "short1" }).success).toBe(false);
  });

  it("rejects password mismatch", () => {
    const result = registerSchema.safeParse({ ...validRegistration, confirmPassword: "Different&9x" });
    expect(result.success).toBe(false);
  });

  it("rejects missing terms acceptance", () => {
    expect(registerSchema.safeParse({ ...validRegistration, acceptTerms: false }).success).toBe(false);
  });

  it("rejects invalid Indian phone numbers", () => {
    expect(registerSchema.safeParse({ ...validRegistration, phone: "12345" }).success).toBe(false);
  });

  it("allows empty phone", () => {
    expect(registerSchema.safeParse({ ...validRegistration, phone: "" }).success).toBe(true);
  });
});

describe("loginSchema", () => {
  it("requires email and password", () => {
    expect(loginSchema.safeParse({ email: "a@b.co", password: "x" }).success).toBe(true);
    expect(loginSchema.safeParse({ email: "", password: "" }).success).toBe(false);
  });
});

describe("forgotPasswordSchema", () => {
  it("requires a plausible email", () => {
    expect(forgotPasswordSchema.safeParse({ email: "a@b.co" }).success).toBe(true);
    expect(forgotPasswordSchema.safeParse({ email: "nope" }).success).toBe(false);
  });
});

describe("resetPasswordSchema", () => {
  it("requires a token + matching strong password", () => {
    expect(
      resetPasswordSchema.safeParse({
        token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        password: "Tr0ub4dour&9x",
        confirmPassword: "Tr0ub4dour&9x",
      }).success,
    ).toBe(true);
    expect(
      resetPasswordSchema.safeParse({ token: "short", password: "Tr0ub4dour&9x", confirmPassword: "Tr0ub4dour&9x" }).success,
    ).toBe(false);
  });
});

describe("changePasswordSchema", () => {
  it("rejects mismatched confirmation", () => {
    expect(
      changePasswordSchema.safeParse({ currentPassword: "x", password: "Tr0ub4dour&9x", confirmPassword: "nope" }).success,
    ).toBe(false);
  });
});

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Asha@Example.COM ")).toBe("asha@example.com");
  });
});
