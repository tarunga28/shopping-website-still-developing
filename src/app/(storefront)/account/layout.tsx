import type { Metadata } from "next";
import type { ReactNode } from "react";
import { requireUser } from "@/server/auth/session";
import { buildMetadata } from "@/lib/seo";

export const metadata: Metadata = buildMetadata({
  title: "Your account",
  noIndex: true,
});

/**
 * Account segment guard — the edge proxy already bounced guests; this
 * rechecks with the database (status + security stamp) so suspended,
 * deactivated or rotated sessions stop here even with a live JWT.
 */
export default async function AccountLayout({ children }: { children: ReactNode }) {
  await requireUser();
  return children;
}
