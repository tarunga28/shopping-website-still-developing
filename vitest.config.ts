import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      // The real `server-only` package throws outside RSC; stubbed for tests.
      "server-only": resolve(__dirname, "tests/mocks/server-only.ts"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    // Tests exercise pure logic/components only — no DB or network needed.
    name: "inkline-foundation",
  },
});
