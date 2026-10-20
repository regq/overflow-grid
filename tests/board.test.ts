import { describe, expect, it } from 'vitest';
import {
  BALLAST,
  EMPTY,
  SIZE,
  applySurge,
  canPlace,
  clearLines,
  createBoard,
  findFullLines,
  hasAnyPlacement,
  idx,
  lineDeficits,
  nearMissLines,
  occupancy,
  writePiece,
} from '../src/board.js';
import { PIECES_BY_ID } from '../src/pieces.js';
import { makeRng } from '../src/rng.js';

function fillRow(board: ReturnType<typeof createBoard>, r: number, except: number[] = []): void {
  for (let c = 0; c < SIZE; c++) {
    if (!except.includes(c)) board.cells[idx(r, c)] = 1;
  }
}

function fillCol(board: ReturnType<typeof createBoard>, c: number, except: number[] = []): void {
  for (let r = 0; r < SIZE; r++) {
    if (!except.includes(r)) board.cells[idx(r, c)] = 2;
  }
}

describe('placement legality', () => {
  it('rejects a piece that would leave the grid', () => {
    const board = createBoard();
    const bar = PIECES_BY_ID['bar5-h']!;
    expect(canPlace(board, bar, 0, 0)).toBe(true);
    expect(canPlace(board, bar, 0, 4)).toBe(false);
    expect(canPlace(board, bar, 0, -1)).toBe(false);
  });

  it('rejects a piece that would overlap an occupied cell', () => {
    const board = createBoard();
    board.cells[idx(3, 3)] = 1;
    const quad = PIECES_BY_ID['quad']!;
    // (3,3) and (2,2) both cover the occupied cell
    expect(canPlace(board, quad, 3, 3)).toBe(false);
    expect(canPlace(board, quad, 2, 2)).toBe(false);
    // (3,4) covers (3,4)(3,5)(4,4)(4,5) — clear of it
    expect(canPlace(board, quad, 3, 4)).toBe(true);
    expect(canPlace(board, quad, 5, 5)).toBe(true);
  });

  it('detects a dead board', () => {
    const board = createBoard();
    board.cells.fill(1);
    expect(hasAnyPlacement(board, [PIECES_BY_ID['dot']!])).toBe(false);
    board.cells[idx(7, 7)] = EMPTY;
    expect(hasAnyPlacement(board, [PIECES_BY_ID['dot']!])).toBe(true);
    expect(hasAnyPlacement(board, [PIECES_BY_ID['duo-h']!])).toBe(false);
  });
});

describe('line clears', () => {
  it('clears a full row and nothing else', () => {
    const board = createBoard();
    fillRow(board, 2);
    const lines = findFullLines(board);
    expect(lines.rows).toEqual([2]);
    expect(lines.cols).toEqual([]);

    const result = clearLines(board, lines);
    expect(result.cellsCleared).toBe(SIZE);
    for (let c = 0; c < SIZE; c++) expect(board.cells[idx(2, c)]).toBe(EMPTY);
  });

  it('clears a full column', () => {
    const board = createBoard();
    fillCol(board, 5);
    const lines = findFullLines(board);
    expect(lines.cols).toEqual([5]);
    const result = clearLines(board, lines);
    expect(result.cellsCleared).toBe(SIZE);
  });

  it('counts an intersecting row+column clear once per cell', () => {
    const board = createBoard();
    fillRow(board, 3);
    fillCol(board, 4);
    const lines = findFullLines(board);
    expect(lines.rows).toEqual([3]);
    expect(lines.cols).toEqual([4]);

    const result = clearLines(board, lines);
    // 8 + 8 cells minus the shared intersection
    expect(result.cellsCleared).toBe(SIZE * 2 - 1);
    expect(occupancy(board)).toBe(0);
  });

  it('reports ballast cleared, which drives the extra vent', () => {
    const board = createBoard();
    fillRow(board, 0);
    board.cells[idx(0, 1)] = BALLAST;
    board.cells[idx(0, 2)] = BALLAST;
    const result = clearLines(board, findFullLines(board));
    expect(result.ballastCleared).toBe(2);
  });

  it('does not clear a row that is one cell short', () => {
    const board = createBoard();
    fillRow(board, 6, [7]);
    expect(findFullLines(board).rows).toEqual([]);
    expect(lineDeficits(board).rows[6]).toBe(1);
  });

  it('a placement completing a line is detected after the write', () => {
    const board = createBoard();
    fillRow(board, 1, [0]);
    expect(findFullLines(board).rows).toEqual([]);
    writePiece(board, PIECES_BY_ID['dot']!, 1, 0);
    expect(findFullLines(board).rows).toEqual([1]);
  });
});

describe('near-miss surfacing (lever 1)', () => {
  it('flags only lines within the threshold', () => {
    const board = createBoard();
    fillRow(board, 0, [3]); // 1 short
    fillRow(board, 1, [3, 4]); // 2 short
    const flagged = nearMissLines(board, 1);
    expect(flagged.rows).toContain(0);
    expect(flagged.rows).not.toContain(1);
  });

  it('never flags an already-full line', () => {
    const board = createBoard();
    fillRow(board, 0);
    expect(nearMissLines(board, 1).rows).not.toContain(0);
  });
});

describe('surges', () => {
  it('injects the requested number of ballast tiles', () => {
    const board = createBoard();
    const placed = applySurge(board, 4, makeRng(1), true);
    expect(placed).toHaveLength(4);
    expect([...board.cells].filter((v) => v === BALLAST)).toHaveLength(4);
  });

  it('fills from the bottom row up, so the threat is legible', () => {
    const board = createBoard();
    const placed = applySurge(board, 3, makeRng(7), true);
    expect(placed.every((cell) => cell.r === SIZE - 1)).toBe(true);
  });

  it('never overwrites an occupied cell and stops when there is nowhere legal', () => {
    const board = createBoard();
    board.cells.fill(1);
    board.cells[idx(0, 0)] = EMPTY;
    // the only hole is the last empty in both its row and its column, so a
    // surge must leave it alone rather than complete a line
    const placed = applySurge(board, 5, makeRng(3), true);
    expect(placed).toHaveLength(0);
    expect(board.cells[idx(0, 0)]).toBe(EMPTY);
  });

  it('never completes a row or column', () => {
    for (let seed = 0; seed < 40; seed++) {
      const board = createBoard();
      // a scattering of occupied cells, then a large surge
      const rng = makeRng(seed);
      for (let i = 0; i < 30; i++) board.cells[rng.int(SIZE * SIZE)] = 1;
      applySurge(board, 64, rng, true);
      const lines = findFullLines(board);
      expect(lines.rows).toEqual([]);
      expect(lines.cols).toEqual([]);
    }
  });

  it('still buries the player when there is room', () => {
    const board = createBoard();
    expect(applySurge(board, 6, makeRng(2), true)).toHaveLength(6);
  });
});
