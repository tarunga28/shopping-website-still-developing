import { describe, expect, it } from "vitest";
import { ADMIN_ROLES, isAdminRole } from "@/auth.config";
import { safeRedirect } from "@/app/(auth)/login/redirect";

describe("role predicates", () => {
  it("classifies admin roles", () => {
    expect(isAdminRole("ADMIN")).toBe(true);
    expect(isAdminRole("SUPER_ADMIN")).toBe(true);
    expect(isAdminRole("PRODUCT_MANAGER")).toBe(true);
    expect(isAdminRole("ORDER_MANAGER")).toBe(true);
    expect(isAdminRole("SUPPORT")).toBe(true);
  });

  it("rejects non-admin roles", () => {
    expect(isAdminRole("CUSTOMER")).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
    expect(isAdminRole("SUPER_ADMIN ")).toBe(false); // exact match required
  });

  it("admin roles list is not empty and contains no CUSTOMER", () => {
    expect(ADMIN_ROLES.length).toBeGreaterThan(0);
    expect(ADMIN_ROLES).not.toContain("CUSTOMER");
  });
});

describe("safeRedirect (open-redirect protection)", () => {
  it("allows internal absolute paths", () => {
    expect(safeRedirect("/account/orders")).toBe("/account/orders");
    expect(safeRedirect("/admin")).toBe("/admin");
  });

  it("falls back for external URLs", () => {
    expect(safeRedirect("https://evil.example.com")).toBe("/");
    expect(safeRedirect("http://phish.io/account")).toBe("/");
  });

  it("blocks protocol-relative and javascript URLs", () => {
    expect(safeRedirect("//evil.example.com")).toBe("/");
    expect(safeRedirect("javascript:alert(1)")).toBe("/");
  });

  it("handles missing input", () => {
    expect(safeRedirect(undefined)).toBe("/");
    expect(safeRedirect("", "/account")).toBe("/account");
  });
});
