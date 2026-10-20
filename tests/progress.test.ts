import { describe, expect, it } from 'vitest';
import { defaultLevers, type Levers } from '../src/levers.js';
import {
  LOOT_TABLE,
  addWeeklyClears,
  advanceStreak,
  emptyProfile,
  lootOdds,
  recordScore,
  resumeMessage,
  rollChest,
  weekKey,
  weeklyGoal,
  type ResumeState,
} from '../src/progress.js';
import { makeRng } from '../src/rng.js';

const DAY = 86400000;
const day = (n: number): number => Date.parse('2026-03-02T12:00:00Z') + n * DAY;

describe('daily streak (lever 5)', () => {
  it('starts at 1 on the first completed game', () => {
    const result = advanceStreak(emptyProfile(), defaultLevers, day(0));
    expect(result.profile.streakDays).toBe(1);
    expect(result.advanced).toBe(true);
  });

  it('does not double-count two games on the same day', () => {
    const first = advanceStreak(emptyProfile(), defaultLevers, day(0));
    const second = advanceStreak(first.profile, defaultLevers, day(0) + 3600000);
    expect(second.profile.streakDays).toBe(1);
    expect(second.advanced).toBe(false);
  });

  it('increments on consecutive days', () => {
    let profile = emptyProfile();
    for (let i = 0; i < 4; i++) {
      profile = advanceStreak(profile, defaultLevers, day(i)).profile;
    }
    expect(profile.streakDays).toBe(4);
  });

  it('forgives a single missed day within the grace allowance', () => {
    let profile = advanceStreak(emptyProfile(), defaultLevers, day(0)).profile;
    const result = advanceStreak(profile, defaultLevers, day(2)); // skipped day 1
    expect(result.graceUsed).toBe(true);
    expect(result.broken).toBe(false);
    expect(result.profile.streakDays).toBe(2);
    profile = result.profile;
  });

  it('breaks when the gap exceeds the grace', () => {
    const profile = advanceStreak(emptyProfile(), defaultLevers, day(0)).profile;
    const result = advanceStreak(profile, defaultLevers, day(5));
    expect(result.broken).toBe(true);
    expect(result.profile.streakDays).toBe(1);
  });

  it('respects a zero-grace configuration', () => {
    const strict: Levers = { ...defaultLevers, streakGraceDays: 0 };
    const profile = advanceStreak(emptyProfile(), strict, day(0)).profile;
    expect(advanceStreak(profile, strict, day(2)).broken).toBe(true);
  });

  it('is a no-op when the lever is off', () => {
    const off: Levers = { ...defaultLevers, streakEnabled: false };
    const result = advanceStreak(emptyProfile(), off, day(0));
    expect(result.profile.streakDays).toBe(0);
  });
});

describe('endowed weekly goal (lever 5)', () => {
  it('starts the bar partly filled, and says so', () => {
    const goal = weeklyGoal(emptyProfile(), defaultLevers);
    expect(goal.granted).toBe(Math.round(defaultLevers.weeklyGoalClears * 0.2));
    expect(goal.earned).toBe(0);
    expect(goal.fraction).toBeCloseTo(0.2, 5);
    expect(goal.complete).toBe(false);
  });

  it('completes once granted + earned reach the target', () => {
    let profile = emptyProfile();
    const needed = defaultLevers.weeklyGoalClears - Math.round(defaultLevers.weeklyGoalClears * 0.2);
    profile = addWeeklyClears(profile, needed, day(0));
    const goal = weeklyGoal(profile, defaultLevers);
    expect(goal.complete).toBe(true);
    expect(goal.fraction).toBe(1);
  });

  it('never exceeds a full bar', () => {
    const profile = addWeeklyClears(emptyProfile(), 9999, day(0));
    expect(weeklyGoal(profile, defaultLevers).fraction).toBe(1);
  });

  it('resets the weekly tally when the week rolls over', () => {
    let profile = addWeeklyClears(emptyProfile(), 30, day(0));
    expect(profile.weeklyClears).toBe(30);
    profile = addWeeklyClears(profile, 5, day(14));
    expect(profile.weeklyClears).toBe(5);
    expect(profile.totalClears).toBe(35);
  });

  it('week keys are stable within a week and differ across weeks', () => {
    expect(weekKey(day(0))).toBe(weekKey(day(1)));
    expect(weekKey(day(0))).not.toBe(weekKey(day(9)));
  });

  it('clamps an absurd endowment rather than handing out a free goal', () => {
    const absurd: Levers = { ...defaultLevers, weeklyGoalEndowedFraction: 5 };
    // loadLevers clamps this; weeklyGoal itself must still not exceed 1
    expect(weeklyGoal(emptyProfile(), absurd).fraction).toBe(1);
  });
});

describe('local leaderboard (lever 7)', () => {
  it('keeps the top N scores, highest first', () => {
    let profile = emptyProfile();
    for (const score of [100, 900, 400, 1200, 50, 700]) {
      profile = recordScore(profile, score, defaultLevers);
    }
    expect(profile.scores).toEqual([1200, 900, 700, 400, 100]);
    expect(profile.bestScore).toBe(1200);
    expect(profile.gamesPlayed).toBe(6);
  });

  it('honours a smaller leaderboard size', () => {
    const small: Levers = { ...defaultLevers, localLeaderboardSize: 2 };
    let profile = emptyProfile();
    for (const score of [10, 20, 30]) profile = recordScore(profile, score, small);
    expect(profile.scores).toEqual([30, 20]);
  });
});

describe('resume messaging (lever 3)', () => {
  const base: ResumeState = {
    cells: new Array(64).fill(0),
    pressure: 10,
    score: 1234,
    combo: 0,
    comboPeak: 0,
    placements: 12,
    tray: ['dot'],
    savedAt: day(0),
    closestLineDeficit: 4,
  };

  it('names the unfinished combo when there is one', () => {
    expect(resumeMessage({ ...base, combo: 4 }, defaultLevers)).toBe('You were 1 clear from a 5-combo.');
  });

  it('falls back to the near-complete line', () => {
    expect(resumeMessage({ ...base, closestLineDeficit: 1 }, defaultLevers)).toContain('1 cell from clearing');
  });

  it('falls back to the best combo so far', () => {
    expect(resumeMessage({ ...base, comboPeak: 5 }, defaultLevers)).toContain('5x');
  });

  it('always says something concrete about the saved board', () => {
    expect(resumeMessage(base, defaultLevers)).toContain('1234');
  });

  it('does not mention the combo when the lever is off', () => {
    const off: Levers = { ...defaultLevers, resumeShowUnfinishedCombo: false };
    expect(resumeMessage({ ...base, combo: 4 }, off)).not.toContain('combo');
  });
});

describe('chest loot table (lever 6)', () => {
  it('publishes odds that sum to 100%', () => {
    const total = lootOdds().reduce((sum, entry) => sum + entry.percent, 0);
    expect(total).toBeCloseTo(100, 1);
  });

  it('published odds match the weights that actually roll', () => {
    const rng = makeRng(123);
    const counts = new Map<string, number>();
    const trials = 20000;
    for (let i = 0; i < trials; i++) {
      const entry = rollChest(rng);
      counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
    }
    const totalWeight = LOOT_TABLE.reduce((sum, entry) => sum + entry.weight, 0);
    for (const entry of LOOT_TABLE) {
      const observed = (counts.get(entry.id) ?? 0) / trials;
      const published = entry.weight / totalWeight;
      expect(Math.abs(observed - published)).toBeLessThan(0.02);
    }
  });

  it('every entry is reachable', () => {
    const rng = makeRng(7);
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(rollChest(rng).id);
    expect(seen.size).toBe(LOOT_TABLE.length);
  });

  it('contains no currency or pay-to-win entries', () => {
    for (const entry of LOOT_TABLE) {
      expect(['vent-charge', 'cosmetic', 'clear-ballast']).toContain(entry.kind);
    }
  });
});
