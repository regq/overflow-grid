# Overflow Grid — build report

**Live URL:** _pending — filled in once GitHub Pages reports a deployment._
**Repo:** https://github.com/regq/overflow-grid
**Built:** 2026-10-20, overnight, unattended.
**Status:** `npm test` 120/120 passing · `tsc --noEmit` clean · production bundle
54 kB raw / 18 kB gzipped · core loop, surge, continue and chest flows verified
by hand in a 375x812 mobile viewport.

---

## The twist: pressure & vent

**What it is.** A second resource that runs in parallel with board space. Every
placement adds pressure — `pressurePerPlacement + pressureFillCoefficient x
occupancy`, so a crowded board fills the meter faster. Clearing lines is the only
way to vent it; clearing a line that contains ballast vents extra. When the meter
fills, a **surge** injects ballast tiles from the bottom row upward and the meter
resets to a residue rather than to zero. Ballast is inert: it cannot be moved and
only leaves via a line clear.

**Why this one.** Block-placement puzzles have a structural problem: the only
pressure is spatial, so the optimal strategy is to play slowly and defensively,
and the failure state arrives as a surprise rather than as a build-up. Three
things follow from adding a pressure meter:

1. **Playing safe now costs something.** Hoarding empty space raises occupancy
   pressure, so the dominant passive strategy is punished without making the
   rules harder.
2. **A clear becomes relief, not just reward.** Removing an aversive state is a
   stronger and longer-lasting reinforcer than adding a pleasant one, and it is
   exactly the feeling the meter manufactures.
3. **The failure state becomes legible and anticipated.** The player watches the
   threat approach, which converts a surprise loss into a near-miss they feel
   responsible for — the state that drives "one more go".

It also gives the flow curve something honest to modulate. Difficulty scales the
*number of ballast tiles per surge* (`surgeBallastMin` → `surgeBallastMax`),
which is a legible consequence, rather than secretly degrading the piece supply.

**One rule that is deliberately not obvious:** a surge can bury the player but it
can **never complete a line**. Any cell that would be the last empty one in its
row or column is skipped. Without that rule a surge either hands out an unearned
clear or leaves a full line sitting on the board until the next placement. This
was found by playtesting, not by reasoning; `tests/board.test.ts` now asserts it
over 40 seeds.

**Combo feeds the next pieces.** At `comboFeedThreshold` (3) and above, a live
combo pushes the generator's steer probability back up toward 1 — escalation the
player feels they earned, which decays as soon as the combo breaks.

---

## Lever table

Everything below is a named constant in [`src/levers.ts`](src/levers.ts) with a
one-line "why it works" comment. No game module hard-codes a behavioural number.
[`TUNING.md`](TUNING.md) covers changing any of them without touching game code.

| # | Lever (key) | Default | Metric it moves |
| --- | --- | ---: | --- |
| 1 | `assistGuaranteedClearsAtStart` | 3 | First-session completion → D1 |
| 1 | `assistProbabilityCeiling` → `assistProbabilityFloor` | 0.92 → 0.18 | Session length; long-run challenge |
| 1 | `assistDecayPlacements` | 45 | Time-to-difficulty; early churn |
| 1 | `nearMissProbability` | 0.22 | Games per session ("one more go") |
| 1 | `nearMissHighlightThreshold` | 1 | Whether the near-miss is *perceived* |
| 1 | `generatorCandidatePool` | 12 | Precision of the bias (not a player-facing dial) |
| 2 | `skillWindowSeconds` | 90 | Responsiveness of the ramp |
| 2 | `skillFloorClearsPerMin` / `skillCeilClearsPerMin` | 1.5 / 9 | Churn at the difficulty wall |
| 2 | `skillSmoothing` | 0.25 | Perceived fairness of the ramp |
| T | `pressureCapacity` | 100 | Session length — the biggest single dial |
| T | `pressurePerPlacement` | 7 | Tempo of the threat |
| T | `pressureFillCoefficient` | 10 | Punishes hoarding → clears/min |
| T | `ventPerLine` | 22 | Relief magnitude → clear satisfaction |
| T | `ventPerBallast` | 6 | Pushes players to attack ballast |
| T | `pressureResetTo` | 35 | Tension between surges |
| T | `surgeBallastMin` / `surgeBallastMax` | 2 / 5 | The flow curve's actual output |
| T | `surgeFillsFromBottom` | true | Legibility / perceived fairness |
| C | `comboFeedThreshold` | 3 | Reachability of escalation |
| C | `comboFeedStrength` | 0.55 | Peak session length |
| C | `comboDecayPlacements` | 2 | Forgiveness → frustration churn |
| C | `comboScoreStep` | 0.5 | Score escalation |
| 3 | `resumeEnabled` | true | D1 |
| 3 | `resumeMaxAgeHours` | 72 | D1 / D3 window |
| 3 | `resumeShowUnfinishedCombo` | true | D1 — the specific message is the lever |
| 4 | `continueOfferEnabled` | true | Rewarded opt-in rate; ARPDAU |
| 4 | `continueMaxPerGame` | 1 (**hard cap**) | Trust; ad fatigue |
| 4 | `continueClearsRandomPieces` | 3 | Perceived value of the ad |
| 4 | `continueMinScoreToOffer` | 300 | Offer precision vs. nagging |
| 4 | `continuePressureRelief` | 40 | Whether the rescue actually works |
| 5 | `streakEnabled` | true | D1, D7 |
| 5 | `streakGraceDays` | 1 | Churn after a missed day |
| 5 | `weeklyGoalEndowedFraction` | 0.2 | Weekly goal completion rate |
| 5 | `weeklyGoalClears` | 120 | Sessions per week |
| 6 | `chestEnabled` | true | Rewarded opt-in; ARPDAU |
| 6 | `chestMaxPerSession` | 2 | Reward value vs. dilution |
| 6 | `chestCooldownGames` | 2 | Interruption cost |
| 7 | `localLeaderboardSize` | 5 | Self-competition → session count |
| 7 | `showPersonalBestTarget` | true | Near-miss framing on every run |
| A | `interstitialEnabled` | true | Impressions/session |
| A | `interstitialMinIntervalSeconds` | 210 (floor **180**) | Impressions/session vs. churn |
| A | `interstitialMinGamesBeforeFirst` | 3 | D1 — the most dangerous ad dial |
| A | `rewardedEnabled` | true | Rewarded impressions |
| J | `clearAnimationMs` | 260 | Feel; input responsiveness |
| J | `hapticsEnabled` / `soundDefaultOn` | true / true | Perceived juice |
| M | `ecpmLowUsd` / `ecpmHighUsd` | 12 / 25 | `/debug` revenue projection only |

*T = the twist, C = combo, A = ads, J = juice, M = modelling.*

### Guardrails (enforced in code, asserted in tests, not tunable)

`clampToGuardrails()` runs on every lever load and `AdManager` re-applies the
floors internally, so no call site or query string can breach them:

- forced non-rewarded ads: **never more than 1 per 180 s**
- rewarded continue: **never more than 1 per game**, opt-in only
- no countdown pressure, no fake scarcity, no fake close buttons
- no behavioural ad targeting, no PII, no cross-site identifiers
- real ad adapters must request non-personalised, child-directed-safe ads

---

## Ad placement spec

Three placements. All calls go through `AdManager`, never the network directly,
so the caps are a single chokepoint rather than a convention.

| Placement | Format | Trigger | Caps | Reward |
| --- | --- | --- | --- | --- |
| `interstitial_gameover` | Interstitial (forced) | Tapping **Play again** — between games, never mid-game | ≥180 s apart (hard floor; default 210 s); not until 3 games played | none |
| `rewarded_continue` | Rewarded video (opt-in) | Game over, score ≥ 300 | **1 per game**, hard cap | Dissolve 3 placed pieces + vent 40 pressure, run resumes |
| `rewarded_chest` | Rewarded video (opt-in) | Game-over screen, secondary button | 2 per session, 2-game cooldown | One roll on a **publicly displayed** loot table |

**Placement reasoning.** The interstitial sits on the *Play again* tap, not on
the game-over event itself: it interrupts the boundary between two tasks instead
of the end of one the player is still processing, and it never lands between a
loss and the decision about whether to take the rescue. New players see no forced
ad for their first three games, which is the cheapest D1 protection available.

**Loot table** (`LOOT_TABLE`, `src/progress.ts`) — the UI renders these exact
percentages from the same weights, and a test asserts that published odds match
rolled odds over 20 000 rolls:

| Reward | Odds |
| --- | ---: |
| Vent Charge — next game starts with an empty meter | 50% |
| Tile set: Tideline (cosmetic) | 25% |
| Dissolve 2 ballast tiles now | 20% |
| Tile set: Ember (cosmetic, rare) | 5% |

No currency, no pay-to-win, nothing purchasable.

**Logging.** Every impression *opportunity* is logged, not just every impression
— including the ones the caps refuse, with the reason. Fill rate and cap losses
are therefore visible in `/debug` instead of invisible.

**Mock SDK.** `src/ads.ts` implements the shape shared by AdMob and AdSense for
Games (`preloadInterstitial` / `showInterstitial` / `preloadRewarded` /
`showRewarded` with `onReward` / `onSkip`). Swapping in a real network means
implementing one interface; the 10-step swap guide for web (AdSense for Games /
AdinPlay) and store wrap (Capacitor + AdMob) is at the bottom of that file.

---

## The three numbers to watch in week one

Measured from the `/debug` export. Thresholds assume ≥200 installs; below that,
keep gathering rather than deciding.

| # | Metric | Keep building | Grey zone | Kill it |
| --- | --- | --- | --- | --- |
| 1 | **D1 return** | ≥ 25% | 15–25% | < 15% |
| 2 | **Rewarded opt-in rate** (accepts ÷ offers) | ≥ 20% | 8–20% | < 8% |
| 3 | **Impressions per DAU** × eCPM ÷ 1000 = **ARPDAU proxy** | ≥ $0.020 | $0.008–0.020 | < $0.008 |

**Why these three.** D1 is the only retention number that moves fast enough to
read in a week and it gates everything downstream. Rewarded opt-in is the
cleanest read on whether players find the game worth an ad — it is a *consent*
metric as much as a revenue one, and a low rate means the rescue is not valuable
enough, not that the ad should be forced. ARPDAU proxy is the only number that
tells you whether retention converts to money at all.

**Reading them together:** high D1 with low opt-in is a monetisation problem
(fixable — raise `continueClearsRandomPieces`, lower `continueMinScoreToOffer`).
Low D1 with high opt-in is a game problem (harder — the loop does not hold).
Both low, two weeks running, with the obvious lever moves tried: kill it.

**Honest caveat:** the D1 figure in `/debug` is a *single-install proxy* — share
of active days followed by a return 16–48 h later. It is directionally useful for
your own device and useless as a cohort number. Real D1 needs either an analytics
endpoint (which costs the no-consent-wall privacy posture) or a store build with
platform analytics. That trade-off is task #2 below.

---

## Next 5 tasks

1. **Ship a real ad network behind the existing interface.** AdSense for Games
   needs a live URL and a privacy policy page; both are now available. Follow the
   10-step guide in `src/ads.ts`. Keep `AdManager` untouched so the caps survive.
   *Blocks every revenue number above.*
2. **Decide the analytics trade-off.** Either (a) add a privacy-preserving
   aggregate endpoint — counts only, no identifiers, so the COPPA/GDPR posture
   holds — or (b) accept the single-install proxy and read retention from store
   analytics after a Capacitor wrap. Pick one; the week-one numbers are only as
   good as this choice.
3. **Playtest the pressure curve with real players.** The defaults are reasoned,
   not measured. Ship three URLs with different `pressureCapacity` /
   `surgeBallastMax` pairs and compare session length and games/session. This is
   the lever most likely to be wrong.
4. **Add a tutorial beat for ballast.** New players currently meet their first
   surge with no explanation. A one-time, dismissible callout the first time
   ballast appears — not a forced tutorial — should recover first-session
   completion.
5. **Harden the resume path.** It currently restores the grid but not piece-group
   attribution, so a continue on a resumed board can only dissolve ballast and
   pieces placed after the resume. Persist the groups in the snapshot.

---

## What was verified, and how

- **Automated:** 120 unit tests across 7 files — piece-generation bias (including
  that early draws are >80% clear-capable and late/high-skill draws drop by >20
  points), line clears and intersections, the difficulty ramp and its monotonicity,
  ad frequency caps against a controlled clock, guardrail clamping, streak and
  endowed-goal maths, loot-table honesty, and metric computation.
- **By hand, in a 375x812 mobile viewport:** drag-and-drop placement, line clears
  with combo scoring and floating score text, a surge injecting ballast with its
  toast, the Zeigarnik resume sheet (both the generic and the
  "1 clear from a 2-combo" variants), the endowed goal bar, game over → rewarded
  continue offer → mock ad surface → pieces dissolved → play resumed, and the
  `#debug` panel with all metrics and the live lever list.
- **Not verified:** behaviour on real iOS/Android hardware, haptics (no device),
  real 60 fps on a mid-range phone (measured only in a desktop browser), and the
  installed-PWA launch path. These need a physical device.
