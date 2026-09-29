import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Node-environment tests (e.g. DB integration) have no `window`.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

// Radix (checkbox, radio, dialog) measures with ResizeObserver, which jsdom lacks.
if (typeof window !== "undefined" && typeof window.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, "ResizeObserver", { writable: true, value: ResizeObserverStub });
}

// Vitest runs with globals disabled, so RTL's auto-cleanup must be wired up.
afterEach(() => cleanup());
