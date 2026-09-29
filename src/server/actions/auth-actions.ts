"use server";

import { headers } from "next/headers";
import { z, type ZodType } from "zod";
import { signOut } from "@/auth";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  changePassword,
  registerUser,
  requestPasswordReset,
  resendVerificationEmail,
  resetPasswordWithToken,
  updateProfile,
  verifyEmailWithToken,
} from "@/services/auth.service";
import { writeAudit } from "@/services/audit.service";
import { getFreshUser } from "@/server/auth/session";
import {
  changePasswordSchema,
  forgotPasswordSchema,
  profileUpdateSchema,
  registerSchema,
  resetPasswordSchema,
  type RegisterInput,
} from "@/validations/auth";

/**
 * Server actions for auth flows. Every action:
 *  - re-validates input with zod (never trusts the client)
 *  - returns a uniform ActionResult (no thrown raw internals)
 *  - depends on the service layer for rate limits, audit and status rules
 */

export type FieldErrors = Record<string, string>;

export type ActionResult =
  | { ok: true; message?: string }
  | { ok: false; error: string; fieldErrors?: FieldErrors };

async function context() {
  const list = await headers();
  const forwarded = list.get("x-forwarded-for");
  return {
    ip: forwarded?.split(",")[0]?.trim() ?? list.get("x-real-ip") ?? undefined,
    userAgent: list.get("user-agent") ?? undefined,
  };
}

function zodFailure(error: z.ZodError): ActionResult {
  const flattened = z.flattenError(error);
  const fieldErrors: FieldErrors = {};
  for (const [field, messages] of Object.entries(flattened.fieldErrors)) {
    const first = Array.isArray(messages) ? messages[0] : undefined;
    if (first) fieldErrors[field] = first;
  }
  return {
    ok: false,
    error: flattened.formErrors[0] ?? Object.values(fieldErrors)[0] ?? "Please check the form.",
    fieldErrors,
  };
}

function serviceFailure(error: unknown): ActionResult {
  if (error instanceof AppError) return { ok: false, error: error.message };
  logger.error("Auth action failed", {
    error: error instanceof Error ? error.message : "unknown",
  });
  return { ok: false, error: "Something went wrong. Please try again." };
}

async function parseForm<S extends ZodType>(schema: S, formData: FormData): Promise<
  | { ok: true; data: z.infer<S> }
  | { ok: false; result: ActionResult }
> {
  const raw = Object.fromEntries(formData.entries());
  const parsed = schema.safeParse({
    ...raw,
    acceptTerms: raw.acceptTerms === "on" || raw.acceptTerms === "true" ? true : raw.acceptTerms,
  });
  if (!parsed.success) return { ok: false, result: zodFailure(parsed.error) };
  return { ok: true, data: parsed.data };
}

/* ── Registration ─────────────────────────────────────────────────────── */

export async function registerAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const parsed = await parseForm(registerSchema, formData);
  if (!parsed.ok) return parsed.result;

  try {
    await registerUser(parsed.data as RegisterInput, await context());
    return { ok: true, message: "Account created. We've emailed you a verification link." };
  } catch (error) {
    return serviceFailure(error);
  }
}

/* ── Password reset ───────────────────────────────────────────────────── */

export async function forgotPasswordAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const parsed = await parseForm(forgotPasswordSchema, formData);
  if (!parsed.ok) return parsed.result;

  try {
    await requestPasswordReset(parsed.data.email, await context());
  } catch (error) {
    return serviceFailure(error);
  }
  // Uniform success copy — never confirms whether the email exists.
  return { ok: true, message: "If that email is registered, a reset link is on its way." };
}

export async function resetPasswordAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const parsed = await parseForm(resetPasswordSchema, formData);
  if (!parsed.ok) return parsed.result;

  try {
    await resetPasswordWithToken(parsed.data.token, parsed.data.password, await context());
    return { ok: true, message: "Password updated. Sign in with your new password." };
  } catch (error) {
    return serviceFailure(error);
  }
}

/* ── Email verification ───────────────────────────────────────────────── */

export async function resendVerificationAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const parsed = await parseForm(forgotPasswordSchema, formData);
  if (!parsed.ok) return parsed.result;

  try {
    await resendVerificationEmail(parsed.data.email, await context());
  } catch (error) {
    return serviceFailure(error);
  }
  return { ok: true, message: "If that email is registered and unverified, a new link is on its way." };
}

/* ── Account: change password / update profile ────────────────────────── */

export async function changePasswordAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const user = await getFreshUser();
  if (!user) return { ok: false, error: "Your session expired. Please sign in again." };

  const parsed = await parseForm(changePasswordSchema, formData);
  if (!parsed.ok) return parsed.result;

  try {
    await changePassword(user.id, parsed.data.currentPassword, parsed.data.password, await context());
    return { ok: true, message: "Password changed. Other devices have been signed out." };
  } catch (error) {
    return serviceFailure(error);
  }
}

export async function updateProfileAction(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const user = await getFreshUser();
  if (!user) return { ok: false, error: "Your session expired. Please sign in again." };

  const parsed = await parseForm(profileUpdateSchema, formData);
  if (!parsed.ok) return parsed.result;

  try {
    await updateProfile(user.id, parsed.data, await context());
    return { ok: true, message: "Profile updated." };
  } catch (error) {
    return serviceFailure(error);
  }
}

/* ── Logout ───────────────────────────────────────────────────────────── */

export async function logoutAction(): Promise<void> {
  const user = await getFreshUser();
  if (user) {
    const ctx = await context();
    await writeAudit({
      action: "user.logout",
      entityType: "user",
      entityId: user.id,
      actorId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }
  await signOut({ redirectTo: "/" });
}

/* ── Verify-email token consumption (called from the page server-side) ── */

export async function consumeVerifyEmailToken(token: string): Promise<ActionResult> {
  try {
    await verifyEmailWithToken(token, await context());
    return { ok: true, message: "Email verified — you're all set!" };
  } catch (error) {
    return serviceFailure(error);
  }
}
