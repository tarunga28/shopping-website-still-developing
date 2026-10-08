/**
 * Time decay for interest signals.
 *
 * Recency matters, but a hard cutoff would be wrong: a shopper who bought a
 * coffee machine eight months ago is still a plausible buyer of filters, while
 * one who viewed it yesterday is a far stronger one. Decay expresses that
 * gradient instead of a cliff.
 *
 * Two functions are provided because they answer different questions:
 *
 *   exponential — "how long ago?" A smooth, monotonic fade. Good default.
 *   halfLife    — the same curve, but parameterised by the intuitive "interest
 *                 halves every N days", which is what an operator can actually
 *                 reason about when tuning.
 *
 * Both are pure and both clamp to [0, 1], so a future timestamp (clock skew
 * between the app server and the database) yields 1.0 rather than a weight
 * above the maximum.
 */

/** Decay configuration. `halfLifeDays` is the only knob an operator needs. */
export interface DecayConfig {
  /** Days for a signal to fall to half weight. Must be > 0. */
  halfLifeDays: number;
  /** Floor below which a signal is dropped entirely rather than decayed. */
  floor: number;
}

export const DEFAULT_DECAY: DecayConfig = {
  // Two weeks: long enough that a considered purchase still counts next month,
  // short enough that a casual browse stops dominating within a quarter.
  halfLifeDays: 14,
  floor: 0.01,
};

const MS_PER_DAY = 86_400_000;
const LN2 = Math.LN2;

/**
 * Exponential decay: `0.5 ^ (ageDays / halfLifeDays)`.
 *
 * Returns 1 for a signal happening now, 0.5 at one half-life, 0.25 at two.
 */
export function exponentialDecay(ageMs: number, config: DecayConfig = DEFAULT_DECAY): number {
  if (!Number.isFinite(ageMs)) return 0;
  if (ageMs <= 0) return 1;
  const halfLife = Math.max(config.halfLifeDays, 1e-6) * MS_PER_DAY;
  const value = Math.pow(0.5, (ageMs / halfLife) * LN2 / LN2);
  return value < config.floor ? 0 : value;
}

/**
 * Linear decay to zero over a fixed window.
 *
 * Deliberately offered alongside the exponential: for short-lived session
 * intent a linear ramp is easier to predict, since an exponential still gives
 * a 30-day-old browse a non-trivial weight.
 */
export function linearDecay(ageMs: number, windowDays: number, floor = 0): number {
  if (!Number.isFinite(ageMs)) return 0;
  if (ageMs <= 0) return 1;
  const window = Math.max(windowDays, 1e-6) * MS_PER_DAY;
  const value = 1 - ageMs / window;
  if (value <= 0) return 0;
  return value < floor ? 0 : value;
}

/** Named decay strategies, so a config can select one by name. */
export const DECAY_METHODS = ["EXPONENTIAL", "LINEAR"] as const;
export type DecayMethod = (typeof DECAY_METHODS)[number];

export function decayFor(
  method: DecayMethod,
  ageMs: number,
  config: DecayConfig = DEFAULT_DECAY,
): number {
  return method === "LINEAR"
    ? linearDecay(ageMs, config.halfLifeDays * 2, config.floor)
    : exponentialDecay(ageMs, config);
}

/**
 * Apply decay to a weighted signal.
 *
 * `now` is injectable so tests are deterministic rather than depending on how
 * long the suite takes to run.
 */
export function decaySignal(
  weight: number,
  occurredAt: Date,
  now: Date = new Date(),
  config: DecayConfig = DEFAULT_DECAY,
  method: DecayMethod = "EXPONENTIAL",
): number {
  if (!Number.isFinite(weight) || weight === 0) return 0;
  const ageMs = now.getTime() - occurredAt.getTime();
  // Negative weights are preserved, not discarded. A return or an explicit
  // "not interested" has to subtract, and it has to fade on the same curve as
  // a positive signal — an old grievance should not outlast an old preference.
  return weight * decayFor(method, ageMs, config);
}

/**
 * Human-readable age, for the explanation layer and the debugger.
 *
 * Rounded down to the largest unit that is at least 1, so a signal from 90
 * minutes ago reads "1 hour" rather than "90 minutes" or "0 days".
 */
export function describeAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "just now";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"}`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"}`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"}`;
}
