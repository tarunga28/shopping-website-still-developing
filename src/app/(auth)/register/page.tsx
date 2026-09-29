import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { RegisterForm } from "@/components/auth/register-form";
import { getOptionalUser } from "@/server/auth/session";
import { buildMetadata } from "@/lib/seo";

export const metadata: Metadata = buildMetadata({
  title: "Create your account",
  description: "Join Inkline — order original art printed on demand, track shipments and save your favorites.",
  path: "/register",
  noIndex: true,
});

export default async function RegisterPage() {
  const user = await getOptionalUser();
  if (user) redirect("/account");
  return <RegisterForm />;
}
