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
      // next-auth imports these without the .js extension that Node's ESM loader wants.
      "next/server": resolve(__dirname, "node_modules/next/server.js"),
      "next/headers": resolve(__dirname, "node_modules/next/headers.js"),
      "next/navigation": resolve(__dirname, "node_modules/next/navigation.js"),
    },
  },
  test: {
    // `next-auth` ships ESM that imports `next/server` without the `.js`
    // extension Node's loader requires. Left externalized, Node resolves it
    // directly and the alias above never applies — so any module that reaches
    // auth (the admin-guarded API routes) fails to import. Inlining it lets
    // Vite apply the alias.
    server: {
      deps: {
        inline: ["next-auth"],
      },
    },
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    // Importing the DB module requires a URL. Unit tests must not open a connection;
    // integration tests (tests/integration) only run when TEST_DATABASE_URL points at a
    // disposable database with the schema applied (see README → Testing).
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://inkline:inkline@127.0.0.1:5432/inkline_test",
      AUTH_SECRET: "test-secret-not-used-for-signing-sessions",
      AUTH_TRUST_HOST: "true",
    },
    name: "inkline-foundation",
  },
});
