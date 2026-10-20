import { describe, expect, it } from 'vitest';
import { defaultLevers } from '../src/levers.js';
import {
  MemoryEventStore,
  Telemetry,
  computeMetrics,
  type GameEvent,
} from '../src/telemetry.js';

function makeTelemetry(start = 1_700_000_000_000): { telemetry: Telemetry; tick: (ms: number) => void } {
  let t = start;
  const telemetry = new Telemetry({
    store: new MemoryEventStore(),
    installId: 'install-test',
    enabled: true,
    maxEvents: 100,
    now: () => t,
    batchSize: 1,
  });
  return { telemetry, tick: (ms) => (t += ms) };
}

const HOUR = 3600000;
const DAY = 24 * HOUR;

function event(type: GameEvent['type'], t: number, sessionId: string, payload: Record<string, unknown> = {}): GameEvent {
  return { type, t, sessionId, installId: 'i', payload };
}

describe('event queue', () => {
  it('logs and reads back events', async () => {
    const { telemetry, tick } = makeTelemetry();
    telemetry.log('session_start');
    tick(1000);
    telemetry.log('game_start');
    const events = await telemetry.allEvents();
    expect(events.map((e) => e.type)).toEqual(['session_start', 'game_start']);
  });

  it('records nothing when telemetry is disabled', async () => {
    const telemetry = new Telemetry({
      store: new MemoryEventStore(),
      installId: 'i',
      enabled: false,
      maxEvents: 10,
    });
    telemetry.log('game_start');
    expect(await telemetry.allEvents()).toHaveLength(0);
  });

  it('trims to the configured maximum', async () => {
    const store = new MemoryEventStore();
    const telemetry = new Telemetry({ store, installId: 'i', enabled: true, maxEvents: 5, batchSize: 1 });
    for (let i = 0; i < 20; i++) telemetry.log('clear', { lines: 1 });
    const events = await telemetry.allEvents();
    expect(events).toHaveLength(5);
  });

  it('exports JSON that states the privacy posture and carries no PII fields', async () => {
    const { telemetry } = makeTelemetry();
    telemetry.log('game_start');
    const parsed = JSON.parse(await telemetry.exportJson()) as Record<string, unknown>;
    expect(parsed.app).toBe('overflow-grid');
    expect(String(parsed.note)).toContain('No personal data');
    const serialised = JSON.stringify(parsed).toLowerCase();
    for (const banned of ['email', 'ipaddress', 'advertisingid', 'idfa', 'latitude']) {
      expect(serialised).not.toContain(banned);
    }
  });

  it('resets cleanly', async () => {
    const { telemetry } = makeTelemetry();
    telemetry.log('game_start');
    await telemetry.reset();
    expect(await telemetry.allEvents()).toHaveLength(0);
  });
});

describe('metrics', () => {
  it('returns zeroed, non-NaN metrics for an empty log', () => {
    const m = computeMetrics([], 12, 25);
    expect(m.sessions).toBe(0);
    expect(m.gamesPerSession).toBe(0);
    expect(m.rewardedOptInRate).toBe(0);
    expect(m.projectedRevenueLowUsd).toBe(0);
    expect(Number.isNaN(m.avgSessionSeconds)).toBe(false);
  });

  it('computes games per session and session length', () => {
    const t = Date.parse('2026-04-01T10:00:00Z');
    const events: GameEvent[] = [
      event('session_start', t, 's1'),
      event('game_start', t + 1000, 's1'),
      event('game_over', t + 60000, 's1'),
      event('game_start', t + 61000, 's1'),
      event('session_end', t + 180000, 's1'),
      event('session_start', t + DAY, 's2'),
      event('game_start', t + DAY + 500, 's2'),
      event('session_end', t + DAY + 90000, 's2'),
    ];
    const m = computeMetrics(events, 12, 25);
    expect(m.sessions).toBe(2);
    expect(m.games).toBe(3);
    expect(m.gamesPerSession).toBeCloseTo(1.5, 5);
    expect(m.days).toBe(2);
    expect(m.sessionsPerDay).toBe(1);
    expect(m.avgSessionSeconds).toBeCloseTo((180 + 90) / 2, 1);
  });

  it('counts a D1 return when the next session lands inside 16-48h', () => {
    const t = Date.parse('2026-04-01T09:00:00Z');
    const events: GameEvent[] = [
      event('session_start', t, 's1'),
      event('session_end', t + 60000, 's1'),
      event('session_start', t + 25 * HOUR, 's2'),
      event('session_end', t + 25 * HOUR + 60000, 's2'),
    ];
    expect(computeMetrics(events, 12, 25).d1ReturnProxy).toBe(1);
  });

  it('does not count a return that is too soon or too late', () => {
    const t = Date.parse('2026-04-01T09:00:00Z');
    const tooSoon: GameEvent[] = [
      event('session_start', t, 's1'),
      event('session_start', t + 2 * HOUR, 's2'),
      event('session_start', t + 20 * DAY, 's3'),
    ];
    // day 1 -> only a 2h gap, day 2 -> nothing within 48h
    expect(computeMetrics(tooSoon, 12, 25).d1ReturnProxy).toBe(0);
  });

  it('computes the rewarded opt-in rate from offers and accepts', () => {
    const t = Date.parse('2026-04-02T09:00:00Z');
    const events: GameEvent[] = [
      event('session_start', t, 's1'),
      event('continue_offered', t + 1, 's1'),
      event('continue_accepted', t + 2, 's1'),
      event('chest_offered', t + 3, 's1'),
      event('chest_offered', t + 4, 's1'),
    ];
    const m = computeMetrics(events, 12, 25);
    expect(m.rewardedOffers).toBe(3);
    expect(m.rewardedAccepts).toBe(1);
    expect(m.rewardedOptInRate).toBeCloseTo(1 / 3, 5);
  });

  it('projects revenue linearly from impressions at each eCPM', () => {
    const t = Date.parse('2026-04-03T09:00:00Z');
    const events: GameEvent[] = [event('session_start', t, 's1')];
    for (let i = 0; i < 500; i++) events.push(event('ad_impression', t + i, 's1'));
    const m = computeMetrics(events, 12, 25);
    expect(m.adImpressions).toBe(500);
    expect(m.adsPerSession).toBe(500);
    expect(m.projectedRevenueLowUsd).toBeCloseTo(6, 6); // 0.5 * 12
    expect(m.projectedRevenueHighUsd).toBeCloseTo(12.5, 6); // 0.5 * 25
  });

  it('uses the configured eCPM levers', () => {
    const t = Date.parse('2026-04-04T09:00:00Z');
    const events: GameEvent[] = [
      event('session_start', t, 's1'),
      ...Array.from({ length: 1000 }, (_, i) => event('ad_impression', t + i, 's1')),
    ];
    const m = computeMetrics(events, defaultLevers.ecpmLowUsd, defaultLevers.ecpmHighUsd);
    expect(m.projectedRevenueLowUsd).toBeCloseTo(defaultLevers.ecpmLowUsd, 6);
    expect(m.projectedRevenueHighUsd).toBeCloseTo(defaultLevers.ecpmHighUsd, 6);
  });

  it('sums clears and tracks the best combo and surges', () => {
    const t = Date.parse('2026-04-05T09:00:00Z');
    const events: GameEvent[] = [
      event('session_start', t, 's1'),
      event('clear', t + 1, 's1', { lines: 2 }),
      event('clear', t + 2, 's1', { lines: 1 }),
      event('combo', t + 3, 's1', { combo: 4 }),
      event('combo', t + 4, 's1', { combo: 2 }),
      event('surge', t + 5, 's1'),
    ];
    const m = computeMetrics(events, 12, 25);
    expect(m.clears).toBe(3);
    expect(m.bestCombo).toBe(4);
    expect(m.surges).toBe(1);
  });
});
