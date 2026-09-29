/**
 * Privacy consent architecture.
 *
 * Essential storage (session, theme, announcement dismiss) does not require
 * a marketing opt-in. Analytics and marketing stay off until a person
 * opts in — and even then this module does not load third-party scripts.
 * A future provider must call `hasConsent` before injecting anything.
 */

export type ConsentCategory = "essential" | "analytics" | "marketing";

export interface ConsentState {
  essential: true;
  analytics: boolean;
  marketing: boolean;
  updatedAt: string | null;
}

export const CONSENT_STORAGE_KEY = "inkline-consent";

export function defaultConsent(): ConsentState {
  return { essential: true, analytics: false, marketing: false, updatedAt: null };
}

export function parseConsent(raw: string | null): ConsentState {
  if (!raw) return defaultConsent();
  try {
    const value = JSON.parse(raw) as Partial<ConsentState>;
    return {
      essential: true,
      analytics: value.analytics === true,
      marketing: value.marketing === true,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    };
  } catch {
    return defaultConsent();
  }
}

export function readConsent(): ConsentState {
  if (typeof window === "undefined") return defaultConsent();
  try {
    return parseConsent(window.localStorage.getItem(CONSENT_STORAGE_KEY));
  } catch {
    return defaultConsent();
  }
}

export function writeConsent(next: Omit<ConsentState, "essential" | "updatedAt"> & { updatedAt?: string }): ConsentState {
  const state: ConsentState = {
    essential: true,
    analytics: next.analytics,
    marketing: next.marketing,
    updatedAt: next.updatedAt ?? new Date().toISOString(),
  };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Private mode / blocked storage — preference simply doesn't persist.
    }
  }
  return state;
}

export function hasConsent(category: ConsentCategory): boolean {
  if (category === "essential") return true;
  return readConsent()[category] === true;
}
