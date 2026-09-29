import type { Metadata } from "next";
import type { ReactNode } from "react";
import { requireAdminRole } from "@/server/auth/session";
import { buildMetadata } from "@/lib/seo";

export const metadata: Metadata = buildMetadata({
  title: "Admin",
  noIndex: true,
});

/**
 * Admin segment guard — DB-verified admin role required.
 * (Customers get a 404: the area is not advertised.)
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireAdminRole();
  return children;
}
