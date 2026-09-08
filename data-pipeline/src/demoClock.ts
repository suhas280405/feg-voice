/**
 * The "demo clock" for Phase 0.
 *
 * Real PSK fixtures need NO time remapping — their genuine kickoff times
 * already look right relative to whenever the snapshot is built. Freshness
 * on stage is an operational concern, not a data-transform one: rerun
 * `npm run snapshot` shortly before presenting and the real fixtures it
 * pulls will naturally be near-term. (See "Operational note" in
 * buildFixtures.ts.)
 *
 * What this module actually does:
 *  1. Gives every fixture builder a single shared "now" anchor for one
 *     build run, so a run's selection/sort decisions are self-consistent
 *     even though fetches happen minutes apart under rate limiting.
 *  2. Provides an offset helper for constructing the one hand-authored
 *     synthetic fixture's kickoff/live-score timestamps relative to that
 *     anchor, since it has no real PSK timestamp to use as-is.
 *  3. Provides a selection helper that prefers real fixtures starting soon
 *     over ones months away, so a curated tournament (which may carry
 *     fixtures spanning a whole season) yields a sensible "what's on
 *     tonight"-shaped slice rather than an arbitrary one.
 */

/** Capture once per build run; pass the same value to every helper below. */
export function captureDemoNow(): Date {
  return new Date();
}

/** ISO timestamp `offsetMs` away from the anchor (negative = in the past, e.g. a live fixture that already started). */
export function offsetFromDemoNow(demoNow: Date, offsetMs: number): string {
  return new Date(demoNow.getTime() + offsetMs).toISOString();
}

export const HOUR_MS = 60 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export interface HasKickoff {
  kickoffMs: number;
}

/**
 * Sorts soonest-first relative to demoNow and keeps only fixtures within
 * `windowDays` in either direction (a fixture that finished days ago is as
 * un-demoable as one that starts next season). Fixtures already in progress
 * (kickoff in the past, within the window) sort first, which is exactly
 * what "what's on tonight" should surface.
 */
export function selectNearTerm<T extends HasKickoff>(
  items: readonly T[],
  demoNow: Date,
  windowDays = 30,
): T[] {
  const now = demoNow.getTime();
  const windowMs = windowDays * DAY_MS;
  return items
    .filter((item) => Math.abs(item.kickoffMs - now) <= windowMs)
    .slice()
    .sort((a, b) => a.kickoffMs - b.kickoffMs);
}
