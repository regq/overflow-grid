/**
 * audio.ts — all sound is synthesised at runtime with WebAudio.
 * No sample files: nothing to licence, nothing to copy, ~0 bytes of payload,
 * and it works offline with no cache warm-up.
 */

export type Sfx = 'place' | 'clear' | 'combo' | 'surge' | 'gameover' | 'reward' | 'tap';

export class Audio {
  private ctx: AudioContext | null = null;
  private muted: boolean;

  constructor(muted: boolean) {
    this.muted = muted;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  /** Must be called from a user gesture on iOS before any sound will play. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctor) this.ctx = new Ctor();
    } catch {
      this.ctx = null;
    }
  }

  play(sfx: Sfx, intensity = 0): void {
    if (this.muted) return;
    this.unlock();
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;

    switch (sfx) {
      case 'tap':
        this.blip(t, 440, 0.04, 0.05, 'triangle');
        break;
      case 'place':
        this.blip(t, 240 + intensity * 20, 0.07, 0.09, 'triangle');
        break;
      case 'clear': {
        // ascending arpeggio; higher with combo intensity
        const root = 420 + intensity * 55;
        [0, 4, 7].forEach((semi, i) => {
          this.blip(t + i * 0.05, root * Math.pow(2, semi / 12), 0.12, 0.1, 'sine');
        });
        break;
      }
      case 'combo': {
        const root = 520 + intensity * 70;
        [0, 5, 9, 12].forEach((semi, i) => {
          this.blip(t + i * 0.045, root * Math.pow(2, semi / 12), 0.14, 0.09, 'sine');
        });
        break;
      }
      case 'surge':
        this.noise(t, 0.3, 0.12);
        this.blip(t, 110, 0.3, 0.14, 'sawtooth');
        break;
      case 'gameover':
        [0, -3, -7, -12].forEach((semi, i) => {
          this.blip(t + i * 0.13, 330 * Math.pow(2, semi / 12), 0.26, 0.1, 'sine');
        });
        break;
      case 'reward':
        [0, 7, 12, 16, 19].forEach((semi, i) => {
          this.blip(t + i * 0.06, 523 * Math.pow(2, semi / 12), 0.18, 0.08, 'sine');
        });
        break;
    }
  }

  private blip(at: number, freq: number, dur: number, gain: number, type: OscillatorType): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(gain, at + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(env).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  private noise(at: number, dur: number, gain: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const frames = Math.floor(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    }
    const src = ctx.createBufferSource();
    const env = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(900, at);
    src.buffer = buffer;
    env.gain.setValueAtTime(gain, at);
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(filter).connect(env).connect(ctx.destination);
    src.start(at);
  }
}
