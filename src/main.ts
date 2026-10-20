/**
 * main.ts — wiring. Owns the input layer, the frame loop, and the order in
 * which the behavioural levers fire around a game-over.
 */

import { AdManager, MockAdNetwork } from './ads.js';
import { Audio } from './audio.js';
import { SIZE } from './board.js';
import { debugRequested, openDebugPanel } from './debug.js';
import { Game } from './game.js';
import { Haptics } from './haptics.js';
import { loadLevers } from './levers.js';
import { pieceSize } from './pieces.js';
import {
  addWeeklyClears,
  advanceStreak,
  clearResume,
  loadProfile,
  loadResume,
  recordScore,
  resumeMessage,
  rollChest,
  saveProfile,
  saveResume,
  weeklyGoal,
  type Profile,
} from './progress.js';
import { Renderer, type DragState, type Fx } from './render.js';
import { makeRng } from './rng.js';
import { Telemetry, getInstallId, pickEventStore } from './telemetry.js';
import { Ui, renderGoal, type SheetButton } from './ui.js';

const levers = loadLevers(location.search, safeStorage());
const storage = safeStorage();

const canvas = document.getElementById('c') as HTMLCanvasElement;
const stage = document.getElementById('stage') as HTMLElement;
const scoreEl = document.getElementById('score') as HTMLElement;
const bestEl = document.getElementById('best') as HTMLElement;
const streakEl = document.getElementById('streak-n') as HTMLElement;
const muteIcon = document.getElementById('mute-icon') as HTMLElement;
const goalFill = document.getElementById('goal-fill') as HTMLElement;
const goalLabel = document.getElementById('goal-label') as HTMLElement;
const comboBadge = document.getElementById('combo-badge') as HTMLElement;

const ui = new Ui(
  document.getElementById('modal-root') as HTMLElement,
  document.getElementById('toast-root') as HTMLElement,
);

const telemetry = new Telemetry({
  store: pickEventStore(),
  installId: getInstallId(storage),
  enabled: levers.telemetryEnabled,
  maxEvents: levers.telemetryMaxEvents,
});

let profile: Profile = loadProfile(storage);
const audio = new Audio(profile.muted || !levers.soundDefaultOn);
const haptics = new Haptics(levers.hapticsEnabled);
const renderer = new Renderer(canvas);
const uiRng = makeRng(Date.now() & 0x7fffffff);

const adNetwork = new MockAdNetwork({ levers, host: ui.adHost() });
const ads = new AdManager({ levers, network: adNetwork, telemetry });

const game = new Game({ levers });

let drag: DragState | null = null;
let fx: Fx[] = [];
let debugOpen = false;
let scoreTaps = 0;
let scoreTapAt = 0;

// ───────────────────────── session lifecycle ─────────────────────────

telemetry.log('session_start', { levers: { ...levers } });
ads.onSessionStart();
void ads.warmUp();

const endSession = (): void => {
  if (game.status === 'playing') persistResume();
  telemetry.log('session_end', { score: game.score, status: game.status });
  void telemetry.flush();
};

window.addEventListener('pagehide', endSession);
window.addEventListener('beforeunload', endSession);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (game.status === 'playing') persistResume();
    void telemetry.flush();
  }
});

// ───────────────────────── game events ─────────────────────────

game.on((name, payload) => {
  switch (name) {
    case 'game_start':
      telemetry.log('game_start', payload);
      ads.onGameStart();
      break;

    case 'clear': {
      const lines = Number(payload.lines ?? 1);
      telemetry.log('clear', payload);
      profile = addWeeklyClears(profile, lines, Date.now());
      saveProfile(profile, storage);
      renderGoal(weeklyGoal(profile, levers), goalFill, goalLabel);
      audio.play('clear', Math.min(6, Number(payload.combo ?? 1)));
      haptics.fire('clear');
      break;
    }

    case 'combo': {
      const combo = Number(payload.combo ?? 0);
      telemetry.log('combo', payload);
      if (combo >= 2) {
        audio.play('combo', Math.min(6, combo));
        haptics.fire('combo');
        pushFx({
          kind: 'combo',
          startedAt: performance.now(),
          durationMs: 760,
          text: `${combo}x`,
          anchor: { r: SIZE / 2 - 1, c: SIZE / 2 - 0.5 },
        });
      }
      break;
    }

    case 'surge':
      telemetry.log('surge', payload);
      audio.play('surge');
      haptics.fire('surge');
      ui.toast(`Pressure overflowed — ${payload.ballast} ballast tiles`);
      break;

    case 'game_over':
      telemetry.log('game_over', payload);
      audio.play('gameover');
      haptics.fire('gameover');
      clearResume(storage);
      void handleGameOver();
      break;

    default:
      break;
  }
});

// ───────────────────────── boot ─────────────────────────

function boot(): void {
  syncHud();
  renderGoal(weeklyGoal(profile, levers), goalFill, goalLabel);
  renderer.resize();

  if (debugRequested()) void openDebug();

  const resume = loadResume(storage, levers, Date.now());
  if (resume) {
    // Lever 3: name the specific unfinished thing, then offer to close it.
    ui.sheet({
      title: 'Still unfinished',
      body: resumeMessage(resume, levers),
      buttons: [
        {
          label: 'Pick it back up',
          sub: `${resume.score} points on the board`,
          onClick: () => startGame(resume),
        },
        { label: 'Start fresh instead', kind: 'secondary', onClick: () => startGame(null) },
      ],
    });
  } else {
    ui.sheet({
      title: 'Overflow Grid',
      body:
        'Drop pieces to fill rows and columns. Every placement raises the pressure meter — clearing lines is the only way to vent it. Let it overflow and the board fills with ballast.',
      buttons: [
        { label: 'Play', onClick: () => startGame(null) },
        {
          label: profile.bestScore > 0 ? `Your best: ${profile.bestScore.toLocaleString()}` : 'How it works',
          kind: 'ghost',
          onClick: () => startGame(null),
        },
      ],
    });
  }

  requestAnimationFrame(frame);
}

function startGame(resume: Parameters<Game['start']>[0]): void {
  audio.unlock();
  const banked = profile.bankedVentCharge;
  if (banked > 0) {
    profile = { ...profile, bankedVentCharge: 0 };
    saveProfile(profile, storage);
    ui.toast('Vent charge spent — meter starts empty');
  }
  game.start(resume ?? null, banked);
  fx = [];
  syncHud();
}

// ───────────────────────── game over flow ─────────────────────────

async function handleGameOver(): Promise<void> {
  const finalScore = game.score;
  const beatBest = finalScore > profile.bestScore;

  profile = recordScore(profile, finalScore, levers);

  // Lever 5: the streak advances on a completed game, once per day.
  const streak = advanceStreak(profile, levers, Date.now());
  profile = streak.profile;
  if (streak.advanced) {
    telemetry.log('streak_day', { days: profile.streakDays, graceUsed: streak.graceUsed });
  }
  saveProfile(profile, storage);
  syncHud();

  // Lever 4: ONE opt-in rescue, only if the run was worth rescuing.
  const gate = ads.canOfferContinue(finalScore);
  if (gate.allowed) {
    ads.noteContinueOffered();
    ui.sheet({
      title: 'Out of moves',
      body: `Watch one rewarded ad to dissolve ${levers.continueClearsRandomPieces} pieces and vent some pressure, and keep this run going. One offer per game.`,
      stats: [
        { value: finalScore.toLocaleString(), label: 'score' },
        { value: String(game.comboPeak), label: 'best combo' },
        { value: String(game.linesClearedTotal), label: 'lines' },
      ],
      buttons: [
        {
          label: 'Watch ad and continue',
          sub: `dissolves ${levers.continueClearsRandomPieces} pieces · no purchase`,
          onClick: () => void takeContinue(),
        },
        { label: 'No thanks, end the run', kind: 'secondary', onClick: () => void showGameOverSheet(beatBest) },
      ],
    });
    return;
  }

  await showGameOverSheet(beatBest);
}

async function takeContinue(): Promise<void> {
  const result = await ads.showContinueAd();
  if (result.outcome === 'rewarded') {
    const applied = game.applyContinue();
    if (applied.ok) {
      audio.play('reward');
      haptics.fire('reward');
      pushFx({ kind: 'clear', startedAt: performance.now(), durationMs: levers.clearAnimationMs * 2, cells: applied.dissolved });
      ui.toast(`${applied.dissolved.length} cells dissolved — keep going`);
      syncHud();
      return;
    }
    ui.toast('Board was still blocked — run ended');
  } else if (result.outcome === 'no_fill') {
    ui.toast('No ad available right now — no harm done');
  }
  await showGameOverSheet(game.score > profile.bestScore);
}

async function showGameOverSheet(beatBest: boolean): Promise<void> {
  ads.onGameEnd();
  const finalScore = game.score;
  const chestGate = ads.canOfferChest();

  const buttons: SheetButton[] = [
    {
      label: 'Play again',
      onClick: () => void playAgain(),
    },
  ];

  if (chestGate.allowed) {
    // Lever 6: variable reward, honest odds, opt-in only.
    buttons.push({
      label: 'Open a chest',
      onClick: () => openChestSheet(),
    });
  }

  ui.sheet({
    title: beatBest ? 'New personal best' : 'Out of moves',
    body: beatBest
      ? 'That is your highest score on this device.'
      : profile.bestScore > finalScore
        ? `${(profile.bestScore - finalScore).toLocaleString()} short of your best.`
        : 'Close one.',
    stats: [
      { value: finalScore.toLocaleString(), label: 'score' },
      { value: String(game.comboPeak), label: 'best combo' },
      { value: String(profile.streakDays), label: 'day streak' },
    ],
    html: ui.leaderboardHtml(profile, finalScore),
    buttons,
  });
}

function openChestSheet(): void {
  ads.noteChestOffered();
  ui.sheet({
    title: 'Chest',
    body: 'One rewarded ad, one item from this table. These are the real odds.',
    html: ui.lootTableHtml(),
    buttons: [
      {
        label: 'Watch ad and open',
        sub: 'cosmetics and small boosts only',
        onClick: () => void takeChest(),
      },
      { label: 'Skip the chest', kind: 'secondary', onClick: () => void showGameOverSheet(false) },
    ],
  });
}

async function takeChest(): Promise<void> {
  const result = await ads.showChestAd();
  if (result.outcome !== 'rewarded') {
    if (result.outcome === 'no_fill') ui.toast('No ad available right now — no harm done');
    await showGameOverSheet(false);
    return;
  }

  const loot = rollChest(uiRng);
  audio.play('reward');
  haptics.fire('reward');

  if (loot.kind === 'vent-charge') {
    profile = { ...profile, bankedVentCharge: profile.bankedVentCharge + 1 };
  } else if (loot.kind === 'cosmetic') {
    if (!profile.unlocked.includes(loot.id)) profile = { ...profile, unlocked: [...profile.unlocked, loot.id] };
  } else if (loot.kind === 'clear-ballast') {
    game.dissolveBallast(2);
  }
  saveProfile(profile, storage);
  ui.toast(`Chest: ${loot.label}`);
  await showGameOverSheet(false);
}

async function playAgain(): Promise<void> {
  // The interstitial sits BETWEEN games — the end of one task, not the middle
  // of one — and is capped by AdManager. If it is capped we simply play on.
  await ads.maybeShowInterstitial();
  startGame(null);
}

// ───────────────────────── hud ─────────────────────────

function syncHud(): void {
  scoreEl.textContent = game.score.toLocaleString();
  bestEl.textContent = levers.showPersonalBestTarget
    ? `best ${profile.bestScore.toLocaleString()}`
    : '';
  streakEl.textContent = String(profile.streakDays);
  muteIcon.textContent = audio.isMuted ? 'off' : 'on';
  const combo = game.combo;
  comboBadge.textContent = `${combo}x combo`;
  comboBadge.classList.toggle('hidden', combo < 2);
}

function persistResume(): void {
  if (game.status !== 'playing' || game.placements === 0) return;
  saveResume(game.snapshot(), storage);
}

// ───────────────────────── input ─────────────────────────

function localPoint(event: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

/** Where the dragged piece's origin cell lands, given the pointer position. */
function dragTarget(x: number, y: number, piece: DragState['piece']): { r: number; c: number } {
  const l = renderer.layout;
  const { rows, cols } = pieceSize(piece);
  const cx = x;
  const cy = y - l.cell * 1.1; // lift above the finger
  const topX = cx - (cols * l.cell) / 2;
  const topY = cy - (rows * l.cell) / 2;
  return {
    r: Math.round((topY - l.boardY) / l.cell),
    c: Math.round((topX - l.boardX) / l.cell),
  };
}

function refreshDrag(x: number, y: number): void {
  if (!drag) return;
  drag.x = x;
  drag.y = y;
  const guess = dragTarget(x, y, drag.piece);
  const inRange = guess.r > -2 && guess.c > -2 && guess.r < SIZE + 1 && guess.c < SIZE + 1;
  if (!inRange) {
    drag.target = null;
    drag.valid = false;
    drag.previewRows = [];
    drag.previewCols = [];
    return;
  }
  drag.target = guess;
  drag.valid = game.canPlaceAt(drag.trayIndex, guess.r, guess.c);
  const preview = drag.valid
    ? game.previewClear(drag.trayIndex, guess.r, guess.c)
    : { rows: [], cols: [] };
  drag.previewRows = preview.rows;
  drag.previewCols = preview.cols;
}

canvas.addEventListener('pointerdown', (event) => {
  if (ui.isSheetOpen || debugOpen || game.status !== 'playing') return;
  const { x, y } = localPoint(event);
  const slot = renderer.pointToTraySlot(x, y);
  if (slot < 0) return;
  const piece = game.tray[slot];
  if (!piece) return;
  canvas.setPointerCapture(event.pointerId);
  audio.unlock();
  audio.play('tap');
  drag = {
    piece,
    trayIndex: slot,
    x,
    y,
    target: null,
    valid: false,
    previewRows: [],
    previewCols: [],
  };
  refreshDrag(x, y);
  event.preventDefault();
});

canvas.addEventListener('pointermove', (event) => {
  if (!drag) return;
  const { x, y } = localPoint(event);
  refreshDrag(x, y);
  event.preventDefault();
});

function endDrag(event: PointerEvent): void {
  if (!drag) return;
  const current = drag;
  drag = null;
  try {
    canvas.releasePointerCapture(event.pointerId);
  } catch {
    /* already released */
  }

  if (!current.target || !current.valid) {
    return;
  }

  const outcome = game.place(current.trayIndex, current.target.r, current.target.c);
  if (!outcome.ok) return;

  audio.play('place', Math.min(6, outcome.combo));
  haptics.fire('place');

  if (outcome.cleared.length > 0) {
    pushFx({
      kind: 'clear',
      startedAt: performance.now(),
      durationMs: levers.clearAnimationMs,
      cells: outcome.cleared,
    });
    pushFx({
      kind: 'text',
      startedAt: performance.now(),
      durationMs: 700,
      text: `+${outcome.scoreGained}`,
      anchor: { r: current.target.r, c: current.target.c },
    });
  }

  if (outcome.surgeCells.length > 0) {
    pushFx({
      kind: 'surge',
      startedAt: performance.now(),
      durationMs: 520,
      cells: outcome.surgeCells,
    });
  }

  syncHud();
  persistResume();
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', (event) => {
  drag = null;
  try {
    canvas.releasePointerCapture(event.pointerId);
  } catch {
    /* ignore */
  }
});

// ───────────────────────── chrome buttons ─────────────────────────

(document.getElementById('mute') as HTMLElement).addEventListener('click', () => {
  const muted = !audio.isMuted;
  audio.setMuted(muted);
  profile = { ...profile, muted };
  saveProfile(profile, storage);
  telemetry.log('mute_toggle', { muted });
  syncHud();
  if (!muted) audio.play('tap');
});

(document.getElementById('streak') as HTMLElement).addEventListener('click', () => {
  const goal = weeklyGoal(profile, levers);
  ui.sheet({
    title: `${profile.streakDays}-day streak`,
    body: `Play one game a day to keep it. A single missed day is forgiven ${levers.streakGraceDays === 1 ? 'once' : `${levers.streakGraceDays} times`}.`,
    stats: [
      { value: String(profile.streakDays), label: 'streak' },
      { value: `${goal.granted + goal.earned}/${goal.target}`, label: 'weekly goal' },
      { value: String(profile.totalClears), label: 'total clears' },
    ],
    buttons: [{ label: 'Back', kind: 'secondary', onClick: () => {} }],
  });
});

(document.getElementById('menu') as HTMLElement).addEventListener('click', () => {
  ui.sheet({
    title: 'Overflow Grid',
    body:
      'No accounts, no tracking, no data leaves this device. Scores and streaks are stored locally. Rewarded ads are always optional.',
    buttons: [
      { label: 'Back to the board', onClick: () => {} },
      {
        label: audio.isMuted ? 'Sound: off' : 'Sound: on',
        kind: 'secondary',
        onClick: () => (document.getElementById('mute') as HTMLElement).click(),
      },
      { label: 'Open /debug', kind: 'ghost', onClick: () => void openDebug() },
    ],
  });
});

// hidden entry: five taps on the score
scoreEl.addEventListener('click', () => {
  const now = performance.now();
  scoreTaps = now - scoreTapAt < 600 ? scoreTaps + 1 : 1;
  scoreTapAt = now;
  if (scoreTaps >= 5) {
    scoreTaps = 0;
    void openDebug();
  }
});

async function openDebug(): Promise<void> {
  debugOpen = true;
  await openDebugPanel({
    telemetry,
    levers,
    onClose: () => {
      debugOpen = false;
    },
  });
}

// ───────────────────────── frame loop ─────────────────────────

function pushFx(entry: Fx): void {
  fx.push(entry);
  if (fx.length > 48) fx = fx.slice(-48);
}

let lastResizeW = 0;
let lastResizeH = 0;

function frame(now: number): void {
  if (stage.clientWidth !== lastResizeW || stage.clientHeight !== lastResizeH) {
    lastResizeW = stage.clientWidth;
    lastResizeH = stage.clientHeight;
    renderer.resize();
    if (drag) refreshDrag(drag.x, drag.y);
  }

  fx = fx.filter((entry) => now - entry.startedAt <= entry.durationMs);
  const nearMiss = game.status === 'playing' ? game.nearMiss() : { rows: [], cols: [] };

  renderer.draw({
    board: game.board,
    tray: game.tray,
    pressureRatio: game.pressureRatio(),
    pressureWarning: game.pressureRatio() > 0.75,
    combo: game.combo,
    nearMissRows: nearMiss.rows,
    nearMissCols: nearMiss.cols,
    drag,
    fx,
    now,
    dimmed: game.status !== 'playing' || ui.isSheetOpen,
  });

  requestAnimationFrame(frame);
}

function safeStorage(): Storage | null {
  try {
    const probe = '__og__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

// ───────────────────────── PWA ─────────────────────────

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      /* offline support is a bonus, never a blocker */
    });
  });
}

boot();
