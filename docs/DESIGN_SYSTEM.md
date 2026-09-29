# Inkline Design System

One page of truth for anyone (human or AI) extending the interface.
If a value exists here, never introduce a one-off replacement.

## Tokens — where things live

| Concern      | Location                                             |
| ------------ | ---------------------------------------------------- |
| Color        | `src/app/globals.css` — `:root` + `[data-theme=dark]` raw vars, mapped to utilities in `@theme inline` |
| Typography   | Families in `@theme`; the approved scale as `@utility type-*` classes (same file) |
| Radius       | `@theme --radius-*` → `rounded-pill/card/image/modal/panel` |
| Shadows      | `@theme --shadow-*` → `shadow-hard-sm/hard/hard-lg/lift` |
| JS metadata  | `src/styles/tokens.ts` (breakpoints, motion, names) – styling itself stays in CSS |
| Brand strings| `src/config/site.ts` (name, tagline, nav, announcement bar, feature flags) |

### Color vocabulary (semantic)
`paper` background · `cream` surface · `sand` sunken · `clay` soft border ·
`ink` strong text/primary · `soot` body text · `smoke` muted text ·
`flame` brand accent (+`flame-deep`) · `success/warning/danger/info` states.

All of these are **theme-aware**: they are CSS variables that flip under
`[data-theme="dark"]`. Components must use these classes — never
`text-[#…]`, `bg-white`, or literal palette colors.

### Typography scale (use these utilities)
`type-display · type-h1 · type-h2 · type-h3 · type-h4 · type-body ·
type-small · type-label · type-caption`. Display font = Syne, body =
Space Grotesk, mono = IBM Plex Mono (self-hosted via `next/font` in the
root layout). No other families may be introduced.

### Theme architecture
- Preference stored in `localStorage("inkline-theme")`: `light | dark | system`.
- `THEME_SCRIPT` (inline in `<head>`) applies it before paint — no FOUC.
- `ThemeProvider` + `useTheme()` (client) manage state; `ThemeSwitcher`
  is the ready-made control (currently mounted in the footer).
- The storefront defaults to the brand (light) theme.

## Layout primitives
- `Container` (`narrow/default/wide`) — always wrap page content; never
  hand-roll `max-w` + `px` per page.
- `Section` + `SectionHeader` — homepage/editorial sections.
- Page shells: `AccountShell`, `AdminShell`, `AuthShell`,
  `CheckoutShell` in `src/components/layouts/`.
- Route groups: storefront chrome (announcement bar, header, footer)
  lives in `src/app/(storefront)/layout.tsx`; future surfaces
  (account/admin/auth/checkout) get their own groups.

## Component inventory (`src/components`)

| Area    | Files |
| ------- | ----- |
| Forms   | `ui/input, textarea, select, multi-select, checkbox, radio-group, switch, date-input, search-input, password-input, number-input, file-upload, field, label` |
| Actions | `ui/button` (primary/secondary/accent/outline/ghost/inverse/danger/success/link + icon, loading), `ui/confirm-dialog`, `ui/dropdown-menu`, `ui/tabs`, `ui/accordion`, `ui/pagination`, `ui/breadcrumbs` |
| Feedback| `ui/alert`, `lib/toast.ts` (notify.*), `ui/skeleton` (grid/form/table/stat presets), `ui/spinner`, `ui/empty-state` (+ presets), `ui/error-state` |
| Overlay | `ui/dialog`, `ui/drawer` (left/right/bottom), `layout/coming-soon-dialog`, `cards/quick-view-dialog` |
| Data    | `ui/badge` (+`StatusBadge`), `ui/price`, `ui/rating`, `ui/product-card`, `ui/product-image`, `ui/image-gallery`, `ui/quantity-selector`, `ui/card`, `cards/*` (category, review, design, order, customer, stat, analytics) |
| Brand   | `brand/logo`, `brand/payment-icons`, `brand/trust-badges`, `brand/newsletter-form`, `brand/cta-section`, `ui/social-icons` |
| Chrome  | `layout/site-header, site-footer, mobile-nav, announcement-bar, search-dialog, section` |
| Catalog | `catalog/product-listing, filter-drawer` |

## Adding a new component — the rules

1. Compose tokens only (`rounded-card`, `text-smoke`, `shadow-hard-sm`, …).
2. Interactive components >= WCAG AA: visible focus (`focus-visible:
   outline-flame`), keyboard operable, `aria-label` on icon-only
   controls, never color-only meaning.
3. Server component by default; add `"use client"` only when using
   state/effects/DOM events.
4. Variants via `cva`; class merging via `cn()` from `@/lib/utils`.
5. Respect `prefers-reduced-motion` (framer-motion is wrapped in
   `MotionConfig reducedMotion="user"`; CSS animation utilities get
   `motion-reduce:animate-none`).
6. Export from its own file; no barrel index files (keeps bundles lean).
7. Money is always integer paise → render via `Price`/`formatPrice`.

## Responsive breakpoints (Tailwind defaults + our rhythm)
`sm 640 · md 768 · lg 1024 · xl 1280 · 2xl 1536`; content caps at
`Container` 90rem. Design mobile-first, then enhance. Minimum touch
target 40px. Test at 320/375/390/430/768/1024/1280/1440/1920.

## Copy tone
Sentence case for UI copy, ALL CAPS for display/labels only, honest
placeholders (never fake functionality), INR `₹` formatting via helpers.
