import { useSyncExternalStore } from "react";

const KEY = "inkline-recent-searches";
const LIMIT = 5;
const EMPTY: string[] = [];
const listeners = new Set<() => void>();

let snapshot: string[] = EMPTY;
let hydrated = false;

function emit() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function parseStored(): string[] {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return EMPTY;
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, LIMIT);
  } catch {
    return EMPTY;
  }
}

function publish(next: string[]) {
  snapshot = next;
  hydrated = true;
  emit();
}

/** Stable snapshot. useSyncExternalStore loops if this returns a new array each call. */
export function readRecentSearches(): string[] {
  if (typeof window === "undefined") return EMPTY;
  if (!hydrated) {
    hydrated = true;
    snapshot = parseStored();
  }
  return snapshot;
}

export function rememberSearch(query: string): string[] {
  const clean = query.trim().slice(0, 80);
  const current = parseStored();
  if (clean.length < 2) {
    publish(current);
    return current;
  }
  const next = [clean, ...current.filter((item) => item.toLowerCase() !== clean.toLowerCase())].slice(0, LIMIT);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Ignore storage failures.
  }
  publish(next);
  return next;
}

export function clearRecentSearches(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Ignore storage failures.
  }
  publish(EMPTY);
}

/** Recent searches from this device. Empty during SSR so markup matches. */
export function useRecentSearches(): string[] {
  return useSyncExternalStore(subscribe, readRecentSearches, () => EMPTY);
}
