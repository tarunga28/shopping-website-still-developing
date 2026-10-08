import "server-only";

import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";

import { db } from "@/db";
import { userInterestProfiles, userInterestSignals } from "@/db/schema";
import type { DbClient } from "@/db/utils";
import { logger } from "@/lib/logger";
import {
  buildInterestProfile,
  estimatePricePreference,
  profileConfidence,
  type InterestOptions,
} from "@/lib/recommendations/interest";
import type { InterestDimension, InterestProfile, InterestSignal } from "@/lib/recommendations/types";
import { MIN_PERSONALIZATION_CONFIDENCE } from "@/lib/recommendations/types";
import { DEFAULT_DECAY } from "@/lib/recommendations/decay";

/**
 * User interest profiles.
 *
 * A profile is a *materialized snapshot* of decayed interest, not a live query.
 * Building one means reading every signal row for a subject and applying decay
 * to each — bounded, but not free, and identical for every request inside the
 * cache window. Recomputing it per page render would be wasted work on the hot
 * path.
 *
 * The snapshot stores `decayVersion` alongside the weights so a stale profile
 * produced under an old decay curve is identifiable rather than silently
 * wrong.
 */

export type ProfileSubject = { userId: string; sessionHash?: null } | { userId?: null; sessionHash: string };

/** How long a materialized profile is trusted before it is rebuilt. */
export const PROFILE_MAX_AGE_MS = 10 * 60_000;

/** Signals older than this are dropped rather than decayed to near-zero. */
export const SIGNAL_LOOKBACK_DAYS = 180;

/** Narrow the union explicitly — TypeScript cannot infer it from the ternary. */
function subjectUserId(subject: ProfileSubject): string | null {
  return typeof subject.userId === "string" && subject.userId.length > 0 ? subject.userId : null;
}

function subjectSession(subject: ProfileSubject): string | null {
  return typeof subject.sessionHash === "string" && subject.sessionHash.length > 0
    ? subject.sessionHash
    : null;
}

function subjectFilter(subject: ProfileSubject) {
  const userId = subjectUserId(subject);
  return userId
    ? eq(userInterestSignals.userId, userId)
    : eq(userInterestSignals.sessionHash, subjectSession(subject) ?? "");
}

/**
 * Read raw signals for a subject, grouped by dimension.
 *
 * Bounded by a lookback window. Decay would eventually make older rows
 * irrelevant anyway, but reading 18 months of history to decay it to 0.001 is
 * wasted I/O, and the window makes the read cost predictable.
 */
export async function loadSignals(
  subject: ProfileSubject,
  options: { lookbackDays?: number } = {},
  client: DbClient = db,
): Promise<Partial<Record<InterestDimension, InterestSignal[]>>> {
  const lookbackDays = options.lookbackDays ?? SIGNAL_LOOKBACK_DAYS;
  const since = new Date(Date.now() - lookbackDays * 86_400_000);

  const rows = await client
    .select({
      dimension: userInterestSignals.dimension,
      key: userInterestSignals.key,
      rawWeight: userInterestSignals.rawWeight,
      eventCount: userInterestSignals.eventCount,
      lastSeenAt: userInterestSignals.lastSeenAt,
    })
    .from(userInterestSignals)
    .where(and(subjectFilter(subject), gte(userInterestSignals.lastSeenAt, since)))
    .orderBy(desc(userInterestSignals.rawWeight))
    .limit(2000);

  const grouped: Partial<Record<InterestDimension, InterestSignal[]>> = {};
  for (const row of rows) {
    const list = grouped[row.dimension] ?? [];
    list.push({
      dimension: row.dimension,
      key: row.key,
      weight: row.rawWeight,
      occurredAt: row.lastSeenAt,
      magnitude: row.eventCount,
    });
    grouped[row.dimension] = list;
  }
  return grouped;
}

/**
 * Build a decayed profile in memory, without persisting it.
 *
 * Used by the debugger and by tests, where the point is to see what the
 * engine would conclude right now rather than what it last wrote.
 */
export async function computeProfile(
  subject: ProfileSubject,
  options: InterestOptions & { lookbackDays?: number; now?: Date } = {},
  client: DbClient = db,
): Promise<{
  interests: InterestProfile;
  confidence: number;
  signalCount: number;
  pricePreference: Record<string, { minPaise: number; maxPaise: number }>;
}> {
  const now = options.now ?? new Date();
  const grouped = await loadSignals(subject, { lookbackDays: options.lookbackDays }, client);

  const interests = buildInterestProfile(grouped, { ...options, now });
  const signalCount = Object.values(grouped).reduce((total, list) => total + (list?.length ?? 0), 0);
  const confidence = profileConfidence(interests);

  // Price preference is derived from purchase-like signals only. A shopper who
  // *viewed* one expensive laptop has not told you their budget; one who
  // *bought* three mid-range phones has.
  const priceObservations = (grouped.PRODUCT ?? [])
    .filter((signal) => signal.weight >= 4)
    .map((signal) => ({
      categoryId: interests.CATEGORY ? topKey(interests.CATEGORY) : null,
      pricePaise: bandMidpoint(signal.key),
      weight: signal.magnitude ?? 1,
    }))
    .filter((observation) => observation.pricePaise > 0);

  return {
    interests,
    confidence,
    signalCount,
    pricePreference: estimatePricePreference(priceObservations),
  };
}

/** The strongest key in a normalized dimension. */
function topKey(dimension: Record<string, number>): string | null {
  let best: string | null = null;
  let bestValue = -Infinity;
  for (const [key, value] of Object.entries(dimension)) {
    if (value > bestValue) {
      bestValue = value;
      best = key;
    }
  }
  return best;
}

/**
 * Midpoint of a `"1000-10000"` band key.
 *
 * Geometric rather than arithmetic, matching the logarithmic bucketing in
 * `priceBandKey` — the midpoint of ₹1,000–₹10,000 is ₹3,162, not ₹5,500.
 */
function bandMidpoint(key: string): number {
  const match = /^(\d+)-(\d+)$/.exec(key);
  if (!match) return 0;
  const lower = Number(match[1]);
  const upper = Number(match[2]);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower <= 0 || upper <= 0) return 0;
  return Math.round(Math.sqrt(lower * upper));
}

/**
 * Get or rebuild a subject's profile.
 *
 * Returns the stored profile when it is fresh enough, otherwise recomputes and
 * upserts. A rebuild failure falls back to the stale profile rather than
 * throwing: a slightly out-of-date interest vector is a better recommendation
 * input than no input at all, and the storefront must not fail because a
 * background computation did.
 */
export async function getProfile(
  subject: ProfileSubject,
  options: { maxAgeMs?: number; now?: Date; force?: boolean } = {},
  client: DbClient = db,
): Promise<{
  interests: InterestProfile;
  confidence: number;
  signalCount: number;
  pricePreference: Record<string, { minPaise: number; maxPaise: number }>;
  computedAt: Date;
  stale: boolean;
}> {
  const maxAgeMs = options.maxAgeMs ?? PROFILE_MAX_AGE_MS;
  const now = options.now ?? new Date();

  let existing: {
    interests: InterestProfile;
    pricePreference: Record<string, { minPaise: number; maxPaise: number }>;
    confidence: number;
    signalCount: number;
    computedAt: Date;
  } | null = null;

  try {
    const [row] = await client
      .select({
        interests: userInterestProfiles.interests,
        pricePreference: userInterestProfiles.pricePreference,
        confidence: userInterestProfiles.confidence,
        signalCount: userInterestProfiles.signalCount,
        computedAt: userInterestProfiles.computedAt,
      })
      .from(userInterestProfiles)
      .where(
        subjectUserId(subject)
          ? eq(userInterestProfiles.userId, subjectUserId(subject)!)
          : eq(userInterestProfiles.sessionHash, subjectSession(subject) ?? ""),
      )
      .limit(1);
    if (row) {
      existing = {
        interests: (row.interests ?? {}) as InterestProfile,
        pricePreference: (row.pricePreference ?? {}) as Record<string, { minPaise: number; maxPaise: number }>,
        confidence: row.confidence,
        signalCount: row.signalCount,
        computedAt: row.computedAt,
      };
    }
  } catch (error) {
    logger.warn("failed to read interest profile", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const ageMs = existing ? now.getTime() - existing.computedAt.getTime() : Infinity;
  if (existing && !options.force && ageMs < maxAgeMs) {
    return { ...existing, stale: false };
  }

  try {
    const computed = await computeProfile(subject, { now }, client);
    await upsertProfile(subject, computed, now, client);
    return { ...computed, computedAt: now, stale: false };
  } catch (error) {
    logger.warn("failed to rebuild interest profile; using stale", {
      error: error instanceof Error ? error.message : String(error),
    });
    if (existing) return { ...existing, stale: true };
    return {
      interests: {},
      confidence: 0,
      signalCount: 0,
      pricePreference: {},
      computedAt: now,
      stale: true,
    };
  }
}

async function upsertProfile(
  subject: ProfileSubject,
  computed: {
    interests: InterestProfile;
    pricePreference: Record<string, { minPaise: number; maxPaise: number }>;
    confidence: number;
    signalCount: number;
  },
  now: Date,
  client: DbClient,
): Promise<void> {
  const decayVersion = `exponential-v1:h${DEFAULT_DECAY.halfLifeDays}`;
  const values = {
    userId: subjectUserId(subject),
    sessionHash: subjectSession(subject),
    interests: computed.interests,
    pricePreference: computed.pricePreference,
    confidence: computed.confidence,
    signalCount: computed.signalCount,
    decayVersion,
    computedAt: now,
  };

  // The uniqueness target differs by subject: a user profile is keyed on
  // user_id, a session profile on session_hash.
  const target = subjectUserId(subject)
    ? userInterestProfiles.userId
    : userInterestProfiles.sessionHash;

  await client
    .insert(userInterestProfiles)
    .values(values)
    .onConflictDoUpdate({
      target,
      set: {
        interests: computed.interests,
        pricePreference: computed.pricePreference,
        confidence: computed.confidence,
        signalCount: computed.signalCount,
        decayVersion,
        computedAt: now,
      },
    });
}

/**
 * Should this request be personalized at all?
 *
 * A profile built from one product view should not drive a "recommended for
 * you" rail. The honest answer for that shopper is the trending list, and
 * pretending otherwise produces the confidently-wrong recommendations that
 * make people distrust a storefront.
 */
export function shouldPersonalize(confidence: number): boolean {
  return confidence >= MIN_PERSONALIZATION_CONFIDENCE;
}

/**
 * Session-scoped profile for anonymous shoppers (§20, §21).
 *
 * Uses the same machinery as an authenticated profile, keyed on the salted
 * session hash. Session personalization is deliberately not persisted beyond
 * the profile row itself: no browsing history is retained for a visitor who
 * never signed in, because a session-keyed server history would be a
 * de-anonymized browsing record with the identifiers filed off.
 */
export async function getSessionProfile(
  sessionHash: string,
  options: { maxAgeMs?: number; now?: Date } = {},
  client: DbClient = db,
) {
  return getProfile({ sessionHash }, { ...options, maxAgeMs: options.maxAgeMs ?? 5 * 60_000 }, client);
}

/** Rebuild profiles in bulk — used by the offline job. */
export async function rebuildProfiles(
  options: { limit?: number; staleOnly?: boolean; now?: Date } = {},
  client: DbClient = db,
): Promise<number> {
  const limit = Math.min(options.limit ?? 500, 5000);
  const now = options.now ?? new Date();

  // Subjects with recent activity. Rebuilding every profile ever created would
  // do pointless work for accounts that have not visited in a year.
  const cutoff = new Date(now.getTime() - SIGNAL_LOOKBACK_DAYS * 86_400_000);
  const subjects = await client
    .selectDistinct({
      userId: userInterestSignals.userId,
      sessionHash: userInterestSignals.sessionHash,
    })
    .from(userInterestSignals)
    .where(gte(userInterestSignals.lastSeenAt, cutoff))
    .limit(limit);

  let rebuilt = 0;
  for (const subject of subjects) {
    const profileSubject: ProfileSubject | null = subject.userId
      ? { userId: subject.userId }
      : subject.sessionHash
        ? { sessionHash: subject.sessionHash }
        : null;
    if (!profileSubject) continue;
    try {
      await getProfile(profileSubject, { force: true, now }, client);
      rebuilt += 1;
    } catch (error) {
      // One bad subject must not abort the batch.
      logger.warn("failed to rebuild interest profile", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return rebuilt;
}

/** Delete session profiles older than the retention window. */
export async function pruneSessionProfiles(
  options: { olderThan: Date; batchSize?: number },
  client: DbClient = db,
): Promise<number> {
  const batchSize = Math.min(options.batchSize ?? 5000, 50_000);
  try {
    const result = await client.execute(sql`
      delete from user_interest_profiles
       where id in (
         select id from user_interest_profiles
          where session_hash is not null
            and computed_at < ${options.olderThan}
          limit ${batchSize}
       )
    `);
    const count = Number((result as unknown as { rowCount?: number }).rowCount ?? 0);
    return Number.isFinite(count) ? count : 0;
  } catch (error) {
    logger.warn("failed to prune session profiles", {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/**
 * Merge a session profile into a user profile on sign-in.
 *
 * Without this, everything an anonymous shopper did before logging in is
 * discarded at exactly the moment it becomes attributable — and the newly
 * signed-in user gets cold-start recommendations for a product page they were
 * browsing thirty seconds ago.
 *
 * Session weights are folded in at a discount rather than at full strength:
 * anonymous browsing is weaker evidence than authenticated behaviour, since a
 * shared device or a curious glance looks identical to genuine intent.
 */
export async function mergeSessionIntoUser(
  sessionHash: string,
  userId: string,
  options: { discount?: number } = {},
  client: DbClient = db,
): Promise<number> {
  const discount = options.discount ?? 0.7;
  const rows = await client
    .select()
    .from(userInterestSignals)
    .where(eq(userInterestSignals.sessionHash, sessionHash));
  if (rows.length === 0) return 0;

  let merged = 0;
  for (const row of rows) {
    try {
      await client
        .insert(userInterestSignals)
        .values({
          userId,
          sessionHash: null,
          dimension: row.dimension,
          key: row.key,
          rawWeight: Math.max(0, row.rawWeight * discount),
          eventCount: row.eventCount,
          strongestEvent: row.strongestEvent,
          lastSeenAt: row.lastSeenAt,
        })
        .onConflictDoUpdate({
          target: [
            userInterestSignals.userId,
            userInterestSignals.sessionHash,
            userInterestSignals.dimension,
            userInterestSignals.key,
          ],
          set: {
            rawWeight: sql`greatest(0, ${userInterestSignals.rawWeight} + ${Math.max(0, row.rawWeight * discount)})`,
            eventCount: sql`${userInterestSignals.eventCount} + ${row.eventCount}`,
            lastSeenAt: sql`greatest(${userInterestSignals.lastSeenAt}, ${row.lastSeenAt})`,
          },
        });
      merged += 1;
    } catch (error) {
      logger.warn("failed to merge session signal into user profile", {
        dimension: row.dimension,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Rebuild so the merged signals are reflected immediately, and drop the
  // session rows — they now belong to the user.
  if (merged > 0) {
    await getProfile({ userId }, { force: true }, client).catch(() => undefined);
    await client
      .delete(userInterestSignals)
      .where(eq(userInterestSignals.sessionHash, sessionHash))
      .catch(() => undefined);
  }
  return merged;
}

export const PROFILE_INTERNALS = {
  bandMidpoint,
  topKey,
  or,
  inArray,
  isNull,
};
