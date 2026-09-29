"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { ThemeName } from "@/styles/tokens";

/**
 * Theme architecture — light / dark / system.
 *
 * The public storefront ships in the brand theme (light) by default;
 * dark mode is fully wired at the token level and can be enabled from
 * any surface (account settings, admin, future theme toggle in footer)
 * via `useTheme().setTheme(...)`.
 */

const STORAGE_KEY = "inkline-theme";

type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  /** User preference ("system" follows the OS). */
  theme: ThemeName;
  /** Actual theme currently applied. */
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemeName) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function resolve(theme: ThemeName, systemDark: boolean): ResolvedTheme {
  if (theme === "system") return systemDark ? "dark" : "light";
  return theme;
}

function apply(resolved: ResolvedTheme) {
  document.documentElement.dataset.theme = resolved;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>("light");
  const [systemDark, setSystemDark] = useState(false);

  // Hydrate from storage + system preference after mount (the anti-FOUC
  // inline script has already applied the value before paint; this syncs
  // React state with it — the canonical next-themes pattern).
  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY) as ThemeName | null;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional post-mount hydration sync
    setSystemDark(media.matches);
    if (stored === "light" || stored === "dark" || stored === "system") {
      setThemeState(stored);
    }
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    apply(resolve(theme, systemDark));
  }, [theme, systemDark]);

  const setTheme = useCallback((next: ThemeName) => {
    window.localStorage.setItem(STORAGE_KEY, next);
    setThemeState(next);
  }, []);

  return (
    <ThemeContext.Provider
      value={{ theme, resolvedTheme: resolve(theme, systemDark), setTheme }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside <ThemeProvider>");
  return context;
}

// Keep in sync with STORAGE_KEY.
export const THEME_SCRIPT = `
(function () {
  try {
    var stored = window.localStorage.getItem("inkline-theme");
    var theme = stored === "light" || stored === "dark" || stored === "system" ? stored : "light";
    var resolved = theme === "system"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : theme;
    document.documentElement.dataset.theme = resolved;
  } catch (error) {
    document.documentElement.dataset.theme = "light";
  }
})();
`;
