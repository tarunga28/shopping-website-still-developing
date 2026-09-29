"use client";

import { useEffect } from "react";

/**
 * Bind a global keyboard shortcut, e.g. ⌘K / Ctrl-K for search.
 * Ignores single-character presses while typing in form fields unless a
 * modifier (⌘/Ctrl) is held.
 */
export function useHotkey(
  key: string,
  callback: (event: KeyboardEvent) => void,
  options: { withModifier?: boolean } = {},
) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;

      const modifierHeld = event.metaKey || event.ctrlKey;

      if (options.withModifier) {
        if (!modifierHeld || event.key.toLowerCase() !== key.toLowerCase()) return;
      } else {
        if (isTyping || event.key.toLowerCase() !== key.toLowerCase()) return;
      }

      event.preventDefault();
      callback(event);
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [key, callback, options.withModifier]);
}
