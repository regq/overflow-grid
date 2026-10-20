/**
 * difficulty.ts — the flow curve.
 *
 * Difficulty tracks measured ABILITY, not elapsed time. We keep a timestamped
 * ring of recent clears, compute clears-per-minute over a sliding window, map
 * that onto 0..1 skill between a floor and a ceiling, and smooth it so the
 * ramp never lurches mid-combo.
 *
 * Below the floor the game eases off instead of punishing a struggling player;
 * above the ceiling it stops getting harder, which prevents a despair spiral.
 */

import type { Levers } from './levers.js';

export interface SkillTracker {
  /** epoch ms of each recent clear event */
  clearTimes: number[];
  /** smoothed skill, 0..1 */
  skill: number;
  /** when tracking began, so a short session is not judged as a slow one */
  startedAt: number;
}

export function createSkillTracker(now: number): SkillTracker {
  return { clearTimes: [], skill: 0, startedAt: now };
}

/** Record `lines` cleared at time `now`. */
export function recordClears(tracker: SkillTracker, lines: number, now: number): void {
  for (let i = 0; i < lines; i++) tracker.clearTimes.push(now);
}

/** Raw clears/min over the sliding window (or since start, if that is shorter). */
export function clearsPerMinute(tracker: SkillTracker, levers: Levers, now: number): number {
  const windowMs = levers.skillWindowSeconds * 1000;
  const cutoff = now - windowMs;
  const recent = tracker.clearTimes.filter((t) => t >= cutoff);
  const elapsedMs = Math.min(windowMs, Math.max(1, now - tracker.startedAt));
  return recent.length / (elapsedMs / 60000);
}

/** Map clears/min onto 0..1 between the floor and ceiling levers. */
export function rawSkill(cpm: number, levers: Levers): number {
  const lo = levers.skillFloorClearsPerMin;
  const hi = levers.skillCeilClearsPerMin;
  if (hi <= lo) return 0;
  return clamp01((cpm - lo) / (hi - lo));
}

/** Advance the smoothed skill estimate. Call once per placement. */
export function updateSkill(tracker: SkillTracker, levers: Levers, now: number): number {
  const target = rawSkill(clearsPerMinute(tracker, levers, now), levers);
  const a = clamp01(levers.skillSmoothing);
  tracker.skill = tracker.skill + a * (target - tracker.skill);
  // drop timestamps that can no longer affect the window
  const cutoff = now - levers.skillWindowSeconds * 1000;
  if (tracker.clearTimes.length > 256) {
    tracker.clearTimes = tracker.clearTimes.filter((t) => t >= cutoff);
  }
  return tracker.skill;
}

/**
 * Probability that the generator steers a piece toward a clear.
 * Decays from ceiling to floor over `assistDecayPlacements`, then stays
 * probabilistic forever. Higher skill pulls it down further — a strong player
 * gets less help, which is what keeps them in flow.
 */
export function assistProbability(levers: Levers, placements: number, skill: number): number {
  const t = clamp01(placements / Math.max(1, levers.assistDecayPlacements));
  const byTime = levers.assistProbabilityCeiling +
    (levers.assistProbabilityFloor - levers.assistProbabilityCeiling) * t;
  // skill pulls the assist down toward the floor, but never below it
  const bySkill = byTime - (byTime - levers.assistProbabilityFloor) * clamp01(skill);
  return clamp01(Math.max(levers.assistProbabilityFloor, bySkill));
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
