import type { AtmospherePhase, ThemeId, WeatherKind, WeatherMode } from '../src/types.ts';

export const MAX_RAIN_PARTICLES = 70;
export const MAX_SNOW_PARTICLES = 55;
export const MAX_STARLIGHT_PARTICLES = 45;
export const MAX_RAIN_RIPPLES = 16;

export type WeatherParticle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  length: number;
  radius: number;
  alpha: number;
  swayAmp: number;
  swayFreq: number;
  phase: number;
  age: number;
  tint: string;
};

export type RainRipple = {
  x: number;
  y: number;
  age: number;
  duration: number;
  maxRadius: number;
};

export function resolveWeatherKind(
  mode: WeatherMode,
  atmospherePhase: AtmospherePhase,
  themeId: ThemeId
): WeatherKind {
  if (mode === 'clear' || mode === 'rain' || mode === 'snow' || mode === 'starlight') {
    return mode;
  }
  if (themeId === 'cozy_cafe') {
    return atmospherePhase === 'sunset' || atmospherePhase === 'night' ? 'rain' : 'clear';
  }
  if (atmospherePhase === 'night') {
    return 'starlight';
  }
  return 'clear';
}

export function maxParticlesForWeather(kind: WeatherKind): number {
  switch (kind) {
    case 'rain':
      return MAX_RAIN_PARTICLES;
    case 'snow':
      return MAX_SNOW_PARTICLES;
    case 'starlight':
      return MAX_STARLIGHT_PARTICLES;
    case 'clear':
      return 0;
  }
}

export class WeatherSystem {
  kind: WeatherKind = 'clear';
  particles: WeatherParticle[] = [];
  ripples: RainRipple[] = [];
  private rngSeed = 0x517cc1b7;
  private designW = 1376;
  private designH = 768;

  private nextRand(): number {
    this.rngSeed = (this.rngSeed * 1664525 + 1013904223) >>> 0;
    return this.rngSeed / 0x100000000;
  }

  clear(): void {
    this.kind = 'clear';
    this.particles = [];
    this.ripples = [];
  }

  syncKind(kind: WeatherKind, designSize: readonly [number, number]): void {
    const w = Math.max(100, Number.isFinite(designSize[0]) ? designSize[0] : 1376);
    const h = Math.max(100, Number.isFinite(designSize[1]) ? designSize[1] : 768);
    const sizeChanged = Math.abs(w - this.designW) > 2 || Math.abs(h - this.designH) > 2;
    if (this.kind === kind && !sizeChanged) {
      return;
    }
    this.designW = w;
    this.designH = h;
    if (this.kind !== kind) {
      this.kind = kind;
      this.particles = [];
      this.ripples = [];
      const count = maxParticlesForWeather(kind);
      for (let i = 0; i < count; i++) {
        this.particles.push(this.createParticle(kind, w, h, true));
      }
    }
  }

  step(dtSecs: number, kind: WeatherKind, designSize: readonly [number, number]): void {
    this.syncKind(kind, designSize);
    if (kind === 'clear') return;

    const dt = Math.max(0, Math.min(0.1, Number.isFinite(dtSecs) ? dtSecs : 0));
    if (dt <= 0) return;

    const w = this.designW;
    const h = this.designH;
    const cap = maxParticlesForWeather(kind);
    if (this.particles.length > cap) {
      this.particles.length = cap;
    }

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.age += dt;
      if (kind === 'rain') {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.y > h + 20 || p.x < -30) {
          if (this.ripples.length < MAX_RAIN_RIPPLES && this.nextRand() < 0.28) {
            this.ripples.push({
              x: Math.max(24, Math.min(w - 24, p.x < 0 ? w * this.nextRand() : p.x)),
              y: h * (0.68 + this.nextRand() * 0.28),
              age: 0,
              duration: 0.55 + this.nextRand() * 0.35,
              maxRadius: 9 + this.nextRand() * 7,
            });
          }
          this.particles[i] = this.createParticle('rain', w, h, false);
        }
      } else if (kind === 'snow') {
        p.x += (p.vx + Math.sin(p.age * p.swayFreq + p.phase) * p.swayAmp) * dt;
        p.y += p.vy * dt;
        if (p.y > h + 16) {
          this.particles[i] = this.createParticle('snow', w, h, false);
        } else if (p.x < -16) {
          p.x = w + 12;
        } else if (p.x > w + 16) {
          p.x = -12;
        }
      } else {
        // Starlight motes drift softly across upper zone
        p.x += (p.vx + Math.cos(p.age * p.swayFreq + p.phase) * p.swayAmp) * dt;
        p.y += Math.sin(p.age * (p.swayFreq * 0.7) + p.phase) * 5 * dt;
        if (p.x < -12) p.x = w + 10;
        else if (p.x > w + 12) p.x = -10;
        if (p.y < 14) p.y = 14;
        else if (p.y > h * 0.62) p.y = h * 0.62;
      }
    }

    if (kind === 'rain' && this.ripples.length > 0) {
      for (const r of this.ripples) {
        r.age += dt;
      }
      this.ripples = this.ripples.filter((r) => r.age < r.duration);
    }
  }

  private createParticle(
    kind: WeatherKind,
    w: number,
    h: number,
    initialScatter: boolean
  ): WeatherParticle {
    const r1 = this.nextRand();
    const r2 = this.nextRand();
    const r3 = this.nextRand();
    const r4 = this.nextRand();

    if (kind === 'rain') {
      const speedScale = 0.85 + r3 * 0.45;
      return {
        x: initialScatter ? r1 * (w + 140) : r1 * (w + 180),
        y: initialScatter ? r2 * h : -18 - r2 * 60,
        vx: -95 * speedScale,
        vy: 470 * speedScale,
        length: 13 + r4 * 11,
        radius: 1.1 + r3 * 0.5,
        alpha: 0.28 + r4 * 0.34,
        swayAmp: 0,
        swayFreq: 0,
        phase: 0,
        age: r3 * 2,
        tint: r4 > 0.5 ? '#bae6fd' : '#e0f2fe',
      };
    }

    if (kind === 'snow') {
      const depth = 0.5 + r3 * 0.9;
      return {
        x: r1 * w,
        y: initialScatter ? r2 * h : -10 - r2 * 40,
        vx: -8 + (r4 - 0.5) * 10,
        vy: 30 * depth + r4 * 16,
        length: 0,
        radius: 1.5 + depth * 1.6,
        alpha: 0.42 + r3 * 0.42,
        swayAmp: 14 + r4 * 14,
        swayFreq: 1.2 + r3 * 1.4,
        phase: r1 * Math.PI * 2,
        age: r2 * 4,
        tint: r4 > 0.35 ? '#f8fafc' : '#dbeafe',
      };
    }

    // starlight
    const tints = ['#fef08a', '#bae6fd', '#e9d5ff', '#fde68a'];
    return {
      x: r1 * w,
      y: 16 + r2 * (h * 0.54),
      vx: (r3 - 0.5) * 8,
      vy: 0,
      length: 0,
      radius: 1.8 + r4 * 2.0,
      alpha: 0.35 + r3 * 0.5,
      swayAmp: 6 + r4 * 6,
      swayFreq: 1.1 + r3 * 1.6,
      phase: r1 * Math.PI * 2,
      age: r2 * 5,
      tint: tints[Math.floor(r4 * tints.length) % tints.length],
    };
  }
}
