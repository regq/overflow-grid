/**
 * ads.ts — mock ad SDK shaped like the real thing, plus the frequency-cap layer.
 *
 * The `AdNetwork` interface deliberately mirrors the surface shared by Google
 * AdMob (H5 / Capacitor plugin) and AdSense for Games: preload + show, with
 * rewarded ads reporting through onReward / onSkip callbacks rather than a
 * plain resolve. Swapping the mock for a real network means implementing this
 * one interface -- see SWAP TODO at the bottom of this file.
 *
 * Every impression OPPORTUNITY is logged, not just every impression, so that
 * fill rate and cap losses are visible in /debug rather than invisible.
 */

import { guardrails, type Levers } from './levers.js';
import type { Telemetry } from './telemetry.js';

export type AdPlacement = 'interstitial_gameover' | 'rewarded_continue' | 'rewarded_chest';

export type AdOutcome = 'shown' | 'skipped' | 'rewarded' | 'no_fill' | 'error' | 'capped';

export interface AdResult {
  outcome: AdOutcome;
  placement: AdPlacement;
  /** ms the ad was on screen; 0 when nothing was shown */
  durationMs: number;
}

export interface ShowRewardedOptions {
  placement: AdPlacement;
  onReward: () => void;
  onSkip: () => void;
}

/** The one interface a real network has to satisfy. */
export interface AdNetwork {
  readonly name: string;
  preloadInterstitial(): Promise<boolean>;
  showInterstitial(placement: AdPlacement): Promise<AdResult>;
  preloadRewarded(): Promise<boolean>;
  showRewarded(options: ShowRewardedOptions): Promise<AdResult>;
}

export interface AdHost {
  /** Render the mock ad surface. Returns a promise that resolves when it closes. */
  present(kind: 'interstitial' | 'rewarded', durationMs: number): Promise<'completed' | 'closed'>;
}

/** A headless host, used by tests and as a fallback before the UI is mounted. */
export const headlessHost: AdHost = {
  present: async () => 'completed',
};

export interface MockNetworkOptions {
  levers: Levers;
  rng?: () => number;
  host?: AdHost;
}

export class MockAdNetwork implements AdNetwork {
  readonly name = 'mock';
  private interstitialReady = false;
  private rewardedReady = false;
  private readonly levers: Levers;
  private readonly rng: () => number;
  private readonly host: AdHost;

  constructor(options: MockNetworkOptions) {
    this.levers = options.levers;
    this.rng = options.rng ?? Math.random;
    this.host = options.host ?? headlessHost;
  }

  async preloadInterstitial(): Promise<boolean> {
    this.interstitialReady = this.rng() < this.levers.mockAdFillRate;
    return this.interstitialReady;
  }

  async preloadRewarded(): Promise<boolean> {
    this.rewardedReady = this.rng() < this.levers.mockAdFillRate;
    return this.rewardedReady;
  }

  async showInterstitial(placement: AdPlacement): Promise<AdResult> {
    if (!this.interstitialReady) {
      await this.preloadInterstitial();
    }
    if (!this.interstitialReady) {
      return { outcome: 'no_fill', placement, durationMs: 0 };
    }
    this.interstitialReady = false;
    const duration = this.levers.mockAdDurationMs;
    await this.host.present('interstitial', duration);
    void this.preloadInterstitial();
    return { outcome: 'shown', placement, durationMs: duration };
  }

  async showRewarded(options: ShowRewardedOptions): Promise<AdResult> {
    if (!this.rewardedReady) {
      await this.preloadRewarded();
    }
    if (!this.rewardedReady) {
      options.onSkip();
      return { outcome: 'no_fill', placement: options.placement, durationMs: 0 };
    }
    this.rewardedReady = false;
    const duration = this.levers.mockAdDurationMs;
    const how = await this.host.present('rewarded', duration);
    void this.preloadRewarded();
    if (how === 'completed') {
      options.onReward();
      return { outcome: 'rewarded', placement: options.placement, durationMs: duration };
    }
    options.onSkip();
    return { outcome: 'skipped', placement: options.placement, durationMs: duration };
  }
}

export interface AdManagerOptions {
  levers: Levers;
  network: AdNetwork;
  telemetry?: Telemetry | null;
  now?: () => number;
}

/**
 * The cap layer. All game code goes through this, never through the network
 * directly, so the guardrails cannot be bypassed by a call site.
 */
export class AdManager {
  private readonly levers: Levers;
  private readonly network: AdNetwork;
  private readonly telemetry: Telemetry | null;
  private readonly now: () => number;

  private lastInterstitialAt = -Infinity;
  private gamesPlayed = 0;
  private continuesOfferedThisGame = 0;
  private continuesTakenThisGame = 0;
  private chestsOfferedThisSession = 0;
  private gamesSinceChest = Number.MAX_SAFE_INTEGER;

  constructor(options: AdManagerOptions) {
    this.levers = options.levers;
    this.network = options.network;
    this.telemetry = options.telemetry ?? null;
    this.now = options.now ?? (() => Date.now());
  }

  async warmUp(): Promise<void> {
    await Promise.all([this.network.preloadInterstitial(), this.network.preloadRewarded()]);
  }

  /** Call at the start of every game. */
  onGameStart(): void {
    this.continuesOfferedThisGame = 0;
    this.continuesTakenThisGame = 0;
  }

  /** Call at the end of every game. */
  onGameEnd(): void {
    this.gamesPlayed++;
    if (this.gamesSinceChest !== Number.MAX_SAFE_INTEGER) this.gamesSinceChest++;
  }

  /** Call once per session when a new session begins. */
  onSessionStart(): void {
    this.chestsOfferedThisSession = 0;
  }

  // ───────────────────────── interstitial ─────────────────────────

  /**
   * Interstitials are capped by a hard minimum interval (never below the
   * guardrail), by a minimum number of games played, and to the game-over
   * moment only -- the end of a task, never the middle of one.
   */
  canShowInterstitial(): { allowed: boolean; reason: string } {
    if (!this.levers.interstitialEnabled) return { allowed: false, reason: 'disabled' };
    if (this.gamesPlayed < this.levers.interstitialMinGamesBeforeFirst) {
      return { allowed: false, reason: 'new_player_grace' };
    }
    const minInterval = Math.max(
      guardrails.interstitialAbsoluteMinIntervalSeconds,
      this.levers.interstitialMinIntervalSeconds,
    );
    const elapsed = (this.now() - this.lastInterstitialAt) / 1000;
    if (elapsed < minInterval) return { allowed: false, reason: 'frequency_cap' };
    return { allowed: true, reason: 'ok' };
  }

  async maybeShowInterstitial(): Promise<AdResult> {
    const placement: AdPlacement = 'interstitial_gameover';
    const gate = this.canShowInterstitial();
    this.telemetry?.log('ad_opportunity', { placement, allowed: gate.allowed, reason: gate.reason });
    if (!gate.allowed) {
      return { outcome: 'capped', placement, durationMs: 0 };
    }
    const result = await this.network.showInterstitial(placement);
    if (result.outcome === 'shown') {
      this.lastInterstitialAt = this.now();
      this.telemetry?.log('ad_impression', { placement, durationMs: result.durationMs });
    } else {
      this.telemetry?.log('ad_no_fill', { placement });
    }
    return result;
  }

  // ───────────────────────── rewarded: continue ─────────────────────────

  /**
   * Lever 4. One opt-in rescue per game, only once the run is worth rescuing.
   * Never forced, never repeated — the guardrail caps this at 1 in code.
   */
  canOfferContinue(score: number): { allowed: boolean; reason: string } {
    if (!this.levers.rewardedEnabled || !this.levers.continueOfferEnabled) {
      return { allowed: false, reason: 'disabled' };
    }
    const cap = Math.min(guardrails.continueAbsoluteMaxPerGame, this.levers.continueMaxPerGame);
    if (this.continuesTakenThisGame >= cap) return { allowed: false, reason: 'already_used' };
    if (this.continuesOfferedThisGame >= cap) return { allowed: false, reason: 'already_offered' };
    if (score < this.levers.continueMinScoreToOffer) {
      return { allowed: false, reason: 'score_below_threshold' };
    }
    return { allowed: true, reason: 'ok' };
  }

  noteContinueOffered(): void {
    this.continuesOfferedThisGame++;
    this.telemetry?.log('continue_offered', {});
  }

  async showContinueAd(): Promise<AdResult> {
    const placement: AdPlacement = 'rewarded_continue';
    this.telemetry?.log('ad_opportunity', { placement, allowed: true, reason: 'user_opt_in' });
    let rewarded = false;
    const result = await this.network.showRewarded({
      placement,
      onReward: () => {
        rewarded = true;
      },
      onSkip: () => {},
    });
    if (rewarded) {
      this.continuesTakenThisGame++;
      this.telemetry?.log('continue_accepted', {});
      this.telemetry?.log('ad_reward', { placement });
      this.telemetry?.log('ad_impression', { placement, durationMs: result.durationMs });
    } else if (result.outcome === 'skipped') {
      this.telemetry?.log('ad_skip', { placement });
    } else {
      this.telemetry?.log('ad_no_fill', { placement });
    }
    return result;
  }

  // ───────────────────────── rewarded: chest ─────────────────────────

  /** Lever 6. Scarce by cooldown, never by manufactured urgency. */
  canOfferChest(): { allowed: boolean; reason: string } {
    if (!this.levers.chestEnabled || !this.levers.rewardedEnabled) {
      return { allowed: false, reason: 'disabled' };
    }
    if (this.chestsOfferedThisSession >= this.levers.chestMaxPerSession) {
      return { allowed: false, reason: 'session_cap' };
    }
    if (this.gamesSinceChest < this.levers.chestCooldownGames) {
      return { allowed: false, reason: 'cooldown' };
    }
    return { allowed: true, reason: 'ok' };
  }

  noteChestOffered(): void {
    this.chestsOfferedThisSession++;
    this.gamesSinceChest = 0;
    this.telemetry?.log('chest_offered', {});
  }

  async showChestAd(): Promise<AdResult> {
    const placement: AdPlacement = 'rewarded_chest';
    this.telemetry?.log('ad_opportunity', { placement, allowed: true, reason: 'user_opt_in' });
    let rewarded = false;
    const result = await this.network.showRewarded({
      placement,
      onReward: () => {
        rewarded = true;
      },
      onSkip: () => {},
    });
    if (rewarded) {
      this.telemetry?.log('chest_accepted', {});
      this.telemetry?.log('ad_reward', { placement });
      this.telemetry?.log('ad_impression', { placement, durationMs: result.durationMs });
    } else if (result.outcome === 'skipped') {
      this.telemetry?.log('ad_skip', { placement });
    } else {
      this.telemetry?.log('ad_no_fill', { placement });
    }
    return result;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * SWAP TODO — replacing the mock with a real network (10 steps)
 *
 *  1. WEB (AdSense for Games / AdinPlay): apply for an H5 games account; both
 *     require a live URL and a privacy policy page before approval.
 *  2. Load the host script once in index.html, NOT per call, and keep it out of
 *     the service-worker precache so a stale SDK is never served offline.
 *  3. Implement `AdNetwork` in a new src/ads.adsense.ts; keep this file as the
 *     dev/test double and select by env (import.meta.env.VITE_AD_NETWORK).
 *  4. Map rewarded callbacks: AdSense H5 `adBreak({type:'reward',
 *     beforeReward, adViewed, adDismissed})` -> our onReward / onSkip.
 *  5. Set `tagForChildDirectedTreatment` / `requestNonPersonalizedAds` on every
 *     request (guardrails.requestNonPersonalisedAds) — we assume under-13 players.
 *  6. STORE WRAP (Capacitor + AdMob): add @capacitor-community/admob, call
 *     AdMob.initialize({ tagForChildDirectedTreatment: true }) at boot.
 *  7. Replace preloadInterstitial/showInterstitial with AdMob.prepareInterstitial
 *     / showInterstitial, and preloadRewarded/showRewarded with
 *     prepareRewardVideoAd / showRewardVideoAd + the rewardedVideoAdReward event.
 *  8. Keep AdManager untouched: the frequency caps and guardrails must stay the
 *     single chokepoint, so no real-network call site can bypass them.
 *  9. Add a real ad-unit id table per platform behind env vars; never commit ids.
 * 10. Re-run tests/caps.test.ts against the real adapter with a stubbed host —
 *     the cap tests are network-agnostic by design.
 * ──────────────────────────────────────────────────────────────────────────── */
