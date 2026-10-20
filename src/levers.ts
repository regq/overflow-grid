/**
 * levers.ts — every behavioural + economic knob in Overflow Grid, in one place.
 *
 * RULE: no game module may hard-code a number that belongs here. Tests assert the
 * shape of this object, and TUNING.md documents how to change each value without
 * touching game code (query string, localStorage, or editing the defaults below).
 *
 * Each lever carries a one-line "why it works" comment and a default value.
 * Ethical guardrails live in `guardrails` at the bottom and are NOT meant to be
 * loosened; they are expressed as levers so that any loosening is visible in a diff.
 */

export interface Levers {
  // ───────────────────────── 1. Variable-ratio reward ─────────────────────────
  /** why: a guaranteed early win teaches the core loop before any uncertainty is introduced. */
  assistGuaranteedClearsAtStart: number;
  /** why: variable-ratio (not fixed-ratio) reward is the most persistence-resistant schedule known; this is the probability a generated piece is *steered* toward a clear. */
  assistProbabilityFloor: number;
  /** why: the ceiling the assist decays FROM — high early so the loop feels generous, then genuinely probabilistic. */
  assistProbabilityCeiling: number;
  /** why: how many placements the assist takes to decay from ceiling to floor; slow decay hides the transition. */
  assistDecayPlacements: number;
  /** why: near-misses activate the same reward circuitry as wins; deliberately offering a piece that *almost* clears drives "one more go". */
  nearMissProbability: number;
  /** why: a near-miss only reads as a near-miss if the player can see it — highlight rows that are 1 cell short. */
  nearMissHighlightThreshold: number;
  /** why: candidate pool per draw; larger pool = finer control over bias, more CPU. */
  generatorCandidatePool: number;

  // ───────────────────────── 2. Flow curve (skill-based) ──────────────────────
  /** why: flow requires difficulty to track *ability*, not elapsed time; this is the window of the clears/min moving average. */
  skillWindowSeconds: number;
  /** why: clears/min that maps to skill 0.0 — below this the game eases off instead of punishing. */
  skillFloorClearsPerMin: number;
  /** why: clears/min that maps to skill 1.0 — above this the game stops getting harder (no despair spiral). */
  skillCeilClearsPerMin: number;
  /** why: exponential smoothing on skill so difficulty never lurches mid-combo. */
  skillSmoothing: number;

  // ───────────────────────── The twist: pressure & vent ───────────────────────
  /** why: the pressure meter is the game's clock — a second resource to manage so "safe" play still has a cost. */
  pressureCapacity: number;
  /** why: baseline pressure per placement; the metronome of the twist. */
  pressurePerPlacement: number;
  /** why: pressure scales with board occupancy, so hoarding space is punished and clearing is the only real escape valve. */
  pressureFillCoefficient: number;
  /** why: venting on a clear makes the clear feel like *relief*, not just points — relief is a stronger reinforcer than reward. */
  ventPerLine: number;
  /** why: clearing a line containing ballast vents extra — teaches the player to attack the obstruction rather than avoid it. */
  ventPerBallast: number;
  /** why: a surge that empties the meter completely removes all tension; leaving residue keeps the next cycle short. */
  pressureResetTo: number;
  /** why: ballast tiles injected per surge at skill 0 — the visible consequence of ignoring pressure. */
  surgeBallastMin: number;
  /** why: ballast per surge at skill 1 — this is the main difficulty dial driven by the flow curve. */
  surgeBallastMax: number;
  /** why: surges fill from the bottom so the threat is legible and spatially predictable (fair, not random cruelty). */
  surgeFillsFromBottom: boolean;

  // ───────────────────────── Combo meter → next pieces ───────────────────────
  /** why: combos must be *reachable* to be motivating; at this length the generator starts feeding the combo. */
  comboFeedThreshold: number;
  /** why: how strongly a live combo biases the next draw — escalation the player can feel earning. */
  comboFeedStrength: number;
  /** why: combos decay rather than snap, so one bad placement does not erase the investment. */
  comboDecayPlacements: number;
  /** why: score multiplier per combo step — escalation is where the dopamine is. */
  comboScoreStep: number;

  // ───────────────────────── 3. Zeigarnik / unfinished board ─────────────────
  /** why: an interrupted task occupies memory until finished (Zeigarnik); saving mid-board makes returning feel like resuming, not restarting. */
  resumeEnabled: boolean;
  /** why: how long a saved board stays resumable; past this it is stale and a fresh start is kinder. */
  resumeMaxAgeHours: number;
  /** why: on return, naming the *specific* unfinished thing ("1 clear from a 5-combo") is far stickier than a generic "welcome back". */
  resumeShowUnfinishedCombo: boolean;

  // ───────────────────────── 4. Loss aversion (continue) ─────────────────────
  /** why: losing a run you have invested in hurts more than an equivalent gain pleases; one opt-in rescue converts that sting into a watched ad. */
  continueOfferEnabled: boolean;
  /** why: exactly one per game — a second offer turns a rescue into a toll booth. */
  continueMaxPerGame: number;
  /** why: clearing pieces (not score) is the reward, so the offer buys *play*, never a purchase of points. */
  continueClearsRandomPieces: number;
  /** why: below this score the run is not worth rescuing and the offer would read as nagging. */
  continueMinScoreToOffer: number;
  /** why: a continue should also relieve pressure, else the rescued board dies immediately and the ad feels stolen. */
  continuePressureRelief: number;

  // ───────────────────────── 5. Streaks + endowed progress ───────────────────
  /** why: streaks create a loss-averse reason to return daily that is independent of how fun yesterday was. */
  streakEnabled: boolean;
  /** why: a missed day forgiven once keeps a broken streak from ending the relationship. */
  streakGraceDays: number;
  /** why: endowed progress — a goal that starts partly done is completed far more often than one that starts at zero. */
  weeklyGoalEndowedFraction: number;
  /** why: the weekly target in line clears; sized so a committed player finishes in 4-5 sessions, not 1. */
  weeklyGoalClears: number;

  // ───────────────────────── 6. Variable-reward chests ───────────────────────
  /** why: a chest with a *visible, honest* loot table keeps the variable reward while removing the deception. */
  chestEnabled: boolean;
  /** why: chests offered per session; scarcity preserves the reward's value without manufactured urgency. */
  chestMaxPerSession: number;
  /** why: games between chest offers, so the chest never interrupts a hot streak. */
  chestCooldownGames: number;

  // ───────────────────────── 7. Social proof / self-competition ──────────────
  /** why: "beat your best" outperforms global leaderboards for casual retention and needs no account, no data collection. */
  localLeaderboardSize: number;
  /** why: showing the player's own best as a live target turns every run into a near-miss opportunity. */
  showPersonalBestTarget: boolean;

  // ───────────────────────── Ads ─────────────────────────────────────────────
  /** why: interstitials are the floor of ad revenue but the ceiling of churn; cap them hard. */
  interstitialEnabled: boolean;
  /** why: minimum seconds between non-rewarded interstitials. HARD FLOOR 180s — see guardrails. */
  interstitialMinIntervalSeconds: number;
  /** why: first-session players have not decided to stay yet; no interstitials until they have played this many games. */
  interstitialMinGamesBeforeFirst: number;
  /** why: an interstitial after a game-over interrupts the *end* of a task, not the middle — the least costly moment. */
  interstitialAfterGameOverOnly: boolean;
  /** why: rewarded video is the only format players opt into, so it earns more per impression and costs no goodwill. */
  rewardedEnabled: boolean;
  /** why: simulated fill rate for the mock SDK, so the "no ad available" path is exercised in development. */
  mockAdFillRate: number;
  /** why: simulated ad duration; the continue/chest flow must stay responsive when this is slow. */
  mockAdDurationMs: number;

  // ───────────────────────── Juice ───────────────────────────────────────────
  /** why: clear animation length — long enough to feel weighty, short enough not to block the next placement. */
  clearAnimationMs: number;
  /** why: a block that springs past its size and settles reads as physical; a block that just appears reads as a sprite. */
  placePopMs: number;
  /** why: how far past full size a placed block overshoots. Past ~0.35 it stops looking like weight and starts looking like a bug. */
  placePopOvershoot: number;
  /** why: tray pieces staggering in gives the refill a rhythm instead of a blink. */
  trayPopMs: number;
  /** why: bubbles are the whole visual metaphor — pressure you can see rising. This is the ambient drift behind the grid. */
  ambientBubblesPerSecond: number;
  /** why: bubbles released by the meter scale with pressure, so the board gets visibly agitated before a surge. */
  meterBubblesPerSecondAtFull: number;
  /** why: a clear should burst, not fade. Bubbles spawned per cleared cell. */
  burstBubblesPerCell: number;
  /** why: hard cap on live particles. The single most important number for holding 60 fps on a mid phone. */
  maxParticles: number;
  /** why: expanding shock ring on a clear — cheap, reads instantly, scales with how big the clear was. */
  shockRingMs: number;
  /** why: the whole board nudging on a surge sells the impact without moving any game state. */
  screenShakePx: number;
  /** why: a score that counts up is read; a score that snaps is missed. */
  scoreTweenMs: number;
  /** why: haptics on clear convert a visual event into a physical one; the single biggest cheap win on mobile. */
  hapticsEnabled: boolean;
  /** why: sound defaults ON for juice but is one tap from OFF and the choice is remembered. */
  soundDefaultOn: boolean;

  // ───────────────────────── Telemetry ──────────────────────────────────────
  /** why: anonymous-only, local-only by default; no account, no ad targeting, COPPA/GDPR-safe without a consent wall. */
  telemetryEnabled: boolean;
  /** why: cap the local event queue so a long-lived install cannot fill the user's disk. */
  telemetryMaxEvents: number;
  /** why: eCPM assumptions for the projected-revenue readout in /debug; these are estimates, not promises. */
  ecpmLowUsd: number;
  ecpmHighUsd: number;
}

/**
 * Non-negotiable ethical limits. These are enforced in code (see ads.ts) and
 * asserted in tests. They are listed here so that weakening one shows up in review.
 */
export const guardrails = {
  /** No forced non-rewarded ad may ever appear more often than this. */
  interstitialAbsoluteMinIntervalSeconds: 180,
  /** No rewarded offer may be shown more than once per game-over. */
  continueAbsoluteMaxPerGame: 1,
  /** No countdown timers, no fake scarcity, no fake close buttons. Asserted by review, documented here. */
  noCountdownPressure: true,
  noFakeScarcity: true,
  noFakeCloseButtons: true,
  /** Assume players may be under 13: no behavioural targeting, no PII, no cross-site identifiers. */
  behaviouralAdTargeting: false,
  collectsPersonalData: false,
  /** Ads must be non-personalised and child-directed-safe by default. */
  requestNonPersonalisedAds: true,
} as const;

export const defaultLevers: Levers = {
  // 1. variable-ratio reward
  assistGuaranteedClearsAtStart: 3,
  assistProbabilityFloor: 0.18,
  assistProbabilityCeiling: 0.92,
  assistDecayPlacements: 45,
  nearMissProbability: 0.22,
  nearMissHighlightThreshold: 1,
  generatorCandidatePool: 12,

  // 2. flow curve
  skillWindowSeconds: 90,
  skillFloorClearsPerMin: 1.5,
  skillCeilClearsPerMin: 9,
  skillSmoothing: 0.25,

  // twist
  pressureCapacity: 100,
  pressurePerPlacement: 7,
  pressureFillCoefficient: 10,
  ventPerLine: 22,
  ventPerBallast: 6,
  pressureResetTo: 35,
  surgeBallastMin: 2,
  surgeBallastMax: 5,
  surgeFillsFromBottom: true,

  // combo
  comboFeedThreshold: 3,
  comboFeedStrength: 0.55,
  comboDecayPlacements: 2,
  comboScoreStep: 0.5,

  // 3. zeigarnik
  resumeEnabled: true,
  resumeMaxAgeHours: 72,
  resumeShowUnfinishedCombo: true,

  // 4. loss aversion
  continueOfferEnabled: true,
  continueMaxPerGame: 1,
  continueClearsRandomPieces: 3,
  continueMinScoreToOffer: 300,
  continuePressureRelief: 40,

  // 5. streaks
  streakEnabled: true,
  streakGraceDays: 1,
  weeklyGoalEndowedFraction: 0.2,
  weeklyGoalClears: 120,

  // 6. chests
  chestEnabled: true,
  chestMaxPerSession: 2,
  chestCooldownGames: 2,

  // 7. social proof
  localLeaderboardSize: 5,
  showPersonalBestTarget: true,

  // ads
  interstitialEnabled: true,
  interstitialMinIntervalSeconds: 210,
  interstitialMinGamesBeforeFirst: 3,
  interstitialAfterGameOverOnly: true,
  rewardedEnabled: true,
  mockAdFillRate: 0.9,
  mockAdDurationMs: 1200,

  // juice
  clearAnimationMs: 260,
  placePopMs: 190,
  placePopOvershoot: 0.22,
  trayPopMs: 260,
  ambientBubblesPerSecond: 2.4,
  meterBubblesPerSecondAtFull: 14,
  burstBubblesPerCell: 2.2,
  maxParticles: 220,
  shockRingMs: 420,
  screenShakePx: 5,
  scoreTweenMs: 420,
  hapticsEnabled: true,
  soundDefaultOn: true,

  // telemetry
  telemetryEnabled: true,
  telemetryMaxEvents: 5000,
  ecpmLowUsd: 12,
  ecpmHighUsd: 25,
};

const STORAGE_KEY = 'og.levers.overrides';

function coerce(base: unknown, raw: string): unknown {
  if (typeof base === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : base;
  }
  if (typeof base === 'boolean') return raw === '1' || raw === 'true';
  return raw;
}

/**
 * Resolve the live lever set: defaults <- localStorage overrides <- ?lever=value query.
 * Guardrails are re-applied last so no override can breach them.
 */
export function loadLevers(search = '', storage?: Storage | null): Levers {
  const out: Record<string, unknown> = { ...defaultLevers };

  try {
    const stored = storage?.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) {
        if (k in out) out[k] = v;
      }
    }
  } catch {
    /* corrupt override blob: ignore and use defaults */
  }

  try {
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    for (const [k, v] of params) {
      if (k in out) out[k] = coerce(out[k], v);
    }
  } catch {
    /* malformed query string: ignore */
  }

  return clampToGuardrails(out as unknown as Levers);
}

/** Force the ethical floors regardless of what any override asked for. */
export function clampToGuardrails(l: Levers): Levers {
  const out = { ...l };
  out.interstitialMinIntervalSeconds = Math.max(
    guardrails.interstitialAbsoluteMinIntervalSeconds,
    out.interstitialMinIntervalSeconds,
  );
  out.continueMaxPerGame = Math.min(guardrails.continueAbsoluteMaxPerGame, out.continueMaxPerGame);
  out.assistProbabilityFloor = Math.min(Math.max(out.assistProbabilityFloor, 0), 1);
  out.assistProbabilityCeiling = Math.min(Math.max(out.assistProbabilityCeiling, out.assistProbabilityFloor), 1);
  out.weeklyGoalEndowedFraction = Math.min(Math.max(out.weeklyGoalEndowedFraction, 0), 0.9);
  out.mockAdFillRate = Math.min(Math.max(out.mockAdFillRate, 0), 1);
  return out;
}

/** Persist an override set so a tuner can reload without rebuilding. Used by /debug. */
export function saveLeverOverrides(overrides: Partial<Levers>, storage: Storage): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(overrides));
}

export function clearLeverOverrides(storage: Storage): void {
  storage.removeItem(STORAGE_KEY);
}
