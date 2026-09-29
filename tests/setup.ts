import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest runs with globals disabled, so RTL's auto-cleanup must be wired up.
afterEach(() => cleanup());
