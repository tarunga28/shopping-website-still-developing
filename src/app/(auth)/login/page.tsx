import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/login-form";
import { safeRedirect } from "@/app/(auth)/login/redirect";
import { getOptionalUser } from "@/server/auth/session";
import { buildMetadata } from "@/lib/seo";

export const metadata: Metadata = buildMetadata({
  title: "Sign in",
  description: "Sign in to your Inkline account to track orders and save designs.",
  path: "/login",
  noIndex: true,
});

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string; registered?: string; verified?: string; reset?: string }>;
}) {
  const user = await getOptionalUser();
  const params = await searchParams;

  if (user) {
    redirect(safeRedirect(params.redirect, "/account"));
  }

  return <LoginForm redirectTo={safeRedirect(params.redirect)} flash={flashMessage(params)} />;
}

function flashMessage(params: { registered?: string; verified?: string; reset?: string }): string | undefined {
  if (params.registered === "1") return "Account created! Check your inbox for the verification link, then sign in.";
  if (params.verified === "1") return "Email verified — you can sign in now.";
  if (params.reset === "1") return "Password updated. Sign in with your new password.";
  return undefined;
}
