/**
 * debug.ts — the hidden instrumentation panel.
 *
 * Opened by `#debug` (or `/debug/`, which redirects here), or by tapping the
 * score five times. It is hidden because it is for us, not because the data is
 * sensitive: everything shown is already on the player's own device.
 */

import { computeMetrics, type Telemetry } from './telemetry.js';
import { clearLeverOverrides, defaultLevers, saveLeverOverrides, type Levers } from './levers.js';
import { escapeHtml } from './ui.js';

export interface DebugOptions {
  telemetry: Telemetry;
  levers: Levers;
  onClose: () => void;
}

function row(label: string, value: string): string {
  return `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`;
}

function n(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

export async function openDebugPanel(options: DebugOptions): Promise<void> {
  const { telemetry, levers } = options;
  const existing = document.getElementById('debug-panel');
  if (existing) existing.remove();

  const panel = document.createElement('div');
  panel.id = 'debug-panel';
  document.body.append(panel);

  const render = async (): Promise<void> => {
    const events = await telemetry.allEvents();
    const m = computeMetrics(events, levers.ecpmLowUsd, levers.ecpmHighUsd);

    const leverRows = (Object.keys(defaultLevers) as (keyof Levers)[])
      .map((key) => {
        const live = levers[key];
        const def = defaultLevers[key];
        const changed = String(live) !== String(def);
        return `<tr><td>${escapeHtml(key)}${changed ? ' *' : ''}</td><td>${escapeHtml(String(live))}</td></tr>`;
      })
      .join('');

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
        <strong style="font:700 16px/1 system-ui">Overflow Grid · /debug</strong>
        <button class="chip" id="dbg-close" type="button">close</button>
      </div>

      <h3>Retention</h3>
      <table>
        ${row('sessions', String(m.sessions))}
        ${row('active days', String(m.days))}
        ${row('sessions / day', n(m.sessionsPerDay))}
        ${row('avg session length', `${n(m.avgSessionSeconds, 1)}s`)}
        ${row('games', String(m.games))}
        ${row('games / session', n(m.gamesPerSession))}
        ${row('D1 return proxy', `${n(m.d1ReturnProxy * 100, 1)}%`)}
      </table>

      <h3>Monetisation</h3>
      <table>
        ${row('rewarded offers', String(m.rewardedOffers))}
        ${row('rewarded accepts', String(m.rewardedAccepts))}
        ${row('rewarded opt-in rate', `${n(m.rewardedOptInRate * 100, 1)}%`)}
        ${row('ad impressions', String(m.adImpressions))}
        ${row('ads / session', n(m.adsPerSession))}
        ${row(`projected revenue @ $${levers.ecpmLowUsd} eCPM`, `$${n(m.projectedRevenueLowUsd, 4)}`)}
        ${row(`projected revenue @ $${levers.ecpmHighUsd} eCPM`, `$${n(m.projectedRevenueHighUsd, 4)}`)}
      </table>

      <h3>Gameplay</h3>
      <table>
        ${row('line clears', String(m.clears))}
        ${row('best combo', String(m.bestCombo))}
        ${row('surges', String(m.surges))}
        ${row('events logged', String(m.totalEvents))}
      </table>

      <h3>Live levers (* = overridden)</h3>
      <table>${leverRows}</table>

      <div class="row-actions">
        <button class="chip" id="dbg-export" type="button">export JSON</button>
        <button class="chip" id="dbg-copy" type="button">copy JSON</button>
        <button class="chip" id="dbg-refresh" type="button">refresh</button>
        <button class="chip" id="dbg-save-levers" type="button">save live levers</button>
        <button class="chip" id="dbg-reset-levers" type="button">reset levers</button>
        <button class="chip" id="dbg-wipe" type="button">wipe events</button>
      </div>
      <p style="color:#8b9ab4;font-size:11px;margin-top:14px">
        All figures come from anonymous events stored in IndexedDB on this device only.
        Nothing is transmitted. D1 is a single-install proxy, not cohort retention.
      </p>
    `;

    panel.querySelector('#dbg-close')?.addEventListener('click', () => {
      panel.remove();
      options.onClose();
    });

    panel.querySelector('#dbg-refresh')?.addEventListener('click', () => void render());

    panel.querySelector('#dbg-export')?.addEventListener('click', async () => {
      const json = await telemetry.exportJson();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `overflow-grid-telemetry-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    panel.querySelector('#dbg-copy')?.addEventListener('click', async () => {
      const json = await telemetry.exportJson();
      try {
        await navigator.clipboard.writeText(json);
      } catch {
        /* clipboard blocked: the export button still works */
      }
    });

    panel.querySelector('#dbg-save-levers')?.addEventListener('click', () => {
      saveLeverOverrides(levers, localStorage);
      void render();
    });

    panel.querySelector('#dbg-reset-levers')?.addEventListener('click', () => {
      clearLeverOverrides(localStorage);
      location.reload();
    });

    panel.querySelector('#dbg-wipe')?.addEventListener('click', async () => {
      await telemetry.reset();
      await render();
    });
  };

  await render();
}

/** `#debug`, `?debug=1`, or a /debug/ path that redirected here. */
export function debugRequested(): boolean {
  if (typeof location === 'undefined') return false;
  if (location.hash.replace('#', '') === 'debug') return true;
  return new URLSearchParams(location.search).get('debug') === '1';
}
