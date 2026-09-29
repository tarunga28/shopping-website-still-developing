/**
 * JS-side token mirror — use when components need values programmatically
 * (charts, canvas, inline SVGs). Styling itself always uses the CSS custom
 * properties in `globals.css`, which this mirrors.
 *
 * THEME NOTE: light/dark values live only in CSS. This file exposes
 * theme-independent metadata (breakpoints, motion, radius names).
 */

export const breakpoints = {
  xs: 320,
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
  content: 1440, // max content width (90rem)
} as const;

export const motion = {
  fast: "150ms",
  base: "300ms",
  slow: "700ms",
  easeOut: "cubic-bezier(0.22, 1, 0.36, 1)",
} as const;

/** Semantic radius utility classes (see globals.css @theme). */
export const radii = {
  pill: "rounded-pill",
  card: "rounded-card",
  image: "rounded-image",
  modal: "rounded-modal",
  panel: "rounded-panel",
} as const;

/** Semantic shadow utility classes. */
export const shadows = {
  hardSm: "shadow-hard-sm",
  hard: "shadow-hard",
  hardLg: "shadow-hard-lg",
  lift: "shadow-lift",
} as const;

/** CSS variable accessors for rare imperative needs. */
export const cssVar = {
  surface: "var(--surface-base)",
  ink: "var(--text-strong)",
  accent: "var(--brand-accent)",
} as const;

export type ThemeName = "light" | "dark" | "system";
