import type { ReactNode } from "react";
import { AnnouncementBar } from "@/components/layout/announcement-bar";
import { SiteFooter } from "@/components/layout/site-footer";
import { SiteHeader } from "@/components/layout/site-header";
import { getOptionalUser } from "@/server/auth/session";
import { listActiveProductSummaries } from "@/services/catalog.service";

/**
 * Storefront layout — the public commerce chrome.
 * Server-resolved session hint + live catalog for header search.
 */
export default async function StorefrontLayout({ children }: { children: ReactNode }) {
  const [user, searchProducts] = await Promise.all([getOptionalUser(), listActiveProductSummaries()]);
  const sessionHint = user
    ? { name: user.name, role: user.role as string, verified: Boolean(user.emailVerifiedAt) }
    : null;

  return (
    <>
      <AnnouncementBar />
      <SiteHeader user={sessionHint} searchProducts={searchProducts} />
      <main id="main-content" className="flex-1">
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
