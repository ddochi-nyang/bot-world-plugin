import type {
  AtmospherePhase,
  SoundMode,
  ThemeId,
  WeatherKind,
  WorldEvent,
} from '../src/types.ts';

export type SoundCueKind = 'needs_you' | 'task_done' | 'error' | 'handoff';
export type AmbientProfile = 'rain' | 'cafe_hum' | 'night_breeze';

export const DEFAULT_CUE_COOLDOWNS_MS: Readonly<Record<SoundCueKind, number>> = Object.freeze({
  needs_you: 3500,
  task_done: 1800,
  error: 4000,
  handoff: 900,
});

export function classifyEventSoundCue(event: WorldEvent): SoundCueKind | null {
  if (!event || typeof event !== 'object') return null;
  switch (event.kind) {
    case 'ItemNeedsYou':
    case 'Escalation':
      return 'needs_you';
    case 'ItemDone':
    case 'WorkerDone':
      return 'task_done';
    case 'BotFailed':
    case 'WorkerFailed':
      return 'error';
    case 'AutomationRun':
      if (!event.success) return 'error';
      return event.noReply ? null : 'task_done';
    case 'Handoff':
    case 'Question':
    case 'Reply':
    case 'StatusReport':
      return 'handoff';
    default:
      return null;
  }
}

export function resolveAmbientProfile(
  weatherKind: WeatherKind,
  phase: AtmospherePhase,
  _themeId: ThemeId
): AmbientProfile {
  if (weatherKind === 'rain') return 'rain';
  if (phase === 'night' || weatherKind === 'starlight') return 'night_breeze';
  return 'cafe_hum';
}

export type AudioParamLike = {
  setValueAtTime(value: number, startTime: number): void;
  linearRampToValueAtTime(value: number, endTime: number): void;
  exponentialRampToValueAtTime(value: number, endTime: number): void;
};

export type AudioNodeLike = {
  connect(destination: AudioNodeLike): AudioNodeLike;
  disconnect?(): void;
};

export type AudioGainNodeLike = AudioNodeLike & {
  gain: AudioParamLike;
};

export type AudioOscillatorLike = AudioNodeLike & {
  type: string;
  frequency: AudioParamLike;
  start(when?: number): void;
  stop(when?: number): void;
  onended: (() => void) | null;
};

export type AudioBiquadFilterLike = AudioNodeLike & {
  type: string;
  frequency: AudioParamLike;
  Q?: AudioParamLike;
};

export type AudioBufferLike = {
  getChannelData(channel: number): Float32Array;
};

export type AudioBufferSourceLike = AudioNodeLike & {
  buffer: AudioBufferLike | null;
  loop: boolean;
  start(when?: number): void;
  stop(when?: number): void;
  onended: (() => void) | null;
};

export type AudioContextLike = {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly state?: string;
  readonly destination: AudioNodeLike;
  resume?(): Promise<void> | void;
  close?(): Promise<void> | void;
  createGain(): AudioGainNodeLike;
  createOscillator(): AudioOscillatorLike;
  createBiquadFilter(): AudioBiquadFilterLike;
  createBuffer(numOfChannels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceLike;
};

function defaultCreateAudioContext(): AudioContextLike | null {
  if (typeof window === 'undefined') return null;
  const g = window as unknown as {
    AudioContext?: new () => AudioContextLike;
    webkitAudioContext?: new () => AudioContextLike;
  };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (typeof Ctor !== 'function') return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

export type SoundscapeOptions = {
  nowMs?: () => number;
  createAudioContext?: () => AudioContextLike | null;
  cooldownsMs?: Partial<Record<SoundCueKind, number>>;
};

export class SoundscapeEngine {
  private mode: SoundMode = 'off';
  private unlocked = false;
  private disposed = false;
  private audioCtx: AudioContextLike | null = null;
  private noiseBuffer: AudioBufferLike | null = null;
  private ambientProfile: AmbientProfile = 'cafe_hum';
  private activeAmbientNodes: {
    profile: AmbientProfile;
    stoppers: Array<() => void>;
    disconnectors: Array<() => void>;
  } | null = null;
  private activeCueStoppers = new Set<() => void>();
  private readonly lastPlayedAt = new Map<SoundCueKind, number>();
  private readonly nowMs: () => number;
  private readonly createAudioContext: () => AudioContextLike | null;
  private readonly cooldownsMs: Record<SoundCueKind, number>;

  constructor(options?: SoundscapeOptions) {
    this.nowMs = options?.nowMs ?? (() => Date.now());
    this.createAudioContext = options?.createAudioContext ?? defaultCreateAudioContext;
    this.cooldownsMs = {
      ...DEFAULT_CUE_COOLDOWNS_MS,
      ...(options?.cooldownsMs ?? {}),
    };
  }

  getMode(): SoundMode {
    return this.mode;
  }

  isUnlocked(): boolean {
    return this.unlocked && this.audioCtx !== null;
  }

  getAmbientProfile(): AmbientProfile {
    return this.ambientProfile;
  }

  unlockFromUserGesture(): boolean {
    if (this.disposed) return false;
    if (!this.audioCtx) {
      this.audioCtx = this.createAudioContext();
    }
    if (!this.audioCtx) {
      return false;
    }
    try {
      if (this.audioCtx.state === 'suspended' && typeof this.audioCtx.resume === 'function') {
        void Promise.resolve(this.audioCtx.resume()).catch(() => {});
      }
      this.unlocked = true;
      if (this.mode === 'ambient') {
        this.startAmbientLoop();
      }
      return true;
    } catch {
      return false;
    }
  }

  setMode(mode: SoundMode, options?: { fromUserGesture?: boolean }): void {
    if (this.disposed) return;
    if (options?.fromUserGesture && mode !== 'off') {
      this.unlockFromUserGesture();
    }
    this.mode = mode;
    if (mode === 'off') {
      this.stopAllAudioNodes();
      this.closeAudioContext();
      return;
    }
    if (mode === 'chimes') {
      this.stopAmbientLoop();
      return;
    }
    if (this.unlocked && this.audioCtx) {
      this.startAmbientLoop();
    }
  }

  updateAmbientContext(weatherKind: WeatherKind, phase: AtmospherePhase, themeId: ThemeId): void {
    const nextProfile = resolveAmbientProfile(weatherKind, phase, themeId);
    if (nextProfile === this.ambientProfile) {
      if (this.mode === 'ambient' && this.unlocked && this.audioCtx && !this.activeAmbientNodes) {
        this.startAmbientLoop();
      }
      return;
    }
    this.ambientProfile = nextProfile;
    if (this.mode === 'ambient' && this.unlocked && this.audioCtx) {
      this.stopAmbientLoop();
      this.startAmbientLoop();
    }
  }

  playCue(cue: SoundCueKind, options?: { suppressed?: boolean }): boolean {
    if (this.disposed || options?.suppressed || this.mode === 'off' || !this.unlocked || !this.audioCtx) {
      return false;
    }
    const now = this.nowMs();
    const cooldown = this.cooldownsMs[cue] ?? 1000;
    const prev = this.lastPlayedAt.get(cue);
    if (prev !== undefined && now - prev < cooldown) {
      return false;
    }
    this.lastPlayedAt.set(cue, now);

    try {
      this.synthesizeCue(this.audioCtx, cue);
      return true;
    } catch {
      return false;
    }
  }

  playEvents(events: readonly WorldEvent[], options?: { suppressed?: boolean }): number {
    if (this.disposed || options?.suppressed || this.mode === 'off' || !this.unlocked) {
      return 0;
    }
    let played = 0;
    for (const ev of events) {
      const cue = classifyEventSoundCue(ev);
      if (cue && this.playCue(cue, options)) {
        played += 1;
      }
    }
    return played;
  }

  playMilestoneCue(options?: { suppressed?: boolean }): boolean {
    return this.playCue('task_done', options);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAllAudioNodes();
    this.closeAudioContext();
    this.lastPlayedAt.clear();
  }

  private getOrCreatePinkNoiseBuffer(ctx: AudioContextLike): AudioBufferLike {
    if (this.noiseBuffer) return this.noiseBuffer;
    const sampleRate = Math.max(8000, ctx.sampleRate || 44100);
    const length = sampleRate * 2;
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);

    // Paul Kellet pink noise approximation (deterministic LCG for zero Math.random surprises)
    let seed = 0x13579bdf;
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    for (let i = 0; i < length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const white = (seed / 0x100000000) * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.09;
      b6 = white * 0.115926;
      data[i] = Math.max(-1, Math.min(1, pink));
    }

    this.noiseBuffer = buffer;
    return buffer;
  }

  private scheduleTone(
    ctx: AudioContextLike,
    freqHz: number,
    startOffsetSec: number,
    durationSec: number,
    peakGain: number,
    waveType: 'sine' | 'triangle'
  ): void {
    const t0 = ctx.currentTime + startOffsetSec;
    const tEnd = t0 + durationSec;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = waveType;
    osc.frequency.setValueAtTime(freqHz, t0);

    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peakGain, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, tEnd);

    osc.connect(gain);
    gain.connect(ctx.destination);

    const stopFn = () => {
      try {
        osc.stop();
      } catch {
        // Ignore already-stopped oscillator
      }
      try {
        osc.disconnect?.();
        gain.disconnect?.();
      } catch {
        // Ignore disconnect errors
      }
      this.activeCueStoppers.delete(stopFn);
    };
    this.activeCueStoppers.add(stopFn);
    osc.onended = stopFn;
    osc.start(t0);
    osc.stop(tEnd + 0.01);
  }

  private synthesizeCue(ctx: AudioContextLike, cue: SoundCueKind): void {
    switch (cue) {
      case 'needs_you':
        // Soft warm two-tone wooden knock / doorbell (E5 -> G5, gain ~0.10)
        this.scheduleTone(ctx, 659.25, 0, 0.13, 0.10, 'triangle');
        this.scheduleTone(ctx, 783.99, 0.11, 0.19, 0.095, 'sine');
        break;
      case 'task_done':
        // Crisp gentle harmonic chime (C5 -> E5 -> G5, gain ~0.08)
        this.scheduleTone(ctx, 523.25, 0, 0.16, 0.08, 'sine');
        this.scheduleTone(ctx, 659.25, 0.085, 0.18, 0.075, 'sine');
        this.scheduleTone(ctx, 783.99, 0.17, 0.25, 0.08, 'sine');
        break;
      case 'error':
        // Subtle muted low double-pulse (A3 -> F3, gain ~0.08)
        this.scheduleTone(ctx, 220.0, 0, 0.14, 0.08, 'triangle');
        this.scheduleTone(ctx, 174.61, 0.13, 0.18, 0.08, 'triangle');
        break;
      case 'handoff': {
        // Ultra-subtle short filtered noise brush (~45ms, gain ~0.04)
        const t0 = ctx.currentTime;
        const dur = 0.045;
        const src = ctx.createBufferSource();
        src.buffer = this.getOrCreatePinkNoiseBuffer(ctx);
        src.loop = false;

        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(1850, t0);
        filter.Q?.setValueAtTime(1.4, t0);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.linearRampToValueAtTime(0.04, t0 + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

        src.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);

        const stopFn = () => {
          try {
            src.stop();
          } catch {
            // Ignore
          }
          try {
            src.disconnect?.();
            filter.disconnect?.();
            gain.disconnect?.();
          } catch {
            // Ignore
          }
          this.activeCueStoppers.delete(stopFn);
        };
        this.activeCueStoppers.add(stopFn);
        src.onended = stopFn;
        src.start(t0);
        src.stop(t0 + dur + 0.01);
        break;
      }
    }
  }

  private startAmbientLoop(): void {
    const ctx = this.audioCtx;
    if (!ctx || this.disposed) return;
    if (this.activeAmbientNodes && this.activeAmbientNodes.profile === this.ambientProfile) {
      return;
    }
    this.stopAmbientLoop();

    try {
      const profile = this.ambientProfile;
      const t0 = ctx.currentTime;
      const stoppers: Array<() => void> = [];
      const disconnectors: Array<() => void> = [];

      const src = ctx.createBufferSource();
      src.buffer = this.getOrCreatePinkNoiseBuffer(ctx);
      src.loop = true;

      const filter = ctx.createBiquadFilter();
      const masterGain = ctx.createGain();

      if (profile === 'rain') {
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(1150, t0);
        filter.Q?.setValueAtTime(0.65, t0);
        masterGain.gain.setValueAtTime(0.0001, t0);
        masterGain.gain.linearRampToValueAtTime(0.036, t0 + 0.5);
      } else if (profile === 'night_breeze') {
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(380, t0);
        filter.Q?.setValueAtTime(0.8, t0);
        masterGain.gain.setValueAtTime(0.0001, t0);
        masterGain.gain.linearRampToValueAtTime(0.028, t0 + 0.6);
      } else {
        // Warm soft cafe/office hum
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(520, t0);
        filter.Q?.setValueAtTime(0.5, t0);
        masterGain.gain.setValueAtTime(0.0001, t0);
        masterGain.gain.linearRampToValueAtTime(0.022, t0 + 0.5);

        const warmOsc = ctx.createOscillator();
        const warmGain = ctx.createGain();
        warmOsc.type = 'sine';
        warmOsc.frequency.setValueAtTime(110, t0);
        warmGain.gain.setValueAtTime(0.005, t0);
        warmOsc.connect(warmGain);
        warmGain.connect(ctx.destination);
        warmOsc.start(t0);
        stoppers.push(() => warmOsc.stop());
        disconnectors.push(() => {
          warmOsc.disconnect?.();
          warmGain.disconnect?.();
        });
      }

      src.connect(filter);
      filter.connect(masterGain);
      masterGain.connect(ctx.destination);
      src.start(t0);

      stoppers.push(() => src.stop());
      disconnectors.push(() => {
        src.disconnect?.();
        filter.disconnect?.();
        masterGain.disconnect?.();
      });

      this.activeAmbientNodes = { profile, stoppers, disconnectors };
    } catch {
      this.activeAmbientNodes = null;
    }
  }

  private stopAmbientLoop(): void {
    const active = this.activeAmbientNodes;
    if (!active) return;
    this.activeAmbientNodes = null;
    for (const stop of active.stoppers) {
      try {
        stop();
      } catch {
        // Ignore
      }
    }
    for (const disc of active.disconnectors) {
      try {
        disc();
      } catch {
        // Ignore
      }
    }
  }

  private stopAllAudioNodes(): void {
    this.stopAmbientLoop();
    for (const stopCue of Array.from(this.activeCueStoppers)) {
      stopCue();
    }
    this.activeCueStoppers.clear();
  }

  private closeAudioContext(): void {
    const ctx = this.audioCtx;
    this.audioCtx = null;
    this.noiseBuffer = null;
    this.unlocked = false;
    if (ctx && typeof ctx.close === 'function') {
      try {
        void Promise.resolve(ctx.close()).catch(() => {});
      } catch {
        // Ignore close errors
      }
    }
  }
}
