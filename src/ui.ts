/**
 * ui.ts — DOM overlays: sheets, the mock ad surface, toasts.
 *
 * Anti-dark-pattern rules enforced here, not just documented:
 *   - every sheet has a real, labelled, always-enabled dismiss control
 *   - no countdown timer anywhere; the ad progress bar is a progress bar, and
 *     the close button works from the first frame
 *   - rewarded offers state plainly what is watched and what is received
 *   - declining is a full-width button, never a tiny grey link
 *   - the loot table shows real percentages derived from the real weights
 */

import type { AdHost } from './ads.js';
import { lootOdds, type Profile, type WeeklyGoal } from './progress.js';

export interface SheetButton {
  label: string;
  sub?: string;
  kind?: 'primary' | 'secondary' | 'ghost';
  onClick: () => void;
}

export interface SheetOptions {
  title: string;
  body?: string;
  stats?: { value: string; label: string }[];
  html?: string;
  buttons: SheetButton[];
  /** tapping the backdrop dismisses via this handler; omit to require a button */
  onDismiss?: () => void;
}

export class Ui {
  private readonly modalRoot: HTMLElement;
  private readonly toastRoot: HTMLElement;

  constructor(modalRoot: HTMLElement, toastRoot: HTMLElement) {
    this.modalRoot = modalRoot;
    this.toastRoot = toastRoot;
  }

  get isSheetOpen(): boolean {
    return this.modalRoot.childElementCount > 0;
  }

  closeSheet(): void {
    this.modalRoot.replaceChildren();
  }

  sheet(options: SheetOptions): void {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-wrap';

    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');

    const h = document.createElement('h2');
    h.textContent = options.title;
    sheet.append(h);

    if (options.body) {
      const p = document.createElement('p');
      p.textContent = options.body;
      sheet.append(p);
    }

    if (options.stats?.length) {
      const stats = document.createElement('div');
      stats.className = 'stats';
      for (const stat of options.stats) {
        const cell = document.createElement('div');
        const b = document.createElement('b');
        b.textContent = stat.value;
        const span = document.createElement('span');
        span.textContent = stat.label;
        cell.append(b, span);
        stats.append(cell);
      }
      sheet.append(stats);
    }

    if (options.html) {
      const holder = document.createElement('div');
      holder.innerHTML = options.html;
      sheet.append(holder);
    }

    for (const button of options.buttons) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `btn${button.kind && button.kind !== 'primary' ? ` ${button.kind}` : ''}`;
      el.append(document.createTextNode(button.label));
      if (button.sub) {
        const sub = document.createElement('span');
        sub.className = 'sub';
        sub.textContent = button.sub;
        el.append(sub);
      }
      el.addEventListener('click', () => {
        this.closeSheet();
        button.onClick();
      });
      sheet.append(el);
    }

    if (options.onDismiss) {
      wrap.addEventListener('click', (event) => {
        if (event.target === wrap) {
          this.closeSheet();
          options.onDismiss?.();
        }
      });
    }

    wrap.append(sheet);
    this.modalRoot.replaceChildren(wrap);
  }

  toast(message: string, ms = 2200): void {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    this.toastRoot.append(el);
    window.setTimeout(() => el.remove(), ms);
  }

  /** The honest loot table markup. Percentages come from the real weights. */
  lootTableHtml(): string {
    const rows = lootOdds()
      .map((entry) => `<li><span>${escapeHtml(entry.label)}</span><b>${entry.percent}%</b></li>`)
      .join('');
    return `<ul class="loot">${rows}</ul>`;
  }

  leaderboardHtml(profile: Profile, justScored: number): string {
    if (profile.scores.length === 0) return '';
    let marked = false;
    const rows = profile.scores
      .map((score, i) => {
        const you = !marked && score === justScored;
        if (you) marked = true;
        return `<li class="${you ? 'you' : ''}"><span>#${i + 1}</span><span>${score.toLocaleString()}</span></li>`;
      })
      .join('');
    return `<ul class="leaderboard">${rows}</ul>`;
  }

  /**
   * The mock ad surface, and the AdHost implementation the network talks to.
   * The close button is real and live immediately — that is the whole point.
   */
  adHost(): AdHost {
    return {
      present: (kind, durationMs) =>
        new Promise<'completed' | 'closed'>((resolve) => {
          const box = document.createElement('div');
          box.className = 'adbox';

          const label = document.createElement('div');
          label.className = 'label';
          label.textContent = kind === 'rewarded' ? 'Rewarded ad (mock)' : 'Ad (mock)';

          const fake = document.createElement('div');
          fake.className = 'fake';
          fake.textContent = 'ad creative';

          const note = document.createElement('div');
          note.style.cssText = 'font-size:13px;color:#8b9ab4;max-width:300px';
          note.textContent =
            kind === 'rewarded'
              ? 'Watch to the end to get your reward. Close any time — you just will not get it.'
              : 'This is the one ad between games.';

          const progress = document.createElement('progress');
          progress.max = durationMs;
          progress.value = 0;

          const close = document.createElement('button');
          close.type = 'button';
          close.className = 'close';
          close.textContent = 'Close';

          let done = false;
          const finish = (how: 'completed' | 'closed'): void => {
            if (done) return;
            done = true;
            window.clearInterval(timer);
            box.remove();
            resolve(how);
          };

          close.addEventListener('click', () => finish('closed'));

          const startedAt = performance.now();
          const timer = window.setInterval(() => {
            const elapsed = performance.now() - startedAt;
            progress.value = Math.min(durationMs, elapsed);
            if (elapsed >= durationMs) finish('completed');
          }, 50);

          box.append(close, label, fake, progress, note);
          document.body.append(box);
        }),
    };
  }
}

export function renderGoal(goal: WeeklyGoal, fillEl: HTMLElement, labelEl: HTMLElement): void {
  fillEl.style.width = `${(goal.fraction * 100).toFixed(1)}%`;
  const have = goal.granted + goal.earned;
  labelEl.textContent = goal.complete
    ? `weekly goal complete · ${have}/${goal.target}`
    : `${have}/${goal.target} clears · ${goal.granted} granted to start`;
}

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
