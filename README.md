# Overflow Grid

An 8x8 block-placement puzzle where the pressure meter is the real opponent.

Drop pieces, fill rows and columns, clear them. Every placement raises a pressure
meter — faster when the board is crowded. Clearing lines is the only way to vent
it. Let it overflow and the board takes on **ballast**: inert stone tiles that
fill from the bottom up and only leave via a line clear.

Original work: no copied names, art, sounds or UI.

- **Play:** see the deployed URL in [REPORT.md](REPORT.md)
- **Report:** [REPORT.md](REPORT.md) — the twist, the lever table, the ad spec,
  the numbers to watch
- **Tuning:** [TUNING.md](TUNING.md) — how to change any lever without touching
  game code

## Stack

Plain Canvas 2D + TypeScript + Vite. No game framework: the whole bundle is
~18 kB gzipped, which matters more on a mid-range phone than anything a framework
would have given us. Mobile-first, pointer events (touch + mouse), PWA with
offline support, no backend.

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # 120 unit tests
npm run build    # typecheck + production bundle into dist/
```

Set `VITE_BASE` at build time when deploying under a sub-path:

```bash
VITE_BASE=/overflow-grid/ npm run build
```

## Instrumentation

A hidden panel at `#debug` (also `/debug/`, or five taps on the score) shows
sessions/day, average session length, games/session, a D1 return proxy, rewarded
opt-in rate, ads per session and projected revenue at two eCPM assumptions, plus
the live lever set and a JSON export.

## Privacy

No accounts, no servers, no network calls. Telemetry is anonymous gameplay events
in IndexedDB on the player's own device; the only identifier is a random
per-install id that never leaves the machine. Players may be under 13, so there
is no behavioural ad targeting, no PII and no cross-site identifier — which is
what lets the game ship child-safe defaults without a consent wall.

## Licence

MIT — see [LICENSE](LICENSE).
