/**
 * telemetry.ts — anonymous, local-only gameplay events.
 *
 * PRIVACY POSTURE (assume players may be under 13):
 *   - no account, no login, no email, no device ids, no IP logging, no ad ids
 *   - no cross-site identifiers and no behavioural ad targeting
 *   - the only identifier is a random per-install id used to group sessions
 *     locally; it never leaves the device unless the player taps Export
 *   - nothing is transmitted anywhere. The queue is an IndexedDB table on the
 *     player's own machine, and /debug offers a manual JSON export.
 * This is what makes a consent wall unnecessary rather than merely skipped.
 */

export type EventType =
  | 'session_start'
  | 'session_end'
  | 'game_start'
  | 'game_over'
  | 'clear'
  | 'combo'
  | 'surge'
  | 'continue_offered'
  | 'continue_accepted'
  | 'chest_offered'
  | 'chest_accepted'
  | 'ad_opportunity'
  | 'ad_impression'
  | 'ad_skip'
  | 'ad_reward'
  | 'ad_no_fill'
  | 'streak_day'
  | 'mute_toggle';

export interface GameEvent {
  /** epoch ms */
  t: number;
  type: EventType;
  /** random per-install id, local only */
  installId: string;
  /** random per-session id, local only */
  sessionId: string;
  payload: Record<string, unknown>;
}

export interface EventStore {
  append(events: GameEvent[]): Promise<void>;
  readAll(): Promise<GameEvent[]>;
  clear(): Promise<void>;
  /** keep only the newest `max` events */
  trim(max: number): Promise<void>;
}

/** In-memory store. Used by tests and as the fallback when IndexedDB is absent. */
export class MemoryEventStore implements EventStore {
  private events: GameEvent[] = [];
  async append(events: GameEvent[]): Promise<void> {
    this.events.push(...events);
  }
  async readAll(): Promise<GameEvent[]> {
    return this.events.slice();
  }
  async clear(): Promise<void> {
    this.events = [];
  }
  async trim(max: number): Promise<void> {
    if (this.events.length > max) this.events = this.events.slice(-max);
  }
}

const DB_NAME = 'overflow-grid';
const DB_VERSION = 1;
const STORE = 'events';

export class IndexedDbEventStore implements EventStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'k', autoIncrement: true });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbPromise;
  }

  async append(events: GameEvent[]): Promise<void> {
    if (events.length === 0) return;
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const event of events) store.add(event);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async readAll(): Promise<GameEvent[]> {
    const db = await this.open();
    return new Promise<GameEvent[]>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as GameEvent[]);
      req.onerror = () => reject(req.error);
    });
  }

  async clear(): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async trim(max: number): Promise<void> {
    const db = await this.open();
    const all = await this.readAll();
    if (all.length <= max) return;
    const keep = all.slice(-max);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.clear();
      for (const event of keep) store.add(event);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

export function pickEventStore(): EventStore {
  try {
    if (typeof indexedDB !== 'undefined') return new IndexedDbEventStore();
  } catch {
    /* blocked (private mode, embedded webview): fall through */
  }
  return new MemoryEventStore();
}

function randomId(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const INSTALL_KEY = 'og.installId';

export function getInstallId(storage: Storage | null): string {
  try {
    const existing = storage?.getItem(INSTALL_KEY);
    if (existing) return existing;
    const fresh = randomId();
    storage?.setItem(INSTALL_KEY, fresh);
    return fresh;
  } catch {
    return randomId();
  }
}

export interface TelemetryOptions {
  store: EventStore;
  installId: string;
  enabled: boolean;
  maxEvents: number;
  now?: () => number;
  /** flush buffered events after this many, or on flush() */
  batchSize?: number;
}

export class Telemetry {
  readonly installId: string;
  readonly sessionId: string;
  private readonly store: EventStore;
  private readonly enabled: boolean;
  private readonly maxEvents: number;
  private readonly now: () => number;
  private readonly batchSize: number;
  private buffer: GameEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TelemetryOptions) {
    this.store = options.store;
    this.installId = options.installId;
    this.enabled = options.enabled;
    this.maxEvents = options.maxEvents;
    this.now = options.now ?? (() => Date.now());
    this.batchSize = options.batchSize ?? 12;
    this.sessionId = randomId();
  }

  log(type: EventType, payload: Record<string, unknown> = {}): void {
    if (!this.enabled) return;
    this.buffer.push({
      t: this.now(),
      type,
      installId: this.installId,
      sessionId: this.sessionId,
      payload,
    });
    if (this.buffer.length >= this.batchSize) {
      void this.flush();
      return;
    }
    // Also flush shortly after the last event. Without this a session's tail
    // (the surge or game_over that ended it) is lost when the tab goes away
    // before pagehide can run an async IndexedDB write.
    if (this.flushTimer === null && typeof setTimeout === 'function') {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, 400);
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.store.append(batch);
      await this.store.trim(this.maxEvents);
    } catch {
      /* storage full or blocked: drop silently rather than break play */
    }
  }

  async allEvents(): Promise<GameEvent[]> {
    await this.flush();
    return this.store.readAll();
  }

  async exportJson(): Promise<string> {
    const events = await this.allEvents();
    return JSON.stringify(
      {
        app: 'overflow-grid',
        schema: 1,
        exportedAt: new Date(this.now()).toISOString(),
        note: 'Anonymous local gameplay events. No personal data, no ad identifiers.',
        installId: this.installId,
        eventCount: events.length,
        events,
      },
      null,
      2,
    );
  }

  async reset(): Promise<void> {
    this.buffer = [];
    await this.store.clear();
  }
}

// ───────────────────────────── metrics ─────────────────────────────

export interface Metrics {
  totalEvents: number;
  sessions: number;
  days: number;
  sessionsPerDay: number;
  avgSessionSeconds: number;
  games: number;
  gamesPerSession: number;
  /** D1 proxy: share of install-days that were followed by a return 16-48h later */
  d1ReturnProxy: number;
  rewardedOffers: number;
  rewardedAccepts: number;
  rewardedOptInRate: number;
  adImpressions: number;
  adsPerSession: number;
  clears: number;
  bestCombo: number;
  surges: number;
  projectedRevenueLowUsd: number;
  projectedRevenueHighUsd: number;
}

const DAY_MS = 86400000;

function dayKey(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Pure metric computation over an event list. Kept pure so /debug and the tests
 * read the same numbers.
 *
 * `d1ReturnProxy` is explicitly a PROXY, not true D1 retention: with local-only
 * data we can only observe this install. It measures, over all active days, the
 * share that had a following session 16-48h later.
 */
export function computeMetrics(
  events: readonly GameEvent[],
  ecpmLowUsd: number,
  ecpmHighUsd: number,
): Metrics {
  const sessionIds = new Set<string>();
  const sessionStart = new Map<string, number>();
  const sessionEnd = new Map<string, number>();
  const sessionGames = new Map<string, number>();
  const sessionImpressions = new Map<string, number>();
  const activeDays = new Set<string>();
  const sessionTimes: number[] = [];

  let games = 0;
  let clears = 0;
  let surges = 0;
  let bestCombo = 0;
  let rewardedOffers = 0;
  let rewardedAccepts = 0;
  let adImpressions = 0;

  for (const e of events) {
    sessionIds.add(e.sessionId);
    activeDays.add(dayKey(e.t));
    if (!sessionStart.has(e.sessionId) || e.t < sessionStart.get(e.sessionId)!) {
      sessionStart.set(e.sessionId, e.t);
    }
    if (!sessionEnd.has(e.sessionId) || e.t > sessionEnd.get(e.sessionId)!) {
      sessionEnd.set(e.sessionId, e.t);
    }

    switch (e.type) {
      case 'session_start':
        sessionTimes.push(e.t);
        break;
      case 'game_start':
        games++;
        sessionGames.set(e.sessionId, (sessionGames.get(e.sessionId) ?? 0) + 1);
        break;
      case 'clear':
        clears += Number(e.payload.lines ?? 1);
        break;
      case 'surge':
        surges++;
        break;
      case 'combo':
        bestCombo = Math.max(bestCombo, Number(e.payload.combo ?? 0));
        break;
      case 'continue_offered':
      case 'chest_offered':
        rewardedOffers++;
        break;
      case 'continue_accepted':
      case 'chest_accepted':
        rewardedAccepts++;
        break;
      case 'ad_impression':
        adImpressions++;
        sessionImpressions.set(e.sessionId, (sessionImpressions.get(e.sessionId) ?? 0) + 1);
        break;
      default:
        break;
    }
  }

  const sessions = sessionIds.size;
  const days = Math.max(1, activeDays.size);

  let totalSessionMs = 0;
  for (const id of sessionIds) {
    totalSessionMs += Math.max(0, (sessionEnd.get(id) ?? 0) - (sessionStart.get(id) ?? 0));
  }

  // D1 proxy: for each active day, did a session start 16-48h after that day's
  // last activity? Averaged over all active days except the most recent.
  const sortedStarts = sessionTimes.length > 0 ? sessionTimes.slice().sort((a, b) => a - b) : [];
  const dayLast = new Map<string, number>();
  for (const e of events) {
    const k = dayKey(e.t);
    if (!dayLast.has(k) || e.t > dayLast.get(k)!) dayLast.set(k, e.t);
  }
  const dayKeys = [...dayLast.keys()].sort();
  const judgeable = dayKeys.slice(0, Math.max(0, dayKeys.length - 1));
  let returned = 0;
  for (const k of judgeable) {
    const last = dayLast.get(k)!;
    const hit = sortedStarts.some((t) => t - last >= 16 * 3600000 && t - last <= 2 * DAY_MS);
    if (hit) returned++;
  }

  const impressionsPerThousand = adImpressions / 1000;

  return {
    totalEvents: events.length,
    sessions,
    days,
    sessionsPerDay: sessions / days,
    avgSessionSeconds: sessions > 0 ? totalSessionMs / sessions / 1000 : 0,
    games,
    gamesPerSession: sessions > 0 ? games / sessions : 0,
    d1ReturnProxy: judgeable.length > 0 ? returned / judgeable.length : 0,
    rewardedOffers,
    rewardedAccepts,
    rewardedOptInRate: rewardedOffers > 0 ? rewardedAccepts / rewardedOffers : 0,
    adImpressions,
    adsPerSession: sessions > 0 ? adImpressions / sessions : 0,
    clears,
    bestCombo,
    surges,
    projectedRevenueLowUsd: impressionsPerThousand * ecpmLowUsd,
    projectedRevenueHighUsd: impressionsPerThousand * ecpmHighUsd,
  };
}
