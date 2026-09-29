import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import { Providers } from "@/components/providers";
import { ThemeProvider, THEME_SCRIPT } from "@/components/theme/theme-provider";
import { siteConfig } from "@/config/site";
import { absoluteUrl } from "@/lib/seo";
import "./globals.css";

/* Brand type, vendored so production builds do not call Google Fonts. */
const syne = localFont({
  src: [
    { path: "../fonts/syne-latin-700-normal.woff2", weight: "700", style: "normal" },
    { path: "../fonts/syne-latin-800-normal.woff2", weight: "800", style: "normal" },
  ],
  variable: "--font-syne",
  display: "swap",
});
const grotesk = localFont({
  src: [
    { path: "../fonts/space-grotesk-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../fonts/space-grotesk-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "../fonts/space-grotesk-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-grotesk",
  display: "swap",
});
const plex = localFont({
  src: [
    { path: "../fonts/ibm-plex-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../fonts/ibm-plex-mono-latin-500-normal.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-plex",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(absoluteUrl("/")),
  title: {
    default: `${siteConfig.name} — ${siteConfig.tagline}`,
    template: `%s · ${siteConfig.name}`,
  },
  description: siteConfig.description,
  keywords: [...siteConfig.keywords],
  applicationName: siteConfig.name,
  authors: [{ name: siteConfig.legalName, url: siteConfig.url }],
  creator: siteConfig.legalName,
  publisher: siteConfig.legalName,
  formatDetection: { telephone: false },
  openGraph: {
    type: "website",
    siteName: siteConfig.name,
    title: `${siteConfig.name} — ${siteConfig.tagline}`,
    description: siteConfig.description,
    url: absoluteUrl("/"),
    locale: "en_IN",
    images: [
      {
        url: "/images/og.jpg",
        width: 1200,
        height: 630,
        alt: `${siteConfig.name} — original art printed on demand`,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: `${siteConfig.name} — ${siteConfig.tagline}`,
    description: siteConfig.description,
    images: ["/images/og.jpg"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large" },
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f2e9" },
    { media: "(prefers-color-scheme: dark)", color: "#14110c" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${syne.variable} ${grotesk.variable} ${plex.variable}`} suppressHydrationWarning>
      <head>
        {/* Anti-FOUC: applies the stored/system theme before first paint */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="flex min-h-svh flex-col bg-paper font-sans text-ink">
        <ThemeProvider>
          <Providers>
            <a
              href="#main-content"
              className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[120] focus:rounded-pill focus:bg-ink focus:px-5 focus:py-2.5 focus:text-xs focus:font-semibold focus:uppercase focus:tracking-widest focus:text-paper"
            >
              Skip to content
            </a>
            {children}
          </Providers>
        </ThemeProvider>
      </body>
    </html>
  );
}
