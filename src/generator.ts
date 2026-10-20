/**
 * generator.ts — lever 1 (variable-ratio reward) and the combo->next-pieces feed.
 *
 * The generator does not simply draw at random. For each draw it samples a
 * candidate pool, evaluates each candidate against the live board, and then
 * decides -- with an explicit probability -- whether to steer the draw toward
 * a piece that can complete a line, toward a piece that leaves a deliberate
 * near-miss, or to draw honestly by weight.
 *
 * Early on the steer probability is near 1 (the first few clears are effectively
 * guaranteed, which teaches the loop). It then decays into a genuine
 * variable-ratio schedule, the schedule most resistant to extinction.
 */

import { canPlace, lineDeficits, SIZE, type Board } from './board.js';
import { assistProbability } from './difficulty.js';
import type { Levers } from './levers.js';
import { PIECES, type Piece } from './pieces.js';
import type { Rng } from './rng.js';

export interface GenContext {
  /** total pieces placed this game — drives assist decay */
  placements: number;
  /** smoothed skill 0..1 — a strong player gets less help */
  skill: number;
  /** live combo length — feeds escalation back into the draw */
  combo: number;
  /** clears still owed by the guaranteed-start window */
  guaranteedClearsRemaining: number;
}

export interface PieceEval {
  piece: Piece;
  /** any legal position at all */
  placeable: boolean;
  /** number of positions that would complete at least one line */
  clearPlacements: number;
  /** number of positions that would leave a line exactly 1 cell short */
  nearMissPlacements: number;
}

/** Evaluate a piece against the board without mutating it. */
export function evaluatePiece(board: Board, piece: Piece): PieceEval {
  const deficits = lineDeficits(board);
  let placeable = false;
  let clearPlacements = 0;
  let nearMissPlacements = 0;

  const addedRow = new Int8Array(SIZE);
  const addedCol = new Int8Array(SIZE);

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!canPlace(board, piece, r, c)) continue;
      placeable = true;

      addedRow.fill(0);
      addedCol.fill(0);
      for (const cell of piece.cells) {
        addedRow[r + cell.r]!++;
        addedCol[c + cell.c]!++;
      }

      let clears = 0;
      let nearMisses = 0;
      for (let i = 0; i < SIZE; i++) {
        if (addedRow[i]! > 0) {
          const left = deficits.rows[i]! - addedRow[i]!;
          if (left === 0) clears++;
          else if (left === 1) nearMisses++;
        }
        if (addedCol[i]! > 0) {
          const left = deficits.cols[i]! - addedCol[i]!;
          if (left === 0) clears++;
          else if (left === 1) nearMisses++;
        }
      }
      if (clears > 0) clearPlacements++;
      else if (nearMisses > 0) nearMissPlacements++;
    }
  }

  return { piece, placeable, clearPlacements, nearMissPlacements };
}

function weightedPick(pool: readonly Piece[], rng: Rng): Piece {
  const total = pool.reduce((sum, piece) => sum + piece.weight, 0);
  let roll = rng.next() * total;
  for (const piece of pool) {
    roll -= piece.weight;
    if (roll <= 0) return piece;
  }
  return pool[pool.length - 1]!;
}

function samplePool(levers: Levers, rng: Rng): Piece[] {
  const size = Math.max(1, Math.min(levers.generatorCandidatePool, PIECES.length));
  const pool: Piece[] = [];
  for (let i = 0; i < size; i++) pool.push(weightedPick(PIECES, rng));
  return pool;
}

/**
 * The effective steer probability for this draw: the decaying assist curve,
 * pushed back up toward 1 while a combo is live (lever: comboFeedStrength).
 */
export function effectiveAssist(levers: Levers, ctx: GenContext): number {
  const base = assistProbability(levers, ctx.placements, ctx.skill);
  if (ctx.combo < levers.comboFeedThreshold) return base;
  const strength = Math.min(Math.max(levers.comboFeedStrength, 0), 1);
  return base + (1 - base) * strength;
}

export interface DrawnPiece {
  piece: Piece;
  /** why this piece was chosen — logged to telemetry so the bias is auditable */
  reason: 'guaranteed' | 'assist' | 'near-miss' | 'random' | 'survival';
}

/** Draw a single piece with the full bias pipeline applied. */
export function drawPiece(board: Board, levers: Levers, rng: Rng, ctx: GenContext): DrawnPiece {
  const pool = samplePool(levers, rng);
  const evals = pool.map((piece) => evaluatePiece(board, piece));
  const placeable = evals.filter((e) => e.placeable);

  // Nothing in the pool fits: hand over the smallest piece that does, so the
  // player never loses to a draw they could not have survived.
  if (placeable.length === 0) {
    const survivor = PIECES.filter((piece) => evaluatePiece(board, piece).placeable).sort(
      (a, b) => a.cells.length - b.cells.length,
    )[0];
    return { piece: survivor ?? PIECES[0]!, reason: 'survival' };
  }

  const clearers = placeable.filter((e) => e.clearPlacements > 0);
  const nearMissers = placeable.filter((e) => e.nearMissPlacements > 0);

  // Guaranteed-start window: the first N clears are not left to chance.
  if (ctx.guaranteedClearsRemaining > 0 && clearers.length > 0) {
    return { piece: rng.pick(clearers).piece, reason: 'guaranteed' };
  }

  if (clearers.length > 0 && rng.next() < effectiveAssist(levers, ctx)) {
    return { piece: rng.pick(clearers).piece, reason: 'assist' };
  }

  if (nearMissers.length > 0 && rng.next() < levers.nearMissProbability) {
    return { piece: rng.pick(nearMissers).piece, reason: 'near-miss' };
  }

  return { piece: weightedPick(placeable.map((e) => e.piece), rng), reason: 'random' };
}

/** Draw a full tray. */
export function drawTray(
  board: Board,
  levers: Levers,
  rng: Rng,
  ctx: GenContext,
  count = 3,
): DrawnPiece[] {
  const out: DrawnPiece[] = [];
  for (let i = 0; i < count; i++) {
    // The guaranteed window is consumed across the tray, not per piece.
    const sub: GenContext = {
      ...ctx,
      guaranteedClearsRemaining: Math.max(0, ctx.guaranteedClearsRemaining - i),
    };
    out.push(drawPiece(board, levers, rng, sub));
  }
  return out;
}
