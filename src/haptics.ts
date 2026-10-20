/**
 * haptics.ts — Vibration API wrapper.
 * Converting a visual event into a physical one is the cheapest juice win on
 * mobile. Patterns are short; anything long reads as a malfunction.
 */

export type HapticEvent = 'place' | 'clear' | 'combo' | 'surge' | 'gameover' | 'reward';

const PATTERNS: Record<HapticEvent, number | number[]> = {
  place: 8,
  clear: [12, 30, 18],
  combo: [10, 20, 10, 20, 24],
  surge: [40, 60, 40],
  gameover: [30, 80, 60],
  reward: [10, 30, 10, 30, 10],
};

export class Haptics {
  private enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled && typeof navigator !== 'undefined' && 'vibrate' in navigator;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  fire(event: HapticEvent): void {
    if (!this.enabled) return;
    try {
      navigator.vibrate(PATTERNS[event]);
    } catch {
      /* unsupported or blocked by user settings */
    }
  }
}
