# TUNING.md — changing any lever without touching game code

Every behavioural and economic number in Overflow Grid lives in
[`src/levers.ts`](src/levers.ts). No game module hard-codes one. There are three
ways to change a value, in increasing order of permanence.

---

## 1. Query string — fastest, zero build, per-tab

Append `?<leverName>=<value>` to the URL. Several levers can be combined with `&`.
Numbers are parsed as numbers; booleans accept `1`/`0` or `true`/`false`.

```
https://<your-url>/?pressureCapacity=70&surgeBallastMax=7
https://<your-url>/?assistProbabilityFloor=0.05&nearMissProbability=0
https://<your-url>/?soundDefaultOn=0&hapticsEnabled=0
```

Unknown parameters are ignored. A malformed value falls back to the default
rather than throwing. The override lasts for that page load only.

This is the mode to use for a playtest: send two testers two different URLs.

## 2. Saved overrides — persists on one device

1. Open the hidden panel: add `#debug` to the URL (or `/debug/`, or tap the score
   five times).
2. Set the levers you want via the query string as above.
3. Press **save live levers**. The current set is written to
   `localStorage["og.levers.overrides"]`.
4. Press **reset levers** to clear them.

Precedence is: `defaultLevers` ← saved overrides ← query string. The query string
always wins, so you can test on top of a saved set without clearing it.

You can also write the blob directly from a console:

```js
localStorage.setItem('og.levers.overrides', JSON.stringify({ weeklyGoalClears: 80 }));
location.reload();
```

## 3. Editing the defaults — permanent, for everyone

Change the value in `defaultLevers` at the bottom of `src/levers.ts`, then commit.
Per `CLAUDE.md`, the commit body must say which metric the change is expected to
move and in which direction. `npm test` must pass: several tests assert lever
relationships rather than specific values, and will catch an incoherent set.

---

## What cannot be changed

`guardrails` in `src/levers.ts` are ethical floors, enforced by
`clampToGuardrails()` on every load and re-applied inside `AdManager` so that no
call site can bypass them:

| Guardrail | Effect |
| --- | --- |
| `interstitialAbsoluteMinIntervalSeconds: 180` | A forced, non-rewarded ad can never appear more than once per 3 minutes, whatever `interstitialMinIntervalSeconds` says. |
| `continueAbsoluteMaxPerGame: 1` | The rewarded "continue" can never be offered or taken more than once per game. |
| `behaviouralAdTargeting: false`, `collectsPersonalData: false` | No behavioural targeting, no PII. |
| `requestNonPersonalisedAds: true` | Real ad adapters must request non-personalised ads. |
| `noCountdownPressure`, `noFakeScarcity`, `noFakeCloseButtons` | Asserted in tests and in review; the mock ad surface has a real, immediately-live close button. |

Setting `?interstitialMinIntervalSeconds=1` is silently clamped back to 180.
This is deliberate: the clamp is in `loadLevers`, so it also protects a build
where someone edited the default.

---

## Lever reference

### 1 · Variable-ratio reward — moves *session length, D1*

| Lever | Default | Effect of raising it |
| --- | ---: | --- |
| `assistGuaranteedClearsAtStart` | 3 | More guaranteed early clears. Raises first-session completion, slows the onset of real difficulty. |
| `assistProbabilityCeiling` | 0.92 | How generous the opening is. |
| `assistProbabilityFloor` | 0.18 | The permanent floor of help. Raising this makes the game easier forever; lowering it below ~0.1 makes long runs feel arbitrary. |
| `assistDecayPlacements` | 45 | How long the generosity lasts. Longer = gentler onboarding, lower long-run challenge. |
| `nearMissProbability` | 0.22 | How often a deliberate near-miss is offered. The strongest "one more go" dial; also the easiest to make feel manipulative. Keep below ~0.35. |
| `nearMissHighlightThreshold` | 1 | How many cells short a line can be and still glow. |
| `generatorCandidatePool` | 12 | Finer bias control, slightly more CPU per draw. |

### 2 · Flow curve — moves *churn at the difficulty wall*

| Lever | Default | Effect of raising it |
| --- | ---: | --- |
| `skillWindowSeconds` | 90 | Slower, steadier difficulty response. |
| `skillFloorClearsPerMin` | 1.5 | Raises the bar for "competent"; the game stays easy for longer. |
| `skillCeilClearsPerMin` | 9 | Raises the bar for "expert"; strong players get a longer ramp. |
| `skillSmoothing` | 0.25 | Faster, jumpier adaptation. Above ~0.5 the ramp becomes noticeable mid-run. |

### The twist · Pressure & vent — moves *session length, tension*

| Lever | Default | Effect of raising it |
| --- | ---: | --- |
| `pressureCapacity` | 100 | Longer between surges. The single biggest "make it easier" dial. |
| `pressurePerPlacement` | 7 | Baseline tempo of the threat. |
| `pressureFillCoefficient` | 10 | How much a crowded board accelerates the threat. Raise to punish hoarding harder. |
| `ventPerLine` | 22 | How much relief a clear gives. Must stay above `pressurePerPlacement + pressureFillCoefficient` or clearing cannot outpace placing — there is a test for this. |
| `ventPerBallast` | 6 | How much extra a ballast clear gives. Raise to push players to attack ballast rather than build around it. |
| `pressureResetTo` | 35 | Residue after a surge. 0 makes the game relaxing; near capacity makes it a death spiral. |
| `surgeBallastMin` / `surgeBallastMax` | 2 / 5 | Punishment at skill 0 / skill 1. This is where the flow curve actually bites. |
| `surgeFillsFromBottom` | true | Off makes surges feel arbitrary. Leave it on. |

### Combo meter → next pieces — moves *peak session length*

| Lever | Default | Effect of raising it |
| --- | ---: | --- |
| `comboFeedThreshold` | 3 | Combos must get longer before the generator starts feeding them. |
| `comboFeedStrength` | 0.55 | How hard a live combo pulls the draw toward clear-capable pieces. 1.0 makes combos nearly endless. |
| `comboDecayPlacements` | 2 | How forgiving a combo is. |
| `comboScoreStep` | 0.5 | Score escalation per combo step. |

### 3 · Zeigarnik / resume — moves *D1*

| Lever | Default | Effect of raising it |
| --- | ---: | --- |
| `resumeEnabled` | true | Off disables the whole lever. |
| `resumeMaxAgeHours` | 72 | How long a board stays resumable. Past ~a week a resume feels stale rather than inviting. |
| `resumeShowUnfinishedCombo` | true | Off falls back to a generic message and the lever loses most of its effect. |

### 4 · Loss aversion / continue — moves *rewarded opt-in, ARPDAU*

| Lever | Default | Effect of raising it |
| --- | ---: | --- |
| `continueOfferEnabled` | true | Off removes the highest-value ad placement. |
| `continueMaxPerGame` | 1 | **Clamped to 1.** |
| `continueClearsRandomPieces` | 3 | How much the rescue is worth. Too low and the ad feels stolen; the player should get a real second life. |
| `continueMinScoreToOffer` | 300 | Raising it means fewer, better-targeted offers. Lower it and the offer starts reading as nagging. |
| `continuePressureRelief` | 40 | Without this the rescued board dies immediately. |

### 5 · Streaks + endowed progress — moves *D1, D7*

| Lever | Default | Effect of raising it |
| --- | ---: | --- |
| `streakEnabled` | true | Off disables streaks. |
| `streakGraceDays` | 1 | More forgiveness for a missed day. 0 makes a single slip end the relationship. |
| `weeklyGoalEndowedFraction` | 0.2 | A bigger free head start. Clamped to 0.9. The endowment is disclosed in the UI on purpose. |
| `weeklyGoalClears` | 120 | A longer weekly commitment. Size it for 4-5 sessions, not 1. |

### 6 · Chests — moves *rewarded opt-in, ARPDAU*

| Lever | Default | Effect of raising it |
| --- | ---: | --- |
| `chestEnabled` | true | Off removes the second rewarded placement. |
| `chestMaxPerSession` | 2 | More chests per session; dilutes the reward. |
| `chestCooldownGames` | 2 | Longer gap between offers. |

The loot table itself is `LOOT_TABLE` in `src/progress.ts`. The UI renders its
real percentages from the same weights — a test asserts that published odds match
rolled odds, so the table cannot drift away from the truth.

### 7 · Social proof — moves *session count*

| Lever | Default | Effect of raising it |
| --- | ---: | --- |
| `localLeaderboardSize` | 5 | More of your own history on the game-over screen. |
| `showPersonalBestTarget` | true | Off removes the "beat your best" framing. |

### Ads

| Lever | Default | Effect of raising it |
| --- | ---: | --- |
| `interstitialEnabled` | true | Off removes forced ads entirely. |
| `interstitialMinIntervalSeconds` | 210 | Fewer forced ads. **Floored at 180.** |
| `interstitialMinGamesBeforeFirst` | 3 | Longer ad-free onboarding. Lowering this is the fastest way to damage D1. |
| `interstitialAfterGameOverOnly` | true | Documents the placement; interstitials are only called from the between-games path. |
| `rewardedEnabled` | true | Off disables both rewarded placements. |
| `mockAdFillRate` | 0.9 | Dev only — lower it to exercise the no-fill path. |
| `mockAdDurationMs` | 1200 | Dev only. |

### Juice, telemetry

| Lever | Default | Notes |
| --- | ---: | --- |
| `clearAnimationMs` | 260 | Above ~400 the next placement starts to feel blocked. |
| `hapticsEnabled` | true | Respects the device setting; a no-op where unsupported. |
| `soundDefaultOn` | true | The player's choice is remembered in their profile. |
| `telemetryEnabled` | true | Off stops all local event recording. |
| `telemetryMaxEvents` | 5000 | Cap on the local IndexedDB queue. |
| `ecpmLowUsd` / `ecpmHighUsd` | 12 / 25 | Only used for the projected-revenue readout in `/debug`. Estimates, not promises. |
