/**
 * Vitest stub for the `server-only` package. The real package throws when
 * imported outside React Server Components — in unit tests it's a no-op,
 * because node-side modules are exactly what we're testing.
 */
export {};
