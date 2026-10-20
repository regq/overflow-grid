import { beforeEach, describe, expect, it } from 'vitest';
import {
  AdManager,
  MockAdNetwork,
  headlessHost,
  type AdHost,
  type AdNetwork,
  type AdResult,
  type ShowRewardedOptions,
} from '../src/ads.js';
import { clampToGuardrails, defaultLevers, guardrails, loadLevers, type Levers } from '../src/levers.js';
import { MemoryEventStore, Telemetry } from '../src/telemetry.js';

/** A clock we control, so cap windows are exact rather than flaky. */
function clock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advanceSeconds: (s: number) => {
      t += s * 1000;
    },
  };
}

function makeTelemetry(): Telemetry {
  return new Telemetry({
    store: new MemoryEventStore(),
    installId: 'test',
    enabled: true,
    maxEvents: 1000,
    batchSize: 1,
  });
}

/** A network that always fills and always rewards. */
class AlwaysNetwork implements AdNetwork {
  readonly name = 'always';
  shown = 0;
  async preloadInterstitial(): Promise<boolean> {
    return true;
  }
  async preloadRewarded(): Promise<boolean> {
    return true;
  }
  async showInterstitial(placement: AdResult['placement']): Promise<AdResult> {
    this.shown++;
    return { outcome: 'shown', placement, durationMs: 100 };
  }
  async showRewarded(options: ShowRewardedOptions): Promise<AdResult> {
    this.shown++;
    options.onReward();
    return { outcome: 'rewarded', placement: options.placement, durationMs: 100 };
  }
}

describe('interstitial frequency cap', () => {
  let c: ReturnType<typeof clock>;
  let network: AlwaysNetwork;
  let ads: AdManager;

  beforeEach(() => {
    c = clock(10_000_000);
    network = new AlwaysNetwork();
    ads = new AdManager({ levers: defaultLevers, network, telemetry: makeTelemetry(), now: c.now });
  });

  it('shows nothing to a brand-new player', async () => {
    expect(ads.canShowInterstitial().reason).toBe('new_player_grace');
    const result = await ads.maybeShowInterstitial();
    expect(result.outcome).toBe('capped');
    expect(network.shown).toBe(0);
  });

  it('allows the first interstitial only after the grace games', async () => {
    for (let i = 0; i < defaultLevers.interstitialMinGamesBeforeFirst; i++) {
      ads.onGameStart();
      ads.onGameEnd();
    }
    expect(ads.canShowInterstitial().allowed).toBe(true);
    expect((await ads.maybeShowInterstitial()).outcome).toBe('shown');
    expect(network.shown).toBe(1);
  });

  it('blocks a second interstitial inside the interval and allows it after', async () => {
    for (let i = 0; i < 5; i++) {
      ads.onGameStart();
      ads.onGameEnd();
    }
    await ads.maybeShowInterstitial();

    c.advanceSeconds(defaultLevers.interstitialMinIntervalSeconds - 1);
    expect(ads.canShowInterstitial().reason).toBe('frequency_cap');
    expect((await ads.maybeShowInterstitial()).outcome).toBe('capped');
    expect(network.shown).toBe(1);

    c.advanceSeconds(2);
    expect((await ads.maybeShowInterstitial()).outcome).toBe('shown');
    expect(network.shown).toBe(2);
  });

  it('never exceeds 1 forced ad per 3 minutes, even if a lever asks for more', async () => {
    const greedy: Levers = { ...defaultLevers, interstitialMinIntervalSeconds: 5 };
    const clamped = clampToGuardrails(greedy);
    expect(clamped.interstitialMinIntervalSeconds).toBe(
      guardrails.interstitialAbsoluteMinIntervalSeconds,
    );

    // and the manager re-applies the floor even if handed unclamped levers
    const rogue = new AdManager({ levers: greedy, network, telemetry: null, now: c.now });
    for (let i = 0; i < 5; i++) {
      rogue.onGameStart();
      rogue.onGameEnd();
    }
    await rogue.maybeShowInterstitial();
    c.advanceSeconds(120); // 2 minutes: still inside the 180s hard floor
    expect(rogue.canShowInterstitial().reason).toBe('frequency_cap');
    c.advanceSeconds(61);
    expect(rogue.canShowInterstitial().allowed).toBe(true);
  });

  it('respects the disabled lever', async () => {
    const off = new AdManager({
      levers: { ...defaultLevers, interstitialEnabled: false },
      network,
      telemetry: null,
      now: c.now,
    });
    for (let i = 0; i < 9; i++) {
      off.onGameStart();
      off.onGameEnd();
    }
    expect(off.canShowInterstitial().reason).toBe('disabled');
    expect(network.shown).toBe(0);
  });
});

describe('rewarded continue cap (lever 4)', () => {
  let network: AlwaysNetwork;
  let ads: AdManager;

  beforeEach(() => {
    network = new AlwaysNetwork();
    ads = new AdManager({ levers: defaultLevers, network, telemetry: makeTelemetry() });
    ads.onGameStart();
  });

  it('is never offered below the score threshold', () => {
    const gate = ads.canOfferContinue(defaultLevers.continueMinScoreToOffer - 1);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe('score_below_threshold');
  });

  it('is offered exactly once per game', async () => {
    const score = defaultLevers.continueMinScoreToOffer + 100;
    expect(ads.canOfferContinue(score).allowed).toBe(true);
    ads.noteContinueOffered();
    expect(ads.canOfferContinue(score).reason).toBe('already_offered');

    await ads.showContinueAd();
    expect(ads.canOfferContinue(score).reason).toBe('already_used');
  });

  it('resets on the next game, so one per game is one per game', async () => {
    const score = 5000;
    ads.noteContinueOffered();
    await ads.showContinueAd();
    ads.onGameEnd();
    ads.onGameStart();
    expect(ads.canOfferContinue(score).allowed).toBe(true);
  });

  it('cannot be raised above 1 by a lever override', () => {
    const greedy = clampToGuardrails({ ...defaultLevers, continueMaxPerGame: 5 });
    expect(greedy.continueMaxPerGame).toBe(guardrails.continueAbsoluteMaxPerGame);
  });

  it('a lever override is still capped at 1 inside the manager', async () => {
    const rogue = new AdManager({
      levers: { ...defaultLevers, continueMaxPerGame: 5 },
      network,
      telemetry: null,
    });
    rogue.onGameStart();
    rogue.noteContinueOffered();
    await rogue.showContinueAd();
    expect(rogue.canOfferContinue(9999).allowed).toBe(false);
  });
});

describe('chest cap (lever 6)', () => {
  it('is capped per session and gated by a cooldown in games', () => {
    const network = new AlwaysNetwork();
    const ads = new AdManager({ levers: defaultLevers, network, telemetry: null });
    ads.onSessionStart();

    expect(ads.canOfferChest().allowed).toBe(true);
    ads.noteChestOffered();
    expect(ads.canOfferChest().reason).toBe('cooldown');

    for (let i = 0; i < defaultLevers.chestCooldownGames; i++) {
      ads.onGameStart();
      ads.onGameEnd();
    }
    expect(ads.canOfferChest().allowed).toBe(true);
    ads.noteChestOffered();

    for (let i = 0; i < 10; i++) {
      ads.onGameStart();
      ads.onGameEnd();
    }
    expect(ads.canOfferChest().reason).toBe('session_cap');
  });
});

describe('mock network behaviour', () => {
  it('reports no_fill and calls onSkip when the fill roll fails', async () => {
    const network = new MockAdNetwork({
      levers: { ...defaultLevers, mockAdFillRate: 0 },
      rng: () => 0.99,
      host: headlessHost,
    });
    let skipped = false;
    const result = await network.showRewarded({
      placement: 'rewarded_chest',
      onReward: () => {},
      onSkip: () => {
        skipped = true;
      },
    });
    expect(result.outcome).toBe('no_fill');
    expect(skipped).toBe(true);
  });

  it('rewards when the host reports completion and skips when it is closed', async () => {
    const closingHost: AdHost = { present: async () => 'closed' };
    const network = new MockAdNetwork({
      levers: { ...defaultLevers, mockAdFillRate: 1, mockAdDurationMs: 1 },
      rng: () => 0,
      host: closingHost,
    });
    let rewarded = false;
    let skipped = false;
    const result = await network.showRewarded({
      placement: 'rewarded_continue',
      onReward: () => {
        rewarded = true;
      },
      onSkip: () => {
        skipped = true;
      },
    });
    expect(result.outcome).toBe('skipped');
    expect(rewarded).toBe(false);
    expect(skipped).toBe(true);
  });
});

describe('lever guardrails', () => {
  it('a query string cannot breach the ad floors', () => {
    const l = loadLevers('?interstitialMinIntervalSeconds=1&continueMaxPerGame=9', null);
    expect(l.interstitialMinIntervalSeconds).toBe(guardrails.interstitialAbsoluteMinIntervalSeconds);
    expect(l.continueMaxPerGame).toBe(1);
  });

  it('a query string can tune a normal lever', () => {
    const l = loadLevers('?pressureCapacity=250&soundDefaultOn=0', null);
    expect(l.pressureCapacity).toBe(250);
    expect(l.soundDefaultOn).toBe(false);
  });

  it('ignores unknown or malformed parameters instead of throwing', () => {
    const l = loadLevers('?notALever=4&pressureCapacity=abc', null);
    expect(l).not.toHaveProperty('notALever');
    expect(l.pressureCapacity).toBe(defaultLevers.pressureCapacity);
  });

  it('states the child-safety posture as code, not just prose', () => {
    expect(guardrails.behaviouralAdTargeting).toBe(false);
    expect(guardrails.collectsPersonalData).toBe(false);
    expect(guardrails.requestNonPersonalisedAds).toBe(true);
    expect(guardrails.noCountdownPressure).toBe(true);
    expect(guardrails.noFakeCloseButtons).toBe(true);
    expect(guardrails.noFakeScarcity).toBe(true);
  });
});
