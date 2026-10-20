/**
 * render.ts — canvas 2D renderer. Device-pixel-ratio aware, portrait-first,
 * single draw call per frame, no per-frame allocation in the hot path.
 */

import { BALLAST, EMPTY, SIZE, idx, type Board } from './board.js';
import { Fx as Particles, clamp01, easeOutBack } from './fx.js';
import type { Levers } from './levers.js';
import type { Cell, Piece } from './pieces.js';
import { pieceSize } from './pieces.js';

export const HUES: readonly string[] = [
  '#5ec8f2', // 1
  '#7ee0a8', // 2
  '#f2d35e', // 3
  '#f2925e', // 4
  '#c98ff2', // 5
  '#f27b9b', // 6
];

export const INK = {
  bg: '#0d1420',
  panel: '#141d2c',
  grid: '#1d2838',
  gridLine: '#243246',
  ballast: '#44506b',
};

export interface Layout {
  w: number;
  h: number;
  pad: number;
  cell: number;
  boardX: number;
  boardY: number;
  boardSize: number;
  meterY: number;
  meterH: number;
  trayY: number;
  trayH: number;
  traySlotW: number;
  trayCell: number;
}

export type FxKind = 'clear' | 'surge' | 'combo' | 'text';

export interface Fx {
  kind: FxKind;
  startedAt: number;
  durationMs: number;
  cells?: Cell[];
  text?: string;
  /** board-space anchor for text fx */
  anchor?: { r: number; c: number };
  hue?: number;
}

export interface DragState {
  piece: Piece;
  trayIndex: number;
  /** pointer position in css pixels */
  x: number;
  y: number;
  /** snapped board origin, or null when not over a legal spot */
  target: Cell | null;
  valid: boolean;
  /** rows/cols that would clear if dropped here */
  previewRows: number[];
  previewCols: number[];
}

export interface RenderInput {
  board: Board;
  tray: (Piece | null)[];
  pressureRatio: number;
  /** 0..1, how close the meter is to a surge; drives the warning pulse */
  pressureWarning: boolean;
  combo: number;
  nearMissRows: number[];
  nearMissCols: number[];
  drag: DragState | null;
  fx: Fx[];
  now: number;
  /** frame delta in ms, clamped by the caller */
  dtMs: number;
  /** dims the board behind a modal */
  dimmed: boolean;
}

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly levers: Levers;
  private dpr = 1;
  layout: Layout;

  /** the bubble layer */
  readonly particles: Particles;
  /** performance.now() when each cell was filled, for the spring-in pop */
  private placedAt = new Float64Array(SIZE * SIZE);
  /** when each tray slot last refilled, for the staggered pop */
  private trayPopAt: number[] = [-1e9, -1e9, -1e9];
  /** fractional bubble emitters, so rates below 1/frame still work */
  private ambientDebt = 0;
  private meterDebt = 0;

  constructor(canvas: HTMLCanvasElement, levers: Levers) {
    this.canvas = canvas;
    this.levers = levers;
    this.particles = new Particles(levers.maxParticles);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2d canvas unavailable');
    this.ctx = ctx;
    this.layout = this.resize();
  }

  /** Called by the game wiring when a piece lands, so those cells spring in. */
  notePlacement(cells: readonly Cell[], now: number): void {
    for (const cell of cells) this.placedAt[idx(cell.r, cell.c)] = now;
  }

  /** Called when ballast arrives, so it thuds in rather than appearing. */
  noteSurge(cells: readonly Cell[], now: number): void {
    this.notePlacement(cells, now);
    const l = this.layout;
    for (const cell of cells) {
      const { x, y } = this.cellCentre(cell.r, cell.c);
      this.particles.ring(x, y, l.cell * 0.3, '#f2614f', this.levers.shockRingMs * 0.7);
    }
    this.particles.kick(this.levers.screenShakePx, 260);
  }

  noteTrayRefill(now: number): void {
    for (let i = 0; i < 3; i++) this.trayPopAt[i] = now + i * 70;
  }

  /** Burst the cleared cells into bubbles, plus one ring per cleared line. */
  noteClear(cells: readonly Cell[], rows: number[], cols: number[], now: number): void {
    const l = this.layout;
    for (const cell of cells) {
      const { x, y } = this.cellCentre(cell.r, cell.c);
      this.particles.burst(x, y, l.cell, '#bfe9ff', this.levers.burstBubblesPerCell);
      this.placedAt[idx(cell.r, cell.c)] = 0;
    }
    for (const r of rows) {
      this.particles.ring(
        l.boardX + l.boardSize / 2,
        l.boardY + (r + 0.5) * l.cell,
        l.cell * 0.6,
        '#7ee0a8',
        this.levers.shockRingMs,
      );
    }
    for (const c of cols) {
      this.particles.ring(
        l.boardX + (c + 0.5) * l.cell,
        l.boardY + l.boardSize / 2,
        l.cell * 0.6,
        '#7ee0a8',
        this.levers.shockRingMs,
      );
    }
    this.particles.kick(this.levers.screenShakePx * 0.6, 200);
    void now;
  }

  resetAnimations(): void {
    this.placedAt.fill(0);
    this.particles.clear();
  }

  private cellCentre(r: number, c: number): { x: number; y: number } {
    const l = this.layout;
    return { x: l.boardX + (c + 0.5) * l.cell, y: l.boardY + (r + 0.5) * l.cell };
  }

  resize(): Layout {
    const parent = this.canvas.parentElement;
    const cssW = Math.max(240, parent?.clientWidth ?? this.canvas.clientWidth ?? 360);
    const cssH = Math.max(360, parent?.clientHeight ?? this.canvas.clientHeight ?? 640);
    this.dpr = Math.min(2.5, Math.max(1, window.devicePixelRatio || 1));

    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const pad = Math.round(Math.min(cssW, cssH) * 0.035);
    const meterH = Math.max(10, Math.round(cssH * 0.018));
    const trayH = Math.round(cssH * 0.17);
    const availH = cssH - pad * 3 - meterH - trayH;
    const boardSize = Math.floor(Math.min(cssW - pad * 2, availH) / SIZE) * SIZE;
    const cell = boardSize / SIZE;
    const boardX = Math.round((cssW - boardSize) / 2);

    // On a tall phone the board is width-limited, so centre the whole stack
    // vertically rather than leaving all the slack under the tray.
    const contentH = meterH + pad + boardSize + pad + trayH;
    const top = Math.max(pad, Math.round((cssH - contentH) / 2));
    const meterY = top;
    const boardY = meterY + meterH + pad;
    const trayY = boardY + boardSize + pad;
    const traySlotW = (cssW - pad * 2) / 3;

    this.layout = {
      w: cssW,
      h: cssH,
      pad,
      cell,
      boardX,
      boardY,
      boardSize,
      meterY,
      meterH,
      trayY,
      trayH,
      traySlotW,
      trayCell: Math.max(8, Math.min(cell * 0.62, (traySlotW - pad) / 5)),
    };
    return this.layout;
  }

  /** css-pixel point -> board cell, or null if outside. */
  pointToCell(x: number, y: number): Cell | null {
    const l = this.layout;
    const c = Math.floor((x - l.boardX) / l.cell);
    const r = Math.floor((y - l.boardY) / l.cell);
    if (r < 0 || c < 0 || r >= SIZE || c >= SIZE) return null;
    return { r, c };
  }

  /** Which tray slot contains this point, or -1. */
  pointToTraySlot(x: number, y: number): number {
    const l = this.layout;
    if (y < l.trayY || y > l.trayY + l.trayH) return -1;
    const slot = Math.floor((x - l.pad) / l.traySlotW);
    return slot >= 0 && slot < 3 ? slot : -1;
  }

  traySlotCenter(slot: number): { x: number; y: number } {
    const l = this.layout;
    return { x: l.pad + l.traySlotW * (slot + 0.5), y: l.trayY + l.trayH / 2 };
  }

  draw(input: RenderInput): void {
    const ctx = this.ctx;
    const l = this.layout;

    this.emitBubbles(input);
    this.particles.update(input.dtMs);

    ctx.fillStyle = INK.bg;
    ctx.fillRect(0, 0, l.w, l.h);

    const shake = this.particles.shakeOffset();
    ctx.save();
    ctx.translate(shake.x, shake.y);

    this.drawMeter(input);
    this.drawBoard(input);
    // bubbles sit above the board but below the tray and the floating text,
    // so a burst reads over the grid without hiding the pieces you can pick up
    this.particles.draw(ctx);
    this.drawTray(input);
    this.drawFx(input);

    ctx.restore();

    if (input.dimmed) {
      ctx.fillStyle = 'rgba(6,10,17,0.72)';
      ctx.fillRect(0, 0, l.w, l.h);
    }
  }

  /**
   * Ambient bubbles drift up behind the grid at all times; the meter releases
   * more the fuller it is, so a board about to surge is visibly agitated before
   * the number means anything to the player.
   */
  private emitBubbles(input: RenderInput): void {
    const l = this.layout;
    const dt = input.dtMs / 1000;

    this.ambientDebt += this.levers.ambientBubblesPerSecond * dt;
    while (this.ambientDebt >= 1) {
      this.ambientDebt -= 1;
      this.particles.bubble(
        l.boardX + Math.random() * l.boardSize,
        l.boardY + l.boardSize + 6,
        1.5 + Math.random() * 3,
        18 + Math.random() * 26,
        '#4fd1c5',
        2600 + Math.random() * 1800,
      );
    }

    const fill = clamp01(input.pressureRatio);
    this.meterDebt += this.levers.meterBubblesPerSecondAtFull * fill * fill * dt;
    while (this.meterDebt >= 1) {
      this.meterDebt -= 1;
      const x = l.boardX + Math.random() * Math.max(l.meterH, l.boardSize * fill);
      this.particles.bubble(
        x,
        l.meterY + l.meterH,
        1.4 + Math.random() * 2.6,
        26 + Math.random() * 34,
        fill > 0.75 ? '#f2614f' : '#f2d35e',
        700 + Math.random() * 700,
      );
    }
  }

  // ───────────────────────── pressure meter ─────────────────────────

  private drawMeter(input: RenderInput): void {
    const ctx = this.ctx;
    const l = this.layout;
    const x = l.boardX;
    const w = l.boardSize;
    const y = l.meterY;
    const h = l.meterH;
    const r = h / 2;

    roundRect(ctx, x, y, w, h, r);
    ctx.fillStyle = '#17202f';
    ctx.fill();

    const fill = Math.max(0, Math.min(1, input.pressureRatio));
    if (fill > 0.001) {
      const grad = ctx.createLinearGradient(x, y, x + w, y);
      grad.addColorStop(0, '#4fd1c5');
      grad.addColorStop(0.6, '#f2d35e');
      grad.addColorStop(1, '#f2614f');
      roundRect(ctx, x, y, Math.max(h, w * fill), h, r);
      ctx.fillStyle = grad;
      ctx.globalAlpha = input.pressureWarning ? 0.75 + 0.25 * Math.sin(input.now / 110) : 1;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // a bright meniscus at the waterline, so the eye tracks the level
    if (fill > 0.02) {
      const edge = x + Math.max(h, w * fill);
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(edge - 1, y + 1);
      ctx.lineTo(edge - 1, y + h - 1);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // threshold ticks so the meter is readable at a glance
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const tx = Math.round(x + (w * i) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(tx, y + 2);
      ctx.lineTo(tx, y + h - 2);
      ctx.stroke();
    }
  }

  // ───────────────────────── board ─────────────────────────

  private drawBoard(input: RenderInput): void {
    const ctx = this.ctx;
    const l = this.layout;
    const { board } = input;

    roundRect(ctx, l.boardX - 4, l.boardY - 4, l.boardSize + 8, l.boardSize + 8, 10);
    ctx.fillStyle = INK.panel;
    ctx.fill();

    // near-miss highlight (lever 1: surface the near miss, do not hide it)
    const nearAlpha = 0.1 + 0.05 * Math.sin(input.now / 260);
    ctx.fillStyle = `rgba(242, 211, 94, ${nearAlpha.toFixed(3)})`;
    for (const r of input.nearMissRows) {
      ctx.fillRect(l.boardX, l.boardY + r * l.cell, l.boardSize, l.cell);
    }
    for (const c of input.nearMissCols) {
      ctx.fillRect(l.boardX + c * l.cell, l.boardY, l.cell, l.boardSize);
    }

    // drop preview: lines that would clear
    if (input.drag?.valid) {
      ctx.fillStyle = 'rgba(126, 224, 168, 0.17)';
      for (const r of input.drag.previewRows) {
        ctx.fillRect(l.boardX, l.boardY + r * l.cell, l.boardSize, l.cell);
      }
      for (const c of input.drag.previewCols) {
        ctx.fillRect(l.boardX + c * l.cell, l.boardY, l.cell, l.boardSize);
      }
    }

    // cells
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const i = r * SIZE + c;
        const v = board.cells[i]!;
        const x = l.boardX + c * l.cell;
        const y = l.boardY + r * l.cell;
        if (v === EMPTY) {
          roundRect(ctx, x + 1.5, y + 1.5, l.cell - 3, l.cell - 3, (l.cell - 3) * 0.3);
          ctx.fillStyle = INK.grid;
          ctx.fill();
        } else if (v === BALLAST) {
          this.drawBallast(x, y, l.cell, this.popScale(i, input.now));
        } else {
          this.drawBlock(x, y, l.cell, HUES[(v - 1) % HUES.length]!, 1, this.popScale(i, input.now));
        }
      }
    }

    // drag ghost on the board
    const drag = input.drag;
    if (drag?.target) {
      const { r, c } = drag.target;
      for (const cell of drag.piece.cells) {
        const x = l.boardX + (c + cell.c) * l.cell;
        const y = l.boardY + (r + cell.r) * l.cell;
        if (drag.valid) {
          this.drawBlock(x, y, l.cell, HUES[drag.piece.hue % HUES.length]!, 0.55);
        } else {
          roundRect(ctx, x + 2, y + 2, l.cell - 4, l.cell - 4, 4);
          ctx.strokeStyle = 'rgba(242, 97, 79, 0.8)';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    }
  }

  /**
   * A block is drawn as a fat-cornered bubble: a big corner radius, a bright
   * top-left gloss and a soft inner shade at the bottom. `scale` drives the
   * spring-in pop; it is applied around the cell centre so neighbours do not
   * shift when one block lands.
   */
  private drawBlock(
    x: number,
    y: number,
    size: number,
    color: string,
    alpha: number,
    scale = 1,
  ): void {
    const ctx = this.ctx;
    const inset = 1.5;
    const s = size - inset * 2;
    const radius = s * 0.34; // fat corners: reads as a bubble, not a tile

    ctx.save();
    if (scale !== 1) {
      ctx.translate(x + size / 2, y + size / 2);
      ctx.scale(scale, scale);
      ctx.translate(-(x + size / 2), -(y + size / 2));
    }
    ctx.globalAlpha = alpha;

    roundRect(ctx, x + inset, y + inset, s, s, radius);
    ctx.fillStyle = color;
    ctx.fill();

    // bottom shade — a touch of volume without a gradient per block
    ctx.globalAlpha = alpha * 0.18;
    roundRect(ctx, x + inset, y + inset + s * 0.45, s, s * 0.55, radius * 0.9);
    ctx.fillStyle = '#061018';
    ctx.fill();

    // top gloss
    ctx.globalAlpha = alpha * 0.4;
    roundRect(ctx, x + inset + s * 0.14, y + inset + s * 0.1, s * 0.72, s * 0.34, s * 0.17);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    // specular dot — the thing that actually makes it read as wet
    ctx.globalAlpha = alpha * 0.85;
    ctx.beginPath();
    ctx.arc(x + inset + s * 0.28, y + inset + s * 0.26, Math.max(1, s * 0.075), 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /** Spring-in scale for a cell that was filled at `placedAt`. */
  private popScale(index: number, now: number): number {
    const at = this.placedAt[index]!;
    if (at <= 0) return 1;
    const t = (now - at) / this.levers.placePopMs;
    if (t >= 1 || t < 0) return 1;
    const k = easeOutBack(clamp01(t), 1.2 + this.levers.placePopOvershoot * 4);
    return 0.55 + 0.45 * k;
  }

  /** Ballast reads as inert stone: no highlight, visible hatch, unmistakably not yours. */
  private drawBallast(x: number, y: number, size: number, scale = 1): void {
    const ctx = this.ctx;
    ctx.save();
    if (scale !== 1) {
      ctx.translate(x + size / 2, y + size / 2);
      ctx.scale(scale, scale);
      ctx.translate(-(x + size / 2), -(y + size / 2));
    }
    roundRect(ctx, x + 1.5, y + 1.5, size - 3, size - 3, 3);
    ctx.fillStyle = '#44506b';
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 2, y + 2, size - 4, size - 4);
    ctx.clip();
    ctx.strokeStyle = 'rgba(14,20,32,0.55)';
    ctx.lineWidth = 2;
    for (let i = -size; i < size; i += 6) {
      ctx.beginPath();
      ctx.moveTo(x + i, y);
      ctx.lineTo(x + i + size, y + size);
      ctx.stroke();
    }
    ctx.restore();
    ctx.restore();
  }

  // ───────────────────────── tray ─────────────────────────

  private drawTray(input: RenderInput): void {
    const ctx = this.ctx;
    const l = this.layout;

    for (let slot = 0; slot < 3; slot++) {
      const piece = input.tray[slot] ?? null;
      const center = this.traySlotCenter(slot);
      roundRect(ctx, l.pad + l.traySlotW * slot + 4, l.trayY, l.traySlotW - 8, l.trayH, 10);
      ctx.fillStyle = '#121a27';
      ctx.fill();
      if (!piece) continue;
      const beingDragged = input.drag?.trayIndex === slot;
      if (beingDragged) continue;
      // staggered spring-in so a refill has a rhythm instead of a blink
      const t = clamp01((input.now - this.trayPopAt[slot]!) / this.levers.trayPopMs);
      const scale = t >= 1 ? 1 : 0.4 + 0.6 * easeOutBack(t, 2.2);
      this.drawPieceAt(piece, center.x, center.y, l.trayCell * scale, 1);
    }

    // the dragged piece follows the pointer, offset up so a thumb does not cover it
    const drag = input.drag;
    if (drag && !drag.target) {
      this.drawPieceAt(drag.piece, drag.x, drag.y - l.cell * 1.1, l.cell * 0.92, 0.9);
    }
  }

  private drawPieceAt(piece: Piece, cx: number, cy: number, cellSize: number, alpha: number): void {
    const { rows, cols } = pieceSize(piece);
    const originX = cx - (cols * cellSize) / 2;
    const originY = cy - (rows * cellSize) / 2;
    for (const cell of piece.cells) {
      this.drawBlock(
        originX + cell.c * cellSize,
        originY + cell.r * cellSize,
        cellSize,
        HUES[piece.hue % HUES.length]!,
        alpha,
      );
    }
  }

  // ───────────────────────── fx ─────────────────────────

  private drawFx(input: RenderInput): void {
    const ctx = this.ctx;
    const l = this.layout;

    for (const fx of input.fx) {
      const t = (input.now - fx.startedAt) / fx.durationMs;
      if (t < 0 || t > 1) continue;
      const ease = 1 - (1 - t) * (1 - t);

      if (fx.kind === 'clear' && fx.cells) {
        for (const cell of fx.cells) {
          const x = l.boardX + cell.c * l.cell;
          const y = l.boardY + cell.r * l.cell;
          const grow = l.cell * (1 + ease * 0.5);
          const off = (grow - l.cell) / 2;
          ctx.globalAlpha = 1 - ease;
          roundRect(ctx, x - off, y - off, grow, grow, 6);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }

      if (fx.kind === 'surge' && fx.cells) {
        for (const cell of fx.cells) {
          const x = l.boardX + cell.c * l.cell;
          const y = l.boardY + cell.r * l.cell;
          ctx.globalAlpha = (1 - ease) * 0.85;
          roundRect(ctx, x, y, l.cell, l.cell, 5);
          ctx.fillStyle = '#f2614f';
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }

      if (fx.kind === 'text' || fx.kind === 'combo') {
        const anchor = fx.anchor ?? { r: SIZE / 2, c: SIZE / 2 };
        const x = l.boardX + (anchor.c + 0.5) * l.cell;
        const y = l.boardY + (anchor.r + 0.5) * l.cell - ease * l.cell * 1.6;
        const size = fx.kind === 'combo' ? l.cell * 0.9 : l.cell * 0.62;
        ctx.globalAlpha = 1 - ease * ease;
        ctx.font = `800 ${size.toFixed(0)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = Math.max(2, size * 0.14);
        ctx.strokeStyle = 'rgba(8,12,20,0.85)';
        ctx.strokeText(fx.text ?? '', x, y);
        ctx.fillStyle = fx.kind === 'combo' ? '#f2d35e' : '#eaf2ff';
        ctx.fillText(fx.text ?? '', x, y);
        ctx.globalAlpha = 1;
      }
    }
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
