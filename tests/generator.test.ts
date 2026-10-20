import { describe, expect, it } from 'vitest';
import { SIZE, createBoard, idx, type Board } from '../src/board.js';
import { drawPiece, drawTray, effectiveAssist, evaluatePiece } from '../src/generator.js';
import { defaultLevers, type Levers } from '../src/levers.js';
import { PIECES_BY_ID } from '../src/pieces.js';
import { makeRng } from '../src/rng.js';

/** A board with row 4 one cell short at (4,7): a single dot clears it. */
function oneShortBoard(): Board {
  const board = createBoard();
  for (let c = 0; c < SIZE - 1; c++) board.cells[idx(4, c)] = 1;
  return board;
}

const ctx = (over: Partial<Parameters<typeof drawPiece>[3]> = {}) => ({
  placements: 0,
  skill: 0,
  combo: 0,
  guaranteedClearsRemaining: 0,
  ...over,
});

describe('piece evaluation', () => {
  it('spots that a dot can complete the short row', () => {
    const result = evaluatePiece(oneShortBoard(), PIECES_BY_ID['dot']!);
    expect(result.placeable).toBe(true);
    expect(result.clearPlacements).toBeGreaterThan(0);
  });

  it('reports no clear when nothing is close', () => {
    const result = evaluatePiece(createBoard(), PIECES_BY_ID['dot']!);
    expect(result.placeable).toBe(true);
    expect(result.clearPlacements).toBe(0);
  });

  it('reports unplaceable when the board is full', () => {
    const board = createBoard();
    board.cells.fill(1);
    expect(evaluatePiece(board, PIECES_BY_ID['dot']!).placeable).toBe(false);
  });

  it('counts near-miss placements separately from clears', () => {
    const board = createBoard();
    // row 4 is two short: a dot leaves it one short -> near miss, never a clear
    for (let c = 0; c < SIZE - 2; c++) board.cells[idx(4, c)] = 1;
    const result = evaluatePiece(board, PIECES_BY_ID['dot']!);
    expect(result.clearPlacements).toBe(0);
    expect(result.nearMissPlacements).toBeGreaterThan(0);
  });
});

describe('generation bias (lever 1)', () => {
  it('guarantees a clear-capable piece while the guaranteed window is open', () => {
    const levers = defaultLevers;
    for (let seed = 0; seed < 60; seed++) {
      const board = oneShortBoard();
      const drawn = drawPiece(board, levers, makeRng(seed), ctx({ guaranteedClearsRemaining: 3 }));
      expect(drawn.reason).toBe('guaranteed');
      expect(evaluatePiece(board, drawn.piece).clearPlacements).toBeGreaterThan(0);
    }
  });

  it('is markedly more generous early than late', () => {
    const levers = defaultLevers;
    const rate = (placements: number, skill: number): number => {
      let clearable = 0;
      const trials = 400;
      for (let seed = 0; seed < trials; seed++) {
        const board = oneShortBoard();
        const drawn = drawPiece(board, levers, makeRng(seed * 31 + 7), ctx({ placements, skill }));
        if (evaluatePiece(board, drawn.piece).clearPlacements > 0) clearable++;
      }
      return clearable / trials;
    };

    const early = rate(0, 0);
    const late = rate(400, 1);
    expect(early).toBeGreaterThan(0.8);
    expect(late).toBeLessThan(early - 0.2);
  });

  it('never drops the assist below the configured floor', () => {
    const levers: Levers = { ...defaultLevers, assistProbabilityFloor: 0.3 };
    for (const placements of [0, 50, 500, 50_000]) {
      for (const skill of [0, 0.5, 1]) {
        expect(effectiveAssist(levers, ctx({ placements, skill }))).toBeGreaterThanOrEqual(0.3);
      }
    }
  });

  it('a live combo pushes the assist back up (combo -> next pieces)', () => {
    const levers = defaultLevers;
    const cold = effectiveAssist(levers, ctx({ placements: 300, skill: 1, combo: 0 }));
    const hot = effectiveAssist(levers, ctx({ placements: 300, skill: 1, combo: 5 }));
    expect(hot).toBeGreaterThan(cold);
    expect(hot).toBeLessThanOrEqual(1);
  });

  it('a combo below the threshold does not feed the generator', () => {
    const levers = defaultLevers;
    const base = effectiveAssist(levers, ctx({ placements: 100, combo: 0 }));
    const belowThreshold = effectiveAssist(
      levers,
      ctx({ placements: 100, combo: defaultLevers.comboFeedThreshold - 1 }),
    );
    expect(belowThreshold).toBeCloseTo(base, 10);
  });

  it('honours the disabled case: zero assist still draws a legal piece', () => {
    const levers: Levers = {
      ...defaultLevers,
      assistProbabilityFloor: 0,
      assistProbabilityCeiling: 0,
      nearMissProbability: 0,
    };
    const board = oneShortBoard();
    const drawn = drawPiece(board, levers, makeRng(9), ctx({ placements: 999 }));
    expect(drawn.reason).toBe('random');
    expect(evaluatePiece(board, drawn.piece).placeable).toBe(true);
  });
});

describe('survival guarantee', () => {
  it('hands over a piece that fits rather than an unwinnable draw', () => {
    const board = createBoard();
    board.cells.fill(1);
    board.cells[idx(7, 7)] = 0; // only a single cell free
    const drawn = drawPiece(board, defaultLevers, makeRng(5), ctx({ placements: 10 }));
    expect(drawn.reason).toBe('survival');
    expect(drawn.piece.cells).toHaveLength(1);
  });
});

describe('tray draw', () => {
  it('returns three placeable pieces on an open board', () => {
    const board = createBoard();
    const tray = drawTray(board, defaultLevers, makeRng(11), ctx());
    expect(tray).toHaveLength(3);
    for (const drawn of tray) {
      expect(evaluatePiece(board, drawn.piece).placeable).toBe(true);
    }
  });

  it('consumes the guaranteed window across the tray, not per piece', () => {
    const board = oneShortBoard();
    const tray = drawTray(board, defaultLevers, makeRng(2), ctx({ guaranteedClearsRemaining: 1 }));
    expect(tray[0]!.reason).toBe('guaranteed');
    expect(tray[1]!.reason).not.toBe('guaranteed');
  });
});
