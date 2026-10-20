# Overflow Grid — working agreement

## Commit messages

Conventional Commits, imperative mood, lower-case subject, no trailing period,
subject <= 72 chars:

```
<type>(<scope>): <subject>

<body: what changed and why, wrapped at 80>

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

Types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`.
Scopes used here: `game`, `levers`, `ads`, `telemetry`, `render`, `pwa`, `ci`, `docs`.

Every commit that changes a behavioural lever, an ad placement or a frequency cap
must say in the body which metric it is expected to move and in which direction.

## Rules that are not negotiable

1. **No number that belongs to player behaviour lives outside `src/levers.ts`.**
   If you are about to type a magic number into game code, it is a lever.
2. **All ad calls go through `AdManager`**, never through an `AdNetwork` directly.
   The caps are only guarantees if there is one chokepoint.
3. **`guardrails` in `src/levers.ts` may be read, never loosened.** Tests assert
   them. Changing one is a product decision, not a tuning decision, and needs its
   own commit with the reasoning in the body.
4. **No dark patterns.** No fake close buttons, no countdown pressure, no fake
   scarcity, no forced non-rewarded ad more often than the guardrail allows, no
   consent dark patterns. Rewarded offers are opt-in and say what they give.
5. **Assume players may be under 13.** No behavioural targeting, no PII, no
   cross-site identifiers, no network transmission of telemetry.
6. `npm test` and `npm run typecheck` must pass before any push to `main`.

## Layout

```
src/levers.ts      every tunable, with a "why it works" comment each
src/game.ts        headless engine — no DOM, no storage, no canvas
src/board.ts       grid rules: placement, clears, surges
src/generator.ts   piece-generation bias (variable-ratio reward)
src/difficulty.ts  skill measurement and the flow curve
src/pressure.ts    the pressure/vent twist
src/ads.ts         mock SDK with the real interface shape + the cap layer
src/telemetry.ts   anonymous local events + metric computation
src/progress.ts    streaks, endowed goal, resume state, chest loot
src/render.ts      canvas 2D renderer
src/main.ts        wiring: input, frame loop, lever flows
```

Keep `game.ts` headless. If a change to it needs `window`, the change belongs in
`main.ts` instead.
