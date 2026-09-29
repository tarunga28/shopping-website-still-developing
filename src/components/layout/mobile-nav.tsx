"use client";

import Link from "next/link";
import { ArrowUpRight, Asterisk } from "lucide-react";
import type { ReactNode } from "react";
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import { InstagramIcon, XIcon, YouTubeIcon } from "@/components/ui/social-icons";
import { ComingSoonDialog } from "@/components/layout/coming-soon-dialog";
import { mainNav, siteConfig } from "@/config/site";

const socials = [
  { label: "Instagram", href: siteConfig.social.instagram, icon: InstagramIcon },
  { label: "X", href: siteConfig.social.x, icon: XIcon },
  { label: "YouTube", href: siteConfig.social.youtube, icon: YouTubeIcon },
];

/** Off-canvas navigation — first-class mobile UX with large touch targets. */
export function MobileNav({
  trigger,
  user,
}: {
  trigger: ReactNode;
  user: { name: string; role: string } | null;
}) {
  return (
    <Drawer>
      <DrawerTrigger asChild>{trigger}</DrawerTrigger>
      <DrawerContent side="left" className="flex flex-col p-6" aria-describedby={undefined}>
        <div className="flex items-center gap-2">
          <Asterisk className="size-6 text-flame" aria-hidden />
          <DrawerTitle>{siteConfig.name}</DrawerTitle>
        </div>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.22em] text-smoke">
          {siteConfig.tagline}
        </p>

        <nav aria-label="Mobile" className="mt-10 flex flex-col">
          {mainNav.map((item, index) => (
            <Link
              key={item.href + item.label}
              href={item.href}
              className="group flex items-baseline gap-3 border-b border-clay py-4 font-display text-3xl font-extrabold uppercase tracking-tight transition-colors hover:text-flame"
            >
              <span className="font-mono text-[10px] font-normal tracking-widest text-smoke">
                0{index + 1}
              </span>
              {item.label}
            </Link>
          ))}
          <ComingSoonDialog
            feature="Wishlists are coming"
            description="Save designs you love. Wishlists unlock with customer accounts in the next release."
            trigger={
              <button
                type="button"
                className="flex items-baseline gap-3 border-b border-clay py-4 text-left font-display text-3xl font-extrabold uppercase tracking-tight text-smoke/60 transition-colors hover:text-flame"
              >
                <span className="font-mono text-[10px] font-normal tracking-widest">0{mainNav.length + 1}</span>
                Wishlist
              </button>
            }
          />
        </nav>

        <div className="mt-auto space-y-6">
          {user ? (
            <Link
              href="/account"
              className="flex items-center justify-center gap-2 rounded-pill border-[1.5px] border-ink bg-ink px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-paper transition-colors hover:bg-flame hover:text-on-accent"
            >
              My account — {user.name.split(" ")[0]}
            </Link>
          ) : (
            <Link
              href="/login"
              className="flex items-center justify-center gap-2 rounded-pill border-[1.5px] border-ink bg-flame px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-on-accent transition-colors hover:bg-ink hover:text-paper"
            >
              Sign in / Create account
            </Link>
          )}
          <a
            href={`mailto:${siteConfig.contact.email}`}
            className="group inline-flex items-center gap-1.5 text-sm text-smoke transition-colors hover:text-ink"
          >
            {siteConfig.contact.email}
            <ArrowUpRight className="size-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
          </a>
          <div className="flex gap-3">
            {socials.map(({ label, href, icon: Icon }) => (
              <a
                key={label}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={label}
                className="flex size-10 items-center justify-center rounded-pill border-[1.5px] border-ink transition-colors hover:bg-ink hover:text-paper"
              >
                <Icon className="size-4" aria-hidden />
              </a>
            ))}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
