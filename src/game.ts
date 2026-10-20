/**
 * game.ts — the engine. Deliberately headless: no DOM, no canvas, no storage.
 * The UI observes it through events and reads its public fields. This is what
 * lets every rule (bias, ramp, pressure, caps) be unit-tested without a browser.
 */

import {
  BALLAST,
  EMPTY,
  SIZE,
  applySurge,
  clearLines,
  createBoard,
  findFullLines,
  hasAnyPlacement,
  idx,
  canPlace,
  lineDeficits,
  nearMissLines,
  occupancy,
  writePiece,
  type Board,
} from './board.js';
import { createSkillTracker, recordClears, updateSkill, type SkillTracker } from './difficulty.js';
import { drawTray, type DrawnPiece, type GenContext } from './generator.js';
import type { Levers } from './levers.js';
import { PIECES_BY_ID, type Cell, type Piece } from './pieces.js';
import {
  applyGain,
  applyVent,
  createPressure,
  isOverflowing,
  pressureRatio,
  resetAfterSurge,
  surgeBallastCount,
  type PressureState,
} from './pressure.js';
import type { ResumeState } from './progress.js';
import { makeRng, type Rng } from './rng.js';

export type GameStatus = 'idle' | 'playing' | 'gameover';

/** A placed piece, tracked as a group so the rewarded "continue" can dissolve whole pieces. */
interface Group {
  kind: 'piece' | 'ballast';
  cells: number[];
}

export interface PlaceOutcome {
  ok: boolean;
  reason?: 'illegal' | 'not-playing' | 'empty-slot';
  scoreGained: number;
  linesCleared: number;
  cellsCleared: number;
  ballastCleared: number;
  cleared: Cell[];
  /** which rows/cols cleared — the renderer draws one shock ring per line */
  rows: number[];
  cols: number[];
  combo: number;
  surged: boolean;
  surgeCells: Cell[];
  trayRefilled: boolean;
  gameOver: boolean;
}

export type GameEventName =
  | 'game_start'
  | 'placed'
  | 'clear'
  | 'combo'
  | 'surge'
  | 'tray_refill'
  | 'game_over'
  | 'continue_used';

export interface GameEventPayload {
  [key: string]: unknown;
}

type Listener = (name: GameEventName, payload: GameEventPayload) => void;

export interface GameOptions {
  levers: Levers;
  seed?: number;
  now?: () => number;
}

export class Game {
  readonly levers: Levers;
  board: Board = createBoard();
  tray: (Piece | null)[] = [null, null, null];
  trayReasons: DrawnPiece['reason'][] = ['random', 'random', 'random'];
  status: GameStatus = 'idle';
  score = 0;
  combo = 0;
  comboPeak = 0;
  placements = 0;
  clearEvents = 0;
  linesClearedTotal = 0;
  pressure: PressureState = createPressure();
  skill: SkillTracker;
  /** true once the rewarded continue has been used this game */
  continueUsed = false;

  private readonly rng: Rng;
  private readonly now: () => number;
  private comboMisses = 0;
  private groups: Group[] = [];
  private listeners: Listener[] = [];

  constructor(options: GameOptions) {
    this.levers = options.levers;
    this.now = options.now ?? (() => Date.now());
    this.rng = makeRng(options.seed ?? (Date.now() & 0x7fffffff));
    this.skill = createSkillTracker(this.now());
  }

  on(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(name: GameEventName, payload: GameEventPayload = {}): void {
    for (const listener of this.listeners) listener(name, payload);
  }

  // ───────────────────────── lifecycle ─────────────────────────

  /** Start a fresh game, or resume a saved board (lever 3). */
  start(resume?: ResumeState | null, bankedVentCharge = 0): void {
    this.board = createBoard();
    this.score = 0;
    this.combo = 0;
    this.comboPeak = 0;
    this.comboMisses = 0;
    this.placements = 0;
    this.clearEvents = 0;
    this.linesClearedTotal = 0;
    this.continueUsed = false;
    this.pressure = createPressure();
    this.skill = createSkillTracker(this.now());
    this.groups = [];

    let resumed = false;
    if (resume && resume.cells.length === SIZE * SIZE) {
      for (let i = 0; i < resume.cells.length; i++) {
        this.board.cells[i] = resume.cells[i]!;
      }
      // cells restored from a save are not attributed to groups; a continue on a
      // resumed board therefore dissolves ballast and later pieces only.
      this.rebuildBallastGroups();
      this.pressure.value = resume.pressure;
      this.score = resume.score;
      this.combo = resume.combo;
      this.comboPeak = resume.comboPeak;
      this.placements = resume.placements;
      const restored = resume.tray
        .map((id) => PIECES_BY_ID[id] ?? null)
        .filter((p): p is Piece => p !== null);
      if (restored.length > 0) {
        this.tray = [restored[0] ?? null, restored[1] ?? null, restored[2] ?? null];
        resumed = true;
      }
    }

    if (bankedVentCharge > 0) this.pressure.value = 0;

    this.status = 'playing';
    if (!resumed) this.refillTray(true);
    this.emit('game_start', { resumed, bankedVentCharge });
  }

  private rebuildBallastGroups(): void {
    const cells: number[] = [];
    for (let i = 0; i < this.board.cells.length; i++) {
      if (this.board.cells[i] === BALLAST) cells.push(i);
    }
    // one group per ballast tile, so a continue dissolves them individually
    this.groups = cells.map((i) => ({ kind: 'ballast' as const, cells: [i] }));
  }

  private genContext(): GenContext {
    return {
      placements: this.placements,
      skill: this.skill.skill,
      combo: this.combo,
      guaranteedClearsRemaining: Math.max(
        0,
        this.levers.assistGuaranteedClearsAtStart - this.clearEvents,
      ),
    };
  }

  private refillTray(silent = false): void {
    const drawn = drawTray(this.board, this.levers, this.rng, this.genContext(), 3);
    this.tray = drawn.map((d) => d.piece);
    this.trayReasons = drawn.map((d) => d.reason);
    if (!silent) {
      this.emit('tray_refill', { reasons: this.trayReasons.slice() });
    }
  }

  // ───────────────────────── placement ─────────────────────────

  canPlaceAt(trayIndex: number, r: number, c: number): boolean {
    const piece = this.tray[trayIndex];
    if (!piece || this.status !== 'playing') return false;
    return canPlace(this.board, piece, r, c);
  }

  /** Which rows/cols would clear if `trayIndex` were dropped at (r, c). */
  previewClear(trayIndex: number, r: number, c: number): { rows: number[]; cols: number[] } {
    const piece = this.tray[trayIndex];
    if (!piece || !canPlace(this.board, piece, r, c)) return { rows: [], cols: [] };
    const deficits = lineDeficits(this.board);
    const addedRow = new Array<number>(SIZE).fill(0);
    const addedCol = new Array<number>(SIZE).fill(0);
    for (const cell of piece.cells) {
      addedRow[r + cell.r]!++;
      addedCol[c + cell.c]!++;
    }
    return {
      rows: addedRow.flatMap((n, i) => (n > 0 && deficits.rows[i] === n ? [i] : [])),
      cols: addedCol.flatMap((n, i) => (n > 0 && deficits.cols[i] === n ? [i] : [])),
    };
  }

  place(trayIndex: number, r: number, c: number): PlaceOutcome {
    const base: PlaceOutcome = {
      ok: false,
      scoreGained: 0,
      linesCleared: 0,
      cellsCleared: 0,
      ballastCleared: 0,
      cleared: [],
      rows: [],
      cols: [],
      combo: this.combo,
      surged: false,
      surgeCells: [],
      trayRefilled: false,
      gameOver: false,
    };

    if (this.status !== 'playing') return { ...base, reason: 'not-playing' };
    const piece = this.tray[trayIndex];
    if (!piece) return { ...base, reason: 'empty-slot' };
    if (!canPlace(this.board, piece, r, c)) return { ...base, reason: 'illegal' };

    const now = this.now();

    // 1. write the piece and record it as a dissolvable group
    writePiece(this.board, piece, r, c);
    this.groups.push({
      kind: 'piece',
      cells: piece.cells.map((cell) => idx(r + cell.r, c + cell.c)),
    });
    this.tray[trayIndex] = null;
    this.placements++;

    let scoreGained = piece.cells.length;

    // 2. pressure rises with every placement, scaled by how full the board is
    applyGain(this.pressure, this.levers, occupancy(this.board));

    // 3. clears
    const lines = findFullLines(this.board);
    const lineCount = lines.rows.length + lines.cols.length;
    let clearResult = {
      cellsCleared: 0,
      ballastCleared: 0,
      cleared: [] as Cell[],
    };

    if (lineCount > 0) {
      const result = clearLines(this.board, lines);
      clearResult = result;
      this.pruneGroups(result.cleared);

      // scoring: escalation lives in the combo multiplier
      const multiplier = 1 + this.combo * this.levers.comboScoreStep;
      scoreGained += Math.round(
        (result.cellsCleared * 10 + result.ballastCleared * 15 + (lineCount - 1) * 40) * multiplier,
      );

      // 4. venting — the clear is relief, not just reward
      applyVent(this.pressure, this.levers, lineCount, result.ballastCleared);

      this.combo++;
      this.comboMisses = 0;
      this.comboPeak = Math.max(this.comboPeak, this.combo);
      this.clearEvents++;
      this.linesClearedTotal += lineCount;
      recordClears(this.skill, lineCount, now);

      this.emit('clear', {
        lines: lineCount,
        cells: result.cellsCleared,
        ballast: result.ballastCleared,
        combo: this.combo,
      });
      if (this.combo >= 2) this.emit('combo', { combo: this.combo });
    } else {
      this.comboMisses++;
      if (this.comboMisses >= this.levers.comboDecayPlacements) {
        this.combo = 0;
        this.comboMisses = 0;
      }
    }

    this.score += scoreGained;

    // 5. flow curve: re-estimate skill from measured clears/min
    updateSkill(this.skill, this.levers, now);

    // 6. surge if the meter filled
    let surged = false;
    let surgeCells: Cell[] = [];
    if (isOverflowing(this.pressure, this.levers)) {
      const count = surgeBallastCount(this.levers, this.skill.skill);
      surgeCells = applySurge(this.board, count, this.rng, this.levers.surgeFillsFromBottom);
      for (const cell of surgeCells) {
        this.groups.push({ kind: 'ballast', cells: [idx(cell.r, cell.c)] });
      }
      resetAfterSurge(this.pressure, this.levers);
      surged = true;
      this.emit('surge', { ballast: surgeCells.length, skill: this.skill.skill });
    }

    // 7. refill when the tray is spent
    let trayRefilled = false;
    if (this.tray.every((p) => p === null)) {
      this.refillTray();
      trayRefilled = true;
    }

    this.emit('placed', { pieceId: piece.id, score: this.score, placements: this.placements });

    // 8. death check
    const gameOver = this.isDead();
    if (gameOver) this.endGame();

    return {
      ok: true,
      scoreGained,
      linesCleared: lineCount,
      cellsCleared: clearResult.cellsCleared,
      ballastCleared: clearResult.ballastCleared,
      cleared: clearResult.cleared,
      rows: lines.rows.slice(),
      cols: lines.cols.slice(),
      combo: this.combo,
      surged,
      surgeCells,
      trayRefilled,
      gameOver,
    };
  }

  private pruneGroups(cleared: readonly Cell[]): void {
    const gone = new Set(cleared.map((cell) => idx(cell.r, cell.c)));
    this.groups = this.groups
      .map((group) => ({ ...group, cells: group.cells.filter((i) => !gone.has(i)) }))
      .filter((group) => group.cells.length > 0);
  }

  isDead(): boolean {
    const remaining = this.tray.filter((p): p is Piece => p !== null);
    if (remaining.length === 0) return false;
    return !hasAnyPlacement(this.board, remaining);
  }

  private endGame(): void {
    this.status = 'gameover';
    this.emit('game_over', {
      score: this.score,
      placements: this.placements,
      lines: this.linesClearedTotal,
      comboPeak: this.comboPeak,
      surges: this.pressure.surges,
      skill: this.skill.skill,
    });
  }

  // ───────────────────────── lever 4: the continue ─────────────────────────

  /**
   * Dissolve N randomly chosen placed pieces (ballast tiles included, since
   * ballast is what actually kills a board) and relieve pressure, then resume.
   * Called ONLY after a rewarded ad has reported a reward, and only once per
   * game — the cap is enforced in AdManager, and asserted again here.
   */
  applyContinue(): { dissolved: Cell[]; ok: boolean } {
    if (this.continueUsed || this.status !== 'gameover') return { dissolved: [], ok: false };

    const want = Math.max(0, this.levers.continueClearsRandomPieces);
    const picks = this.rng.shuffled(this.groups).slice(0, want);
    const dissolved: Cell[] = [];
    for (const group of picks) {
      for (const i of group.cells) {
        this.board.cells[i] = EMPTY;
        dissolved.push({ r: Math.floor(i / SIZE), c: i % SIZE });
      }
    }
    const removed = new Set(picks);
    this.groups = this.groups.filter((group) => !removed.has(group));

    this.pressure.value = Math.max(0, this.pressure.value - this.levers.continuePressureRelief);
    this.continueUsed = true;

    // If the board is somehow still dead, refill the tray rather than hand the
    // player an ad they got nothing for.
    if (this.isDead()) this.refillTray(true);

    this.status = this.isDead() ? 'gameover' : 'playing';
    this.emit('continue_used', { dissolved: dissolved.length, ok: this.status === 'playing' });
    return { dissolved, ok: this.status === 'playing' };
  }

  /** Dissolve up to `count` ballast tiles — a chest reward. */
  dissolveBallast(count: number): Cell[] {
    const out: Cell[] = [];
    const ballastGroups = this.groups.filter((g) => g.kind === 'ballast');
    for (const group of this.rng.shuffled(ballastGroups).slice(0, count)) {
      for (const i of group.cells) {
        if (this.board.cells[i] !== BALLAST) continue;
        this.board.cells[i] = EMPTY;
        out.push({ r: Math.floor(i / SIZE), c: i % SIZE });
      }
    }
    const removed = new Set(this.groups.filter((g) => g.kind === 'ballast').slice(0, count));
    this.groups = this.groups.filter((g) => !removed.has(g));
    return out;
  }

  ventFully(): void {
    this.pressure.value = 0;
  }

  // ───────────────────────── views ─────────────────────────

  pressureRatio(): number {
    return pressureRatio(this.pressure, this.levers);
  }

  nearMiss(): { rows: number[]; cols: number[] } {
    return nearMissLines(this.board, this.levers.nearMissHighlightThreshold);
  }

  /** Lever 3: the snapshot that makes a session resumable. */
  snapshot(): ResumeState {
    const deficits = lineDeficits(this.board);
    const nonZero = [...deficits.rows, ...deficits.cols].filter((d) => d > 0);
    return {
      cells: [...this.board.cells],
      pressure: this.pressure.value,
      score: this.score,
      combo: this.combo,
      comboPeak: this.comboPeak,
      placements: this.placements,
      tray: this.tray.filter((p): p is Piece => p !== null).map((p) => p.id),
      savedAt: this.now(),
      closestLineDeficit: nonZero.length > 0 ? Math.min(...nonZero) : 0,
    };
  }
}
