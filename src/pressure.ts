/**
 * pressure.ts — the twist. A second resource that turns "play safe" into a cost.
 *
 * Every placement adds pressure, scaled by how full the board already is.
 * Clearing lines VENTS pressure; clearing ballast vents extra. When the meter
 * fills, a surge injects ballast tiles from the bottom up and the meter resets
 * to a residue (never to zero) so the next cycle stays tense.
 */

import type { Levers } from './levers.js';

export interface PressureState {
  value: number;
  /** how many surges have fired this game — shown in telemetry, used for scoring */
  surges: number;
}

export function createPressure(): PressureState {
  return { value: 0, surges: 0 };
}

/** Pressure added by a single placement at the given board occupancy (0..1). */
export function pressureGain(levers: Levers, occupancy: number): number {
  return levers.pressurePerPlacement + levers.pressureFillCoefficient * occupancy;
}

/** Pressure removed by a clear of `lines` lines containing `ballast` ballast cells. */
export function ventAmount(levers: Levers, lines: number, ballast: number): number {
  return lines * levers.ventPerLine + ballast * levers.ventPerBallast;
}

/** How many ballast tiles the next surge injects, given skill 0..1. */
export function surgeBallastCount(levers: Levers, skill: number): number {
  const lo = levers.surgeBallastMin;
  const hi = levers.surgeBallastMax;
  return Math.round(lo + (hi - lo) * clamp01(skill));
}

export function applyGain(state: PressureState, levers: Levers, occupancy: number): void {
  state.value = Math.max(0, state.value + pressureGain(levers, occupancy));
}

export function applyVent(state: PressureState, levers: Levers, lines: number, ballast: number): number {
  const vented = Math.min(state.value, ventAmount(levers, lines, ballast));
  state.value -= vented;
  return vented;
}

export function isOverflowing(state: PressureState, levers: Levers): boolean {
  return state.value >= levers.pressureCapacity;
}

/** Reset after a surge. Leaves residue so tension never fully drops. */
export function resetAfterSurge(state: PressureState, levers: Levers): void {
  state.value = Math.min(levers.pressureResetTo, levers.pressureCapacity - 1);
  state.surges++;
}

/** 0..1 for the meter fill. */
export function pressureRatio(state: PressureState, levers: Levers): number {
  return clamp01(state.value / levers.pressureCapacity);
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
