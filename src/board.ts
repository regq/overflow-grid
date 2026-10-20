/**
 * board.ts — the 8x8 grid: placement legality, line detection, clearing, surges.
 * Pure data + pure functions so every rule is unit-testable without a canvas.
 */

import type { Cell, Piece } from './pieces.js';
import type { Rng } from './rng.js';

export const SIZE = 8;

/** 0 = empty; 1..6 = a placed block (hue + 1); BALLAST = surge-injected obstruction. */
export const EMPTY = 0;
export const BALLAST = 9;

export interface Board {
  /** row-major, length SIZE*SIZE */
  cells: Int8Array;
}

export function createBoard(): Board {
  return { cells: new Int8Array(SIZE * SIZE) };
}

export function cloneBoard(board: Board): Board {
  return { cells: new Int8Array(board.cells) };
}

export const idx = (r: number, c: number): number => r * SIZE + c;

export function at(board: Board, r: number, c: number): number {
  if (r < 0 || c < 0 || r >= SIZE || c >= SIZE) return -1;
  return board.cells[idx(r, c)]!;
}

/** Can `piece` sit with its origin cell at (r, c)? */
export function canPlace(board: Board, piece: Piece, r: number, c: number): boolean {
  for (const cell of piece.cells) {
    const rr = r + cell.r;
    const cc = c + cell.c;
    if (rr < 0 || cc < 0 || rr >= SIZE || cc >= SIZE) return false;
    if (board.cells[idx(rr, cc)] !== EMPTY) return false;
  }
  return true;
}

/** Every legal origin for `piece` on `board`. */
export function legalPlacements(board: Board, piece: Piece): Cell[] {
  const out: Cell[] = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (canPlace(board, piece, r, c)) out.push({ r, c });
    }
  }
  return out;
}

export function hasAnyPlacement(board: Board, pieces: readonly Piece[]): boolean {
  return pieces.some((piece) => legalPlacements(board, piece).length > 0);
}

/** Write a piece into the grid. Caller must have checked `canPlace`. */
export function writePiece(board: Board, piece: Piece, r: number, c: number): void {
  const value = (piece.hue % 6) + 1;
  for (const cell of piece.cells) {
    board.cells[idx(r + cell.r, c + cell.c)] = value;
  }
}

export interface FullLines {
  rows: number[];
  cols: number[];
}

export function findFullLines(board: Board): FullLines {
  const rows: number[] = [];
  const cols: number[] = [];
  for (let r = 0; r < SIZE; r++) {
    let full = true;
    for (let c = 0; c < SIZE; c++) {
      if (board.cells[idx(r, c)] === EMPTY) {
        full = false;
        break;
      }
    }
    if (full) rows.push(r);
  }
  for (let c = 0; c < SIZE; c++) {
    let full = true;
    for (let r = 0; r < SIZE; r++) {
      if (board.cells[idx(r, c)] === EMPTY) {
        full = false;
        break;
      }
    }
    if (full) cols.push(c);
  }
  return { rows, cols };
}

export interface ClearResult {
  rows: number[];
  cols: number[];
  /** distinct cells emptied (a row/col intersection is counted once) */
  cellsCleared: number;
  /** how many of those cells were ballast — drives the extra vent reward */
  ballastCleared: number;
  /** the emptied coordinates, for the clear animation */
  cleared: Cell[];
}

/** Empty the given rows and columns. Intersections are handled once. */
export function clearLines(board: Board, lines: FullLines): ClearResult {
  const marked = new Set<number>();
  for (const r of lines.rows) {
    for (let c = 0; c < SIZE; c++) marked.add(idx(r, c));
  }
  for (const c of lines.cols) {
    for (let r = 0; r < SIZE; r++) marked.add(idx(r, c));
  }

  let ballastCleared = 0;
  const cleared: Cell[] = [];
  for (const i of marked) {
    if (board.cells[i] === BALLAST) ballastCleared++;
    cleared.push({ r: Math.floor(i / SIZE), c: i % SIZE });
    board.cells[i] = EMPTY;
  }

  return {
    rows: lines.rows.slice(),
    cols: lines.cols.slice(),
    cellsCleared: marked.size,
    ballastCleared,
    cleared,
  };
}

export function occupiedCount(board: Board): number {
  let n = 0;
  for (let i = 0; i < board.cells.length; i++) if (board.cells[i] !== EMPTY) n++;
  return n;
}

/** 0..1 — how full the board is. Feeds the pressure curve. */
export function occupancy(board: Board): number {
  return occupiedCount(board) / (SIZE * SIZE);
}

/**
 * How many cells each row/column is short of being full.
 * Used to surface near-misses and to steer the generator.
 */
export function lineDeficits(board: Board): { rows: number[]; cols: number[] } {
  const rows = new Array<number>(SIZE).fill(0);
  const cols = new Array<number>(SIZE).fill(0);
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board.cells[idx(r, c)] === EMPTY) {
        rows[r]!++;
        cols[c]!++;
      }
    }
  }
  return { rows, cols };
}

/** Rows/cols that are exactly `threshold` cells short — the near-miss highlight set. */
export function nearMissLines(board: Board, threshold: number): FullLines {
  const { rows, cols } = lineDeficits(board);
  return {
    rows: rows.flatMap((d, r) => (d > 0 && d <= threshold ? [r] : [])),
    cols: cols.flatMap((d, c) => (d > 0 && d <= threshold ? [c] : [])),
  };
}

/**
 * Inject `count` ballast tiles — the visible consequence of letting pressure fill.
 * Fills from the bottom row upward when `fromBottom`, so the threat is legible
 * and spatially predictable rather than arbitrary.
 */
export function applySurge(board: Board, count: number, rng: Rng, fromBottom: boolean): Cell[] {
  const placed: Cell[] = [];
  const deficits = lineDeficits(board);
  const rowOrder = fromBottom
    ? Array.from({ length: SIZE }, (_, i) => SIZE - 1 - i)
    : Array.from({ length: SIZE }, (_, i) => i);

  for (const r of rowOrder) {
    if (placed.length >= count) break;
    const freeCols = rng.shuffled(
      Array.from({ length: SIZE }, (_, c) => c).filter((c) => board.cells[idx(r, c)] === EMPTY),
    );
    for (const c of freeCols) {
      if (placed.length >= count) break;
      // A surge can bury the player, but it must never COMPLETE a line: that
      // would either hand out an unearned clear or leave a full line sitting
      // on the board until the next placement. Skip any cell that is the last
      // empty one in its row or its column.
      if (deficits.rows[r] === 1 || deficits.cols[c] === 1) continue;
      board.cells[idx(r, c)] = BALLAST;
      deficits.rows[r]!--;
      deficits.cols[c]!--;
      placed.push({ r, c });
    }
  }
  return placed;
}
