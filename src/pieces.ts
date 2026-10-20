/**
 * pieces.ts — the original piece set for Overflow Grid.
 *
 * Shapes are expressed as offset lists normalised so the minimum row/col is 0.
 * The set is deliberately weighted toward pieces that interact with the pressure
 * twist: long bars (good venters) are rarer than small awkward shapes.
 */

export interface Cell {
  r: number;
  c: number;
}

export interface Piece {
  id: string;
  cells: Cell[];
  /** relative draw weight before any generator bias is applied */
  weight: number;
  /** palette index 0..5, purely cosmetic */
  hue: number;
}

function p(id: string, weight: number, hue: number, rows: string[]): Piece {
  const cells: Cell[] = [];
  rows.forEach((row, r) => {
    [...row].forEach((ch, c) => {
      if (ch !== '.' && ch !== ' ') cells.push({ r, c });
    });
  });
  return { id, cells, weight, hue };
}

export const PIECES: readonly Piece[] = [
  // singles & dominoes — the escape hatches that keep a crowded board survivable
  p('dot', 7, 0, ['#']),
  p('duo-h', 9, 1, ['##']),
  p('duo-v', 9, 1, ['#', '#']),

  // trominoes
  p('tri-h', 8, 2, ['###']),
  p('tri-v', 8, 2, ['#', '#', '#']),
  p('corner-ne', 9, 3, ['##', '.#']),
  p('corner-nw', 9, 3, ['##', '#.']),
  p('corner-se', 9, 3, ['#.', '##']),
  p('corner-sw', 9, 3, ['.#', '##']),

  // tetrominoes
  p('quad', 8, 4, ['##', '##']),
  p('bar4-h', 5, 5, ['####']),
  p('bar4-v', 5, 5, ['#', '#', '#', '#']),
  p('tee-n', 6, 4, ['###', '.#.']),
  p('tee-s', 6, 4, ['.#.', '###']),
  p('tee-w', 6, 4, ['.#', '##', '.#']),
  p('tee-e', 6, 4, ['#.', '##', '#.']),
  p('ess-h', 5, 2, ['.##', '##.']),
  p('zee-h', 5, 2, ['##.', '.##']),
  p('ell-a', 6, 3, ['#.', '#.', '##']),
  p('ell-b', 6, 3, ['.#', '.#', '##']),
  p('ell-c', 6, 3, ['##', '#.', '#.']),
  p('ell-d', 6, 3, ['##', '.#', '.#']),
  p('ell-e', 6, 3, ['###', '#..']),
  p('ell-f', 6, 3, ['###', '..#']),
  p('ell-g', 6, 3, ['#..', '###']),
  p('ell-h', 6, 3, ['..#', '###']),

  // pentominoes — rare, high ceiling, the pieces that set up big vents
  p('bar5-h', 3, 5, ['#####']),
  p('bar5-v', 3, 5, ['#', '#', '#', '#', '#']),
  p('plus', 3, 0, ['.#.', '###', '.#.']),
  p('big-corner-a', 4, 1, ['###', '#..', '#..']),
  p('big-corner-b', 4, 1, ['###', '..#', '..#']),
  p('big-corner-c', 4, 1, ['#..', '#..', '###']),
  p('big-corner-d', 4, 1, ['..#', '..#', '###']),
];

export const PIECES_BY_ID: Record<string, Piece> = Object.fromEntries(
  PIECES.map((piece) => [piece.id, piece]),
);

export function pieceSize(piece: Piece): { rows: number; cols: number } {
  let rows = 0;
  let cols = 0;
  for (const cell of piece.cells) {
    rows = Math.max(rows, cell.r + 1);
    cols = Math.max(cols, cell.c + 1);
  }
  return { rows, cols };
}
