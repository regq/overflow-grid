/**
 * progress.ts — levers 3, 5, 6 and 7: resume state (Zeigarnik), daily streak,
 * endowed weekly goal, chest loot table, and the local-only leaderboard.
 *
 * Everything here lives in localStorage on the player's own device. There is no
 * server, no account and no shared leaderboard, which is what lets us ship
 * child-safe defaults without a consent wall.
 */

import type { Levers } from './levers.js';
import type { Rng } from './rng.js';

export interface Profile {
  bestScore: number;
  /** local leaderboard, highest first */
  scores: number[];
  streakDays: number;
  /** YYYY-MM-DD of the last day with a completed game */
  lastPlayedDay: string | null;
  /** ISO week key, e.g. 2026-W43 */
  weekKey: string | null;
  /** clears earned toward this week's goal (excludes the endowed head start) */
  weeklyClears: number;
  totalClears: number;
  gamesPlayed: number;
  muted: boolean;
  /** cosmetic rewards unlocked from chests */
  unlocked: string[];
  /** a banked vent charge from a chest, consumed at the next game start */
  bankedVentCharge: number;
  firstSeenDay: string | null;
}

export interface ResumeState {
  /** flat 64-cell grid */
  cells: number[];
  pressure: number;
  score: number;
  combo: number;
  comboPeak: number;
  placements: number;
  /** piece ids in the tray */
  tray: string[];
  savedAt: number;
  /** how many cells short of the best near-complete line, for the return message */
  closestLineDeficit: number;
}

const PROFILE_KEY = 'og.profile';
const RESUME_KEY = 'og.resume';

export function emptyProfile(): Profile {
  return {
    bestScore: 0,
    scores: [],
    streakDays: 0,
    lastPlayedDay: null,
    weekKey: null,
    weeklyClears: 0,
    totalClears: 0,
    gamesPlayed: 0,
    muted: false,
    unlocked: [],
    bankedVentCharge: 0,
    firstSeenDay: null,
  };
}

export function dayKey(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** ISO-ish week key. Good enough to bucket a weekly goal, and stable. */
export function weekKey(t: number): string {
  const d = new Date(t);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7; // Monday = 0
  target.setUTCDate(target.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

export function loadProfile(storage: Storage | null): Profile {
  try {
    const raw = storage?.getItem(PROFILE_KEY);
    if (!raw) return emptyProfile();
    return { ...emptyProfile(), ...(JSON.parse(raw) as Partial<Profile>) };
  } catch {
    return emptyProfile();
  }
}

export function saveProfile(profile: Profile, storage: Storage | null): void {
  try {
    storage?.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    /* storage blocked: progress simply will not persist */
  }
}

export interface StreakUpdate {
  profile: Profile;
  /** true when today is a newly counted streak day (worth a telemetry event + UI beat) */
  advanced: boolean;
  /** true when the grace allowance absorbed a missed day */
  graceUsed: boolean;
  /** true when the streak reset to 1 */
  broken: boolean;
}

/**
 * Lever 5. Advance the daily streak. A missed day is forgiven up to
 * `streakGraceDays` times in a row, because a streak that snaps on the first
 * slip tends to end the relationship rather than restart it.
 */
export function advanceStreak(profile: Profile, levers: Levers, now: number): StreakUpdate {
  const today = dayKey(now);
  const next: Profile = { ...profile };
  if (!next.firstSeenDay) next.firstSeenDay = today;

  if (!levers.streakEnabled) return { profile: next, advanced: false, graceUsed: false, broken: false };

  if (next.lastPlayedDay === today) {
    return { profile: next, advanced: false, graceUsed: false, broken: false };
  }

  if (next.lastPlayedDay === null) {
    next.streakDays = 1;
    next.lastPlayedDay = today;
    return { profile: next, advanced: true, graceUsed: false, broken: false };
  }

  const gap = daysBetween(next.lastPlayedDay, today);
  next.lastPlayedDay = today;

  if (gap === 1) {
    next.streakDays += 1;
    return { profile: next, advanced: true, graceUsed: false, broken: false };
  }
  if (gap > 1 && gap - 1 <= levers.streakGraceDays) {
    next.streakDays += 1;
    return { profile: next, advanced: true, graceUsed: true, broken: false };
  }
  next.streakDays = 1;
  return { profile: next, advanced: true, graceUsed: false, broken: true };
}

export interface WeeklyGoal {
  /** total clears the goal is denominated in */
  target: number;
  /** clears granted for free at week start — the endowment */
  granted: number;
  /** clears the player has actually made this week */
  earned: number;
  /** 0..1 bar fill */
  fraction: number;
  complete: boolean;
}

/**
 * Lever 5 (endowed progress). The bar starts partly filled. We show the
 * endowment explicitly ("24 granted to start") rather than hiding it, because
 * the effect survives disclosure and the deception would not be worth it.
 */
export function weeklyGoal(profile: Profile, levers: Levers): WeeklyGoal {
  const target = Math.max(1, levers.weeklyGoalClears);
  const granted = Math.round(target * levers.weeklyGoalEndowedFraction);
  const earned = Math.max(0, profile.weeklyClears);
  const fraction = Math.min(1, (granted + earned) / target);
  return { target, granted, earned, fraction, complete: granted + earned >= target };
}

/** Roll the week over if needed, then add clears to the weekly goal. */
export function addWeeklyClears(profile: Profile, clears: number, now: number): Profile {
  const key = weekKey(now);
  const next: Profile = { ...profile };
  if (next.weekKey !== key) {
    next.weekKey = key;
    next.weeklyClears = 0;
  }
  next.weeklyClears += clears;
  next.totalClears += clears;
  return next;
}

/** Lever 7. Local-only leaderboard; "beat your best" needs no account. */
export function recordScore(profile: Profile, score: number, levers: Levers): Profile {
  const next: Profile = { ...profile };
  next.scores = [...next.scores, score].sort((a, b) => b - a).slice(0, levers.localLeaderboardSize);
  next.bestScore = Math.max(next.bestScore, score);
  next.gamesPlayed += 1;
  return next;
}

// ───────────────────────── resume (lever 3) ─────────────────────────

export function saveResume(state: ResumeState, storage: Storage | null): void {
  try {
    storage?.setItem(RESUME_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

export function clearResume(storage: Storage | null): void {
  try {
    storage?.removeItem(RESUME_KEY);
  } catch {
    /* ignore */
  }
}

export function loadResume(storage: Storage | null, levers: Levers, now: number): ResumeState | null {
  if (!levers.resumeEnabled) return null;
  try {
    const raw = storage?.getItem(RESUME_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw) as ResumeState;
    if (!Array.isArray(state.cells) || state.cells.length !== 64) return null;
    const ageHours = (now - state.savedAt) / 3600000;
    if (ageHours > levers.resumeMaxAgeHours) return null;
    return state;
  } catch {
    return null;
  }
}

/**
 * Lever 3. The return message. Naming the specific unfinished thing
 * ("1 clear from a 5-combo") is far stickier than a generic welcome back —
 * an interrupted task keeps its hold until it is closed.
 */
export function resumeMessage(state: ResumeState, levers: Levers): string {
  if (levers.resumeShowUnfinishedCombo && state.combo > 0) {
    const nextCombo = state.combo + 1;
    return `You were 1 clear from a ${nextCombo}-combo.`;
  }
  if (state.closestLineDeficit === 1) return 'You left a line 1 cell from clearing.';
  if (state.comboPeak >= 3) return `Your board is still live — best combo so far: ${state.comboPeak}x.`;
  return `Your board is still live at ${state.score} points.`;
}

// ───────────────────────── chests (lever 6) ─────────────────────────

export interface LootEntry {
  id: string;
  label: string;
  /** relative weight; the UI shows the derived percentage, honestly */
  weight: number;
  kind: 'vent-charge' | 'cosmetic' | 'clear-ballast';
}

/**
 * The loot table is exported so the UI can render the real odds. Showing the
 * table is the whole point: the reward stays variable, the information does not.
 */
export const LOOT_TABLE: readonly LootEntry[] = [
  { id: 'vent-1', label: 'Vent Charge — start next game with an empty meter', weight: 50, kind: 'vent-charge' },
  { id: 'cosmetic-tide', label: 'Tile set: Tideline', weight: 25, kind: 'cosmetic' },
  { id: 'ballast-2', label: 'Dissolve 2 ballast tiles now', weight: 20, kind: 'clear-ballast' },
  { id: 'cosmetic-ember', label: 'Tile set: Ember (rare)', weight: 5, kind: 'cosmetic' },
];

export function lootOdds(): { label: string; percent: number }[] {
  const total = LOOT_TABLE.reduce((sum, entry) => sum + entry.weight, 0);
  return LOOT_TABLE.map((entry) => ({
    label: entry.label,
    percent: Math.round((entry.weight / total) * 1000) / 10,
  }));
}

export function rollChest(rng: Rng): LootEntry {
  const total = LOOT_TABLE.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = rng.next() * total;
  for (const entry of LOOT_TABLE) {
    roll -= entry.weight;
    if (roll <= 0) return entry;
  }
  return LOOT_TABLE[LOOT_TABLE.length - 1]!;
}
