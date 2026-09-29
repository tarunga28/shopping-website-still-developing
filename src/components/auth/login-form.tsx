"use client";

import Link from "next/link";
import { signIn } from "next-auth/react";
import { useState, type FormEvent } from "react";
import { AuthenticatorBanner } from "@/components/auth/auth-bits";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { loginSchema } from "@/validations/auth";

const errorCopy: Record<string, string> = {
  INVALID_CREDENTIALS: "Invalid email or password.",
  ACCOUNT_SUSPENDED: "This account is suspended. Please contact support@inkline.in.",
  ACCOUNT_DEACTIVATED: "This account was deactivated — contact support@inkline.in to reopen it.",
  SIGNIN_UNAVAILABLE: "Too many attempts, or the service hiccuped. Please retry in a few minutes.",
  CredentialsSignin: "Invalid email or password.",
};

/**
 * Email + password sign-in via Auth.js credentials provider.
 * Errors are mapped to safe copy; identity claims are never read client-side.
 */
export function LoginForm({ redirectTo, flash }: { redirectTo: string; flash?: string }) {
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});

    const form = new FormData(event.currentTarget);
    const values = { email: String(form.get("email") ?? ""), password: String(form.get("password") ?? "") };

    const parsed = loginSchema.safeParse(values);
    if (!parsed.success) {
      const flattened = parsed.error.flatten();
      setFieldErrors({
        email: flattened.fieldErrors.email?.[0],
        password: flattened.fieldErrors.password?.[0],
      });
      return;
    }

    setPending(true);
    try {
      const result = await signIn("credentials", {
        email: parsed.data.email,
        password: parsed.data.password,
        redirect: false,
      });

      if (result?.error) {
        const code = result.code ?? String(result.error);
        setError(errorCopy[code] ?? errorCopy.CredentialsSignin);
        setPending(false);
        return;
      }

      // Full navigation so the session cookie applies before SSR reads it.
      window.location.assign(redirectTo || "/account");
    } catch {
      setError("Network issue — please check your connection and retry.");
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-extrabold uppercase tracking-tight sm:text-4xl">
          Welcome
          <br />
          back<span className="text-flame">.</span>
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-smoke">
          Sign in to track orders, save addresses and keep your wishlist.
        </p>
      </div>

      {flash ? <Alert variant="success" title="All set">{flash}</Alert> : null}
      {error ? <Alert variant="error" title="Sign-in failed">{error}</Alert> : null}

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Email" required error={fieldErrors.email}>
          <Input
            type="email"
            name="email"
            autoComplete="email"
            placeholder="you@example.com"
            invalid={Boolean(fieldErrors.email)}
            disabled={pending}
          />
        </Field>
        <Field label="Password" required error={fieldErrors.password}>
          <PasswordInput
            name="password"
            autoComplete="current-password"
            placeholder="Your password"
            invalid={Boolean(fieldErrors.password)}
            disabled={pending}
          />
        </Field>

        <div className="flex justify-end">
          <Link
            href="/forgot-password"
            className="text-xs font-semibold text-smoke underline decoration-flame decoration-2 underline-offset-4 transition-colors hover:text-ink"
          >
            Forgot password?
          </Link>
        </div>

        <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>

      <p className="text-center text-sm text-smoke">
        New to Inkline?{" "}
        <Link href="/register" className="font-semibold text-ink underline decoration-flame decoration-2 underline-offset-4 hover:text-flame">
          Create your account
        </Link>
      </p>

      <AuthenticatorBanner />
    </div>
  );
}
