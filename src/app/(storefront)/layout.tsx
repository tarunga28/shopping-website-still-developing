import type { ReactNode } from "react";
import { AnnouncementBar } from "@/components/layout/announcement-bar";
import { SiteFooter } from "@/components/layout/site-footer";
import { SiteHeader } from "@/components/layout/site-header";
import { storefrontContent } from "@/content/storefront";
import { errorContext, logger } from "@/lib/logger";
import { filterScheduled } from "@/lib/schedule";
import { getOptionalUser } from "@/server/auth/session";
import { loadHeaderCatalog } from "@/services/storefront.service";

export const dynamic = "force-dynamic";

/**
 * Storefront chrome. Session and catalogue lookups are isolated so a
 * database miss does not take down every public page.
 */
export default async function StorefrontLayout({ children }: { children: ReactNode }) {
  const [user, catalog] = await Promise.all([
    getOptionalUser().catch((error: unknown) => {
      logger.error("Storefront session lookup failed", errorContext(error));
      return null;
    }),
    loadHeaderCatalog(),
  ]);

  const sessionHint = user
    ? { name: user.name, role: user.role as string, verified: Boolean(user.emailVerifiedAt) }
    : null;
  const announcements = storefrontContent.announcement.enabled
    ? filterScheduled(storefrontContent.announcement.messages)
    : [];

  return (
    <>
      <AnnouncementBar enabled={announcements.length > 0} messages={announcements} />
      <SiteHeader
        user={sessionHint}
        collections={catalog.collections}
        cartCount={null}
      />
      <main id="main-content" className="flex-1">
        {children}
      </main>
      <SiteFooter categories={catalog.categories.map((category) => ({ slug: category.slug, name: category.name }))} />
    </>
  );
}
