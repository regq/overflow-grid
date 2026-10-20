import { describe, expect, it } from 'vitest';
import { BALLAST, EMPTY, SIZE, findFullLines, idx } from '../src/board.js';
import { Game } from '../src/game.js';
import { defaultLevers, type Levers } from '../src/levers.js';
import { PIECES_BY_ID } from '../src/pieces.js';

function makeGame(levers: Partial<Levers> = {}, seed = 42): Game {
  let t = 1_700_000_000_000;
  const game = new Game({
    levers: { ...defaultLevers, ...levers },
    seed,
    now: () => (t += 1000),
  });
  game.start();
  return game;
}

/** Put a known piece in slot 0 so a test can drive a deterministic placement. */
function stub(game: Game, pieceId: string, slot = 0): void {
  game.tray[slot] = PIECES_BY_ID[pieceId]!;
}

describe('game loop', () => {
  it('starts playing with a full tray', () => {
    const game = makeGame();
    expect(game.status).toBe('playing');
    expect(game.tray.filter(Boolean)).toHaveLength(3);
    expect(game.score).toBe(0);
  });

  it('scores a placement and consumes the tray slot', () => {
    const game = makeGame();
    stub(game, 'quad');
    const outcome = game.place(0, 0, 0);
    expect(outcome.ok).toBe(true);
    expect(game.score).toBe(4);
    expect(game.tray[0]).toBeNull();
    expect(game.placements).toBe(1);
  });

  it('rejects an illegal placement without consuming anything', () => {
    const game = makeGame();
    stub(game, 'quad');
    game.place(0, 0, 0);
    stub(game, 'quad', 1);
    const outcome = game.place(1, 0, 0);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('illegal');
    expect(game.tray[1]).not.toBeNull();
  });

  it('refills the tray only when all three slots are spent', () => {
    const game = makeGame();
    stub(game, 'dot', 0);
    stub(game, 'dot', 1);
    stub(game, 'dot', 2);
    game.place(0, 0, 0);
    expect(game.tray.filter(Boolean)).toHaveLength(2);
    game.place(1, 0, 1);
    expect(game.tray.filter(Boolean)).toHaveLength(1);
    const outcome = game.place(2, 0, 2);
    expect(outcome.trayRefilled).toBe(true);
    expect(game.tray.filter(Boolean)).toHaveLength(3);
  });
});

describe('clearing, combo and venting', () => {
  it('clears a line, vents pressure and raises the combo', () => {
    const game = makeGame();
    for (let c = 0; c < SIZE - 1; c++) game.board.cells[idx(4, c)] = 1;
    game.pressure.value = 60;
    stub(game, 'dot');

    const outcome = game.place(0, 4, SIZE - 1);
    expect(outcome.linesCleared).toBe(1);
    expect(outcome.cellsCleared).toBe(SIZE);
    expect(game.combo).toBe(1);
    // the vent (22) outweighs the placement gain, so pressure fell
    expect(game.pressure.value).toBeLessThan(60);
  });

  it('a non-clearing placement raises pressure', () => {
    const game = makeGame();
    const before = game.pressure.value;
    stub(game, 'quad');
    game.place(0, 0, 0);
    expect(game.pressure.value).toBeGreaterThan(before);
  });

  it('decays the combo after the configured number of empty placements', () => {
    const game = makeGame({ comboDecayPlacements: 2 });
    for (let c = 0; c < SIZE - 1; c++) game.board.cells[idx(4, c)] = 1;
    stub(game, 'dot');
    game.place(0, 4, SIZE - 1);
    expect(game.combo).toBe(1);

    stub(game, 'dot', 1);
    game.place(1, 0, 0);
    expect(game.combo).toBe(1); // one miss: still held
    stub(game, 'dot', 2);
    game.place(2, 0, 1);
    expect(game.combo).toBe(0); // second miss: decayed
  });

  it('pays a combo multiplier on the score', () => {
    const plain = makeGame();
    for (let c = 0; c < SIZE - 1; c++) plain.board.cells[idx(4, c)] = 1;
    stub(plain, 'dot');
    const first = plain.place(0, 4, SIZE - 1).scoreGained;

    const combod = makeGame();
    for (let c = 0; c < SIZE - 1; c++) combod.board.cells[idx(4, c)] = 1;
    combod.combo = 4;
    stub(combod, 'dot');
    const second = combod.place(0, 4, SIZE - 1).scoreGained;

    expect(second).toBeGreaterThan(first);
  });

  it('pays extra for clearing ballast', () => {
    const game = makeGame();
    for (let c = 0; c < SIZE - 1; c++) game.board.cells[idx(4, c)] = 1;
    game.board.cells[idx(4, 0)] = BALLAST;
    game.board.cells[idx(4, 1)] = BALLAST;
    stub(game, 'dot');
    const outcome = game.place(0, 4, SIZE - 1);
    expect(outcome.ballastCleared).toBe(2);
  });

  it('previewClear agrees with what actually clears', () => {
    const game = makeGame();
    for (let c = 0; c < SIZE - 1; c++) game.board.cells[idx(4, c)] = 1;
    stub(game, 'dot');
    const preview = game.previewClear(0, 4, SIZE - 1);
    expect(preview.rows).toEqual([4]);
    const outcome = game.place(0, 4, SIZE - 1);
    expect(outcome.linesCleared).toBe(1);
  });
});

describe('surges (the twist)', () => {
  it('fires when the meter fills and resets to the residue, not to zero', () => {
    const game = makeGame();
    game.pressure.value = defaultLevers.pressureCapacity - 1;
    stub(game, 'dot');
    const outcome = game.place(0, 0, 0);

    expect(outcome.surged).toBe(true);
    expect(outcome.surgeCells.length).toBeGreaterThan(0);
    expect(game.pressure.surges).toBe(1);
    expect(game.pressure.value).toBe(defaultLevers.pressureResetTo);
    expect([...game.board.cells].filter((v) => v === BALLAST).length).toBe(
      outcome.surgeCells.length,
    );
  });

  it('does not fire below the capacity', () => {
    const game = makeGame();
    game.pressure.value = 0;
    stub(game, 'dot');
    expect(game.place(0, 0, 0).surged).toBe(false);
  });
});

describe('game over and the rewarded continue (lever 4)', () => {
  it('detects death when no tray piece fits', () => {
    const game = makeGame();
    almostFull(game);
    game.tray = [PIECES_BY_ID['quad']!, PIECES_BY_ID['bar4-h']!, PIECES_BY_ID['tri-h']!];
    expect(game.isDead()).toBe(true);
  });

  it('is not dead while a 1x1 still fits', () => {
    const game = makeGame();
    almostFull(game);
    game.tray = [PIECES_BY_ID['dot']!, null, null];
    expect(game.isDead()).toBe(false);
  });

  /**
   * A realistically dead-end board: every row and every column keeps at least
   * one empty cell, so there is no pre-existing full line waiting to clear, and
   * the remaining holes are isolated singles that only a 1x1 can use.
   *
   * Empties: (0,0) (0,1) (1,0) plus the diagonal (2,2)..(7,7).
   * Row 0 and column 0 each keep two empties, so dropping a dot at (0,0)
   * completes neither — the placement is legal, scores, and leaves the board
   * with nothing but single holes.
   */
  function almostFull(game: Game): void {
    game.board.cells.fill(1);
    game.board.cells[idx(0, 0)] = EMPTY;
    game.board.cells[idx(0, 1)] = EMPTY;
    game.board.cells[idx(1, 0)] = EMPTY;
    for (let i = 2; i < SIZE; i++) game.board.cells[idx(i, i)] = EMPTY;
  }

  it('the fixture itself has no pre-existing full line', () => {
    const game = makeGame();
    almostFull(game);
    const lines = findFullLines(game.board);
    expect(lines.rows).toEqual([]);
    expect(lines.cols).toEqual([]);
  });

  it('ends the game when a placement leaves no legal move', () => {
    const game = makeGame();
    almostFull(game);
    game.tray = [PIECES_BY_ID['dot']!, PIECES_BY_ID['quad']!, PIECES_BY_ID['bar4-h']!];
    const outcome = game.place(0, 0, 0);
    expect(outcome.linesCleared).toBe(0);
    expect(outcome.gameOver).toBe(true);
    expect(game.status).toBe('gameover');
  });

  it('a continue dissolves pieces, relieves pressure and resumes play', () => {
    const game = makeGame();
    // place a real piece first, so there is a group to dissolve
    stub(game, 'quad', 0);
    game.place(0, 0, 0);

    // drive the engine to a genuine game over through a legal final placement
    almostFull(game);
    game.tray = [PIECES_BY_ID['dot']!, PIECES_BY_ID['quad']!, PIECES_BY_ID['bar4-h']!];
    game.place(0, 0, 0);
    expect(game.status).toBe('gameover');

    const pressureBefore = game.pressure.value;
    const applied = game.applyContinue();

    expect(applied.ok).toBe(true);
    expect(applied.dissolved.length).toBeGreaterThan(0);
    expect(game.continueUsed).toBe(true);
    expect(game.pressure.value).toBeLessThan(pressureBefore);
    expect(game.status).toBe('playing');
  });

  it('refuses a second continue in the same game', () => {
    const game = makeGame();
    stub(game, 'quad', 0);
    game.place(0, 0, 0);
    almostFull(game);
    game.tray = [PIECES_BY_ID['dot']!, PIECES_BY_ID['quad']!, PIECES_BY_ID['bar4-h']!];
    game.place(0, 0, 0);
    game.applyContinue();
    const second = game.applyContinue();
    expect(second.ok).toBe(false);
    expect(second.dissolved).toHaveLength(0);
  });

  it('refuses a continue while the game is still running', () => {
    const game = makeGame();
    expect(game.applyContinue().ok).toBe(false);
  });
});

describe('resume snapshot (lever 3)', () => {
  it('round-trips the board, score and tray', () => {
    const game = makeGame();
    stub(game, 'quad');
    game.place(0, 0, 0);
    const snapshot = game.snapshot();

    expect(snapshot.cells).toHaveLength(SIZE * SIZE);
    expect(snapshot.score).toBe(game.score);
    expect(snapshot.tray.length).toBe(2);

    const resumed = makeGame();
    resumed.start(snapshot);
    expect([...resumed.board.cells]).toEqual(snapshot.cells);
    expect(resumed.score).toBe(snapshot.score);
    expect(resumed.tray.filter(Boolean).length).toBe(2);
  });

  it('records how close the nearest line was, for the return message', () => {
    const game = makeGame();
    for (let c = 0; c < SIZE - 1; c++) game.board.cells[idx(4, c)] = 1;
    expect(game.snapshot().closestLineDeficit).toBe(1);
  });
});

describe('chest rewards', () => {
  it('dissolveBallast removes ballast and nothing else', () => {
    const game = makeGame();
    game.pressure.value = defaultLevers.pressureCapacity - 1;
    stub(game, 'dot');
    game.place(0, 0, 0);
    const before = [...game.board.cells].filter((v) => v === BALLAST).length;
    expect(before).toBeGreaterThan(0);

    const dissolved = game.dissolveBallast(1);
    expect(dissolved.length).toBe(1);
    const after = [...game.board.cells].filter((v) => v === BALLAST).length;
    expect(after).toBe(before - 1);
  });

  it('ventFully empties the meter', () => {
    const game = makeGame();
    game.pressure.value = 80;
    game.ventFully();
    expect(game.pressure.value).toBe(0);
  });
});
