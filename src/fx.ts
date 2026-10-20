/**
 * fx.ts — the bubble layer.
 *
 * Overflow Grid is a game about pressure in water, so the particles are bubbles:
 * they rise, they wobble, they pop. Ambient bubbles drift behind the grid, the
 * pressure meter releases more of them the closer it is to overflowing (the
 * threat is visible before it is numeric), and a clear bursts the cleared cells
 * into bubbles plus an expanding shock ring.
 *
 * Performance notes, because this runs on a mid-range phone at 60 fps:
 *   - fixed-size pool, allocated once; no per-frame allocation anywhere
 *   - dead particles are swapped to the tail rather than spliced
 *   - `maxParticles` is a lever and is enforced on spawn, not on draw
 *   - every particle is a filled arc; no shadows, no gradients per particle
 */

export type ParticleKind = 'bubble' | 'droplet' | 'ring';

interface Particle {
  alive: boolean;
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** radius in css px */
  r: number;
  life: number;
  maxLife: number;
  /** css colour */
  color: string;
  /** horizontal wobble phase + amount, so bubbles do not rise in straight lines */
  phase: number;
  wobble: number;
  alpha: number;
}

function makeParticle(): Particle {
  return {
    alive: false,
    kind: 'bubble',
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    r: 1,
    life: 0,
    maxLife: 1,
    color: '#fff',
    phase: 0,
    wobble: 0,
    alpha: 1,
  };
}

export class Fx {
  private pool: Particle[];
  private live = 0;
  private shake = 0;
  private shakeDecay = 0;

  constructor(private readonly max: number) {
    this.pool = Array.from({ length: max }, makeParticle);
  }

  get count(): number {
    return this.live;
  }

  clear(): void {
    for (const p of this.pool) p.alive = false;
    this.live = 0;
    this.shake = 0;
  }

  private take(): Particle | null {
    if (this.live >= this.max) return null;
    const p = this.pool[this.live]!;
    this.live++;
    p.alive = true;
    return p;
  }

  /** A rising bubble. `rise` is px/sec upward. */
  bubble(x: number, y: number, r: number, rise: number, color: string, lifeMs: number): void {
    const p = this.take();
    if (!p) return;
    p.kind = 'bubble';
    p.x = x;
    p.y = y;
    p.vx = 0;
    p.vy = -rise;
    p.r = r;
    p.life = lifeMs;
    p.maxLife = lifeMs;
    p.color = color;
    p.phase = Math.random() * Math.PI * 2;
    p.wobble = 6 + Math.random() * 14;
    p.alpha = 1;
  }

  /** A ballistic droplet — thrown outward, pulled down. */
  droplet(x: number, y: number, vx: number, vy: number, r: number, color: string, lifeMs: number): void {
    const p = this.take();
    if (!p) return;
    p.kind = 'droplet';
    p.x = x;
    p.y = y;
    p.vx = vx;
    p.vy = vy;
    p.r = r;
    p.life = lifeMs;
    p.maxLife = lifeMs;
    p.color = color;
    p.phase = 0;
    p.wobble = 0;
    p.alpha = 1;
  }

  /** An expanding, fading ring. `r` is the START radius; it grows to ~3.2x. */
  ring(x: number, y: number, r: number, color: string, lifeMs: number): void {
    const p = this.take();
    if (!p) return;
    p.kind = 'ring';
    p.x = x;
    p.y = y;
    p.vx = 0;
    p.vy = 0;
    p.r = r;
    p.life = lifeMs;
    p.maxLife = lifeMs;
    p.color = color;
    p.phase = 0;
    p.wobble = 0;
    p.alpha = 1;
  }

  /** A cell bursting into bubbles — the clear effect. */
  burst(cx: number, cy: number, cell: number, color: string, bubbles: number): void {
    const whole = Math.floor(bubbles);
    const extra = Math.random() < bubbles - whole ? 1 : 0;
    for (let i = 0; i < whole + extra; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 20 + Math.random() * 70;
      this.droplet(
        cx + (Math.random() - 0.5) * cell * 0.6,
        cy + (Math.random() - 0.5) * cell * 0.6,
        Math.cos(angle) * speed,
        Math.sin(angle) * speed - 40,
        cell * (0.08 + Math.random() * 0.14),
        color,
        420 + Math.random() * 320,
      );
    }
    this.bubble(cx, cy, cell * 0.2, 55 + Math.random() * 40, color, 620);
  }

  /** Nudge the whole board. Decays over `ms`. */
  kick(px: number, ms: number): void {
    this.shake = Math.max(this.shake, px);
    this.shakeDecay = px / Math.max(1, ms);
  }

  /** Current shake offset. Call once per frame, after update(). */
  shakeOffset(): { x: number; y: number } {
    if (this.shake <= 0.01) return { x: 0, y: 0 };
    return {
      x: (Math.random() - 0.5) * 2 * this.shake,
      y: (Math.random() - 0.5) * 2 * this.shake,
    };
  }

  /** @param dtMs frame delta, already clamped by the caller */
  update(dtMs: number): void {
    const dt = dtMs / 1000;

    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - this.shakeDecay * dtMs);
    }

    for (let i = 0; i < this.live; i++) {
      const p = this.pool[i]!;
      p.life -= dtMs;

      if (p.life <= 0) {
        // swap-with-tail removal keeps the live block contiguous and allocation-free
        this.live--;
        const tail = this.pool[this.live]!;
        this.pool[this.live] = p;
        this.pool[i] = tail;
        p.alive = false;
        i--;
        continue;
      }

      const t = 1 - p.life / p.maxLife;

      switch (p.kind) {
        case 'bubble':
          p.phase += dt * 3.2;
          p.x += Math.cos(p.phase) * p.wobble * dt;
          p.y += p.vy * dt;
          // bubbles accelerate slightly as they rise, like real ones shedding drag
          p.vy -= 18 * dt;
          p.alpha = t < 0.15 ? t / 0.15 : 1 - Math.max(0, (t - 0.6) / 0.4);
          break;
        case 'droplet':
          p.vy += 420 * dt; // gravity
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.vx *= 1 - 1.6 * dt; // drag
          p.alpha = 1 - t * t;
          break;
        case 'ring':
          p.alpha = (1 - t) * 0.65;
          break;
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    for (let i = 0; i < this.live; i++) {
      const p = this.pool[i]!;
      const t = 1 - p.life / p.maxLife;
      ctx.globalAlpha = Math.max(0, Math.min(1, p.alpha));

      if (p.kind === 'ring') {
        const r = p.r * (1 + t * 2.2);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(1, 3 * (1 - t));
        ctx.stroke();
        continue;
      }

      if (p.kind === 'bubble') {
        // outline + a small highlight reads as a bubble; a filled dot does not
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.globalAlpha *= 0.22;
        ctx.fill();
        ctx.globalAlpha = Math.max(0, Math.min(1, p.alpha)) * 0.8;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(p.x - p.r * 0.32, p.y - p.r * 0.32, Math.max(0.6, p.r * 0.24), 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        continue;
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

// ───────────────────────────── easing ─────────────────────────────

/** Overshoot-and-settle. `s` controls how far past 1 it goes. */
export function easeOutBack(t: number, s = 1.70158): number {
  const p = t - 1;
  return p * p * ((s + 1) * p + s) + 1;
}

export function easeOutCubic(t: number): number {
  const p = 1 - t;
  return 1 - p * p * p;
}

export function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** A value that chases a target over `ms`. Used for the score counter. */
export class Tween {
  private from = 0;
  private to = 0;
  private startedAt = -Infinity;

  constructor(private readonly ms: number) {}

  set(value: number, now: number): void {
    if (this.to === value) return;
    this.from = this.valueAt(now);
    this.to = value;
    this.startedAt = now;
  }

  /** Jump straight to a value with no animation (new game, reset). */
  snap(value: number): void {
    this.from = value;
    this.to = value;
    this.startedAt = -Infinity;
  }

  valueAt(now: number): number {
    if (!Number.isFinite(this.startedAt)) return this.to;
    const t = clamp01((now - this.startedAt) / this.ms);
    return this.from + (this.to - this.from) * easeOutCubic(t);
  }

  get target(): number {
    return this.to;
  }
}
