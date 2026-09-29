import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { NewsletterForm } from "@/components/brand/newsletter-form";
import { PaymentIcons } from "@/components/brand/payment-icons";
import { CtaSection } from "@/components/brand/cta-section";
import { ComingSoonDialog } from "@/components/layout/coming-soon-dialog";
import { PrivacyChoices } from "@/components/privacy/privacy-choices";
import { ThemeSwitcher } from "@/components/theme/theme-switcher";
import { Container } from "@/components/ui/container";
import { InstagramIcon, PinterestIcon, XIcon, YouTubeIcon } from "@/components/ui/social-icons";
import { footerNav, siteConfig } from "@/config/site";
import { categoryPath } from "@/lib/storefront-paths";

const socials = [
  { label: "Instagram", href: siteConfig.social.instagram, icon: InstagramIcon },
  { label: "X (Twitter)", href: siteConfig.social.x, icon: XIcon },
  { label: "YouTube", href: siteConfig.social.youtube, icon: YouTubeIcon },
  { label: "Pinterest", href: siteConfig.social.pinterest, icon: PinterestIcon },
];

/** Footer link cell — external targets get proper attrs automatically. */
function FooterLink({ link }: { link: { label: string; href: string } }) {
  const external = link.href.startsWith("http");
  return (
    <li>
      <Link
        href={link.href}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        className="text-sm text-paper/75 transition-colors hover:text-flame"
      >
        {link.label}
      </Link>
    </li>
  );
}

export function SiteFooter({
  categories = [],
}: {
  categories?: { slug: string; name: string }[];
}) {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t-[1.5px] border-ink bg-ink text-paper">
      {/* Giant closing statement */}
      <div className="border-b border-paper/15">
        <CtaSection
          title={
            <>
              Wear your <span className="text-flame">creativity</span>
              <span aria-hidden>.</span>
            </>
          }
          action={{ href: "/#newsletter", label: "Join the list" }}
        />
      </div>

      {/* Newsletter + link columns */}
      <Container className="py-12">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12">
          <div className="space-y-5 lg:col-span-5">
            <h2 className="font-display text-xl font-extrabold uppercase tracking-tight">
              Notes when
              <br />
              there is news<span className="text-flame">.</span>
            </h2>
            <NewsletterForm source="footer" tone="ink" layout="stacked" className="max-w-sm" />
            <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-paper/40">
              Stored on the Inkline list · No third-party send claimed
            </p>
          </div>

          <div className="grid grid-cols-2 gap-8 sm:grid-cols-4 lg:col-span-7">
            <nav aria-label="Footer — Shop">
              <h3 className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-paper/50">Shop</h3>
              <ul className="mt-4 space-y-2.5">
                {footerNav.shop.map((link) => (
                  <FooterLink key={link.href + link.label} link={link} />
                ))}
                {categories.slice(0, 6).map((category) => (
                  <FooterLink key={category.slug} link={{ label: category.name, href: categoryPath(category.slug) }} />
                ))}
              </ul>
            </nav>
            <nav aria-label="Footer — Support">
              <h3 className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-paper/50">Support</h3>
              <ul className="mt-4 space-y-2.5">
                {footerNav.support.map((link) => (
                  <FooterLink key={link.href + link.label} link={link} />
                ))}
                <li>
                  <ComingSoonDialog
                    feature="Order tracking is coming"
                    description="Order tracking isn't available yet. It will show here when fulfillment is live. Nothing can be tracked today."
                    trigger={
                      <button
                        type="button"
                        className="text-sm text-paper/75 transition-colors hover:text-flame"
                      >
                        Track your order
                      </button>
                    }
                  />
                </li>
              </ul>
            </nav>
            <nav aria-label="Footer — Company">
              <h3 className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-paper/50">Company</h3>
              <ul className="mt-4 space-y-2.5">
                {footerNav.company.map((link) => (
                  <FooterLink key={link.href + link.label} link={link} />
                ))}
              </ul>
            </nav>
            <nav aria-label="Footer — Legal">
              <h3 className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-paper/50">Legal</h3>
              <ul className="mt-4 space-y-2.5">
                {footerNav.legal.map((link) => (
                  <FooterLink key={link.href + link.label} link={link} />
                ))}
              </ul>
            </nav>
          </div>
        </div>
      </Container>

      {/* Brand + socials */}
      <div className="border-t border-paper/15">
        <Container className="flex flex-col items-start justify-between gap-6 py-8 md:flex-row md:items-center">
          <div className="space-y-3">
            <Link href="/" aria-label={`${siteConfig.name} — home`} className="inline-flex w-fit">
              <Logo />
            </Link>
            <p className="max-w-sm text-sm leading-relaxed text-paper/60">
              Original artwork, printed after you order. Checkout and supplier fulfillment are not open yet.
            </p>
          </div>
          <div className="flex gap-2.5">
            {socials.map(({ label, href, icon: Icon }) => (
              <a
                key={label}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={label}
                className="flex size-9 items-center justify-center rounded-pill border border-paper/25 transition-all hover:border-flame hover:bg-flame hover:text-on-accent"
              >
                <Icon className="size-4" aria-hidden />
              </a>
            ))}
          </div>
        </Container>
      </div>

      {/* Bottom bar */}
      <div className="border-t border-paper/15">
        <Container className="flex flex-col gap-5 py-6 md:flex-row md:items-center md:justify-between">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper/50">
            © {year} {siteConfig.legalName} · v{siteConfig.version}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper/50">
              Payments at launch:
            </span>
            <PaymentIcons />
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <PrivacyChoices />
            <div className="flex items-center gap-3">
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper/50">Theme</span>
              <ThemeSwitcher />
            </div>
          </div>
        </Container>
      </div>
    </footer>
  );
}
