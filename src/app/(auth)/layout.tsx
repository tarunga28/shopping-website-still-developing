import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AuthShell } from "@/components/layouts/auth-shell";
import { buildMetadata } from "@/lib/seo";

export const metadata: Metadata = buildMetadata({
  title: "Your account",
  noIndex: true,
});

export default function AuthLayout({ children }: { children: ReactNode }) {
  return <AuthShell>{children}</AuthShell>;
}
