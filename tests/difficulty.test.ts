import { describe, expect, it } from 'vitest';
import {
  assistProbability,
  clearsPerMinute,
  createSkillTracker,
  rawSkill,
  recordClears,
  updateSkill,
} from '../src/difficulty.js';
import { defaultLevers, type Levers } from '../src/levers.js';
import { surgeBallastCount, ventAmount, pressureGain } from '../src/pressure.js';

const levers = defaultLevers;

describe('skill measurement (lever 2: flow on skill, not time)', () => {
  it('a player who clears nothing stays at skill 0 no matter how long they play', () => {
    const t0 = 1_000_000;
    const tracker = createSkillTracker(t0);
    let skill = 0;
    for (let i = 1; i <= 50; i++) {
      skill = updateSkill(tracker, levers, t0 + i * 10_000);
    }
    expect(skill).toBe(0);
  });

  it('clears/min rises with clears inside the window', () => {
    const t0 = 2_000_000;
    const tracker = createSkillTracker(t0);
    const now = t0 + levers.skillWindowSeconds * 1000;
    recordClears(tracker, 9, now - 1000);
    // 9 clears over a 90s window = 6/min
    expect(clearsPerMinute(tracker, levers, now)).toBeCloseTo(6, 1);
  });

  it('ignores clears that have fallen out of the window', () => {
    const t0 = 3_000_000;
    const tracker = createSkillTracker(t0);
    recordClears(tracker, 20, t0);
    const later = t0 + (levers.skillWindowSeconds + 60) * 1000;
    expect(clearsPerMinute(tracker, levers, later)).toBe(0);
  });

  it('maps the floor to 0 and the ceiling to 1, and clamps outside', () => {
    expect(rawSkill(levers.skillFloorClearsPerMin, levers)).toBe(0);
    expect(rawSkill(levers.skillCeilClearsPerMin, levers)).toBe(1);
    expect(rawSkill(0, levers)).toBe(0);
    expect(rawSkill(999, levers)).toBe(1);
  });

  it('smooths rather than lurching: one update cannot jump straight to the target', () => {
    const t0 = 4_000_000;
    const tracker = createSkillTracker(t0);
    const now = t0 + levers.skillWindowSeconds * 1000;
    recordClears(tracker, 40, now - 500);
    const after = updateSkill(tracker, levers, now);
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(1);
    expect(after).toBeCloseTo(levers.skillSmoothing, 5);
  });

  it('converges upward over repeated updates for a strong player', () => {
    const t0 = 5_000_000;
    const tracker = createSkillTracker(t0);
    let now = t0;
    for (let i = 0; i < 40; i++) {
      now += 5_000;
      recordClears(tracker, 1, now);
      updateSkill(tracker, levers, now);
    }
    expect(tracker.skill).toBeGreaterThan(0.3);
  });
});

describe('difficulty ramp outputs', () => {
  it('assist decays monotonically with placements', () => {
    let previous = assistProbability(levers, 0, 0);
    for (let placements = 5; placements <= 200; placements += 5) {
      const next = assistProbability(levers, placements, 0);
      expect(next).toBeLessThanOrEqual(previous + 1e-9);
      previous = next;
    }
  });

  it('assist decays with skill at a fixed point in the game', () => {
    const low = assistProbability(levers, 10, 0);
    const high = assistProbability(levers, 10, 1);
    expect(high).toBeLessThan(low);
    expect(high).toBeGreaterThanOrEqual(levers.assistProbabilityFloor);
  });

  it('ramps the surge size from min at skill 0 to max at skill 1', () => {
    expect(surgeBallastCount(levers, 0)).toBe(levers.surgeBallastMin);
    expect(surgeBallastCount(levers, 1)).toBe(levers.surgeBallastMax);
    const mid = surgeBallastCount(levers, 0.5);
    expect(mid).toBeGreaterThanOrEqual(levers.surgeBallastMin);
    expect(mid).toBeLessThanOrEqual(levers.surgeBallastMax);
  });

  it('ramp is bounded even with an out-of-range skill value', () => {
    expect(surgeBallastCount(levers, -3)).toBe(levers.surgeBallastMin);
    expect(surgeBallastCount(levers, 9)).toBe(levers.surgeBallastMax);
  });

  it('a wider skill band spreads the ramp rather than shifting it', () => {
    const wide: Levers = { ...levers, surgeBallastMin: 1, surgeBallastMax: 9 };
    expect(surgeBallastCount(wide, 0)).toBe(1);
    expect(surgeBallastCount(wide, 1)).toBe(9);
    expect(surgeBallastCount(wide, 0.5)).toBe(5);
  });
});

describe('pressure maths (the twist)', () => {
  it('a fuller board raises pressure faster', () => {
    expect(pressureGain(levers, 0.9)).toBeGreaterThan(pressureGain(levers, 0.1));
  });

  it('venting scales with lines and pays extra for ballast', () => {
    expect(ventAmount(levers, 1, 0)).toBe(levers.ventPerLine);
    expect(ventAmount(levers, 2, 0)).toBe(levers.ventPerLine * 2);
    expect(ventAmount(levers, 1, 3)).toBe(levers.ventPerLine + 3 * levers.ventPerBallast);
  });

  it('a single clear more than pays for the placement that made it', () => {
    expect(ventAmount(levers, 1, 0)).toBeGreaterThan(pressureGain(levers, 1));
  });
});
