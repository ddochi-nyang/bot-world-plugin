import { scrubAll } from '../src/redact.ts';
import {
  type BossKind,
  type BossRaidMode,
  type BossRaidStats,
  type PomodoroPresetMinutes,
  type RecordRaidOutcomeInput,
  type StuckAlert,
  type ThemeId,
  type UiLocale,
  type ViewMode,
  type WorldEvent,
  type WorldSnapshot,
  isSafeKey,
  isValidBossKind,
  isValidPomodoroPreset,
  isWorkerActive,
  stripDangerousKeys,
} from '../src/types.ts';
import type { ThemeConfig } from './assets-catalog.ts';
import type { ViewportTransform } from './camera.ts';
import { clearChildren, el } from './dom.ts';
import { getBotRedactedAlias } from './filter.ts';
import { tStrings } from './i18n.ts';
import type { MotionDirector, Rect } from './motion.ts';
import type { SoundCueKind } from './soundscape.ts';

export const MAX_DAMAGE_FLOATS = 24;
export const MAX_ATTACK_BEAMS = 12;
export const MAX_RAID_PARTICLES = 36;
export const OWNER_STRIKE_COOLDOWN_MS = 250;
export const LIVE_RESPAWN_COOLDOWN_MS = 15_000;
export const DEMO_RESPAWN_COOLDOWN_MS = 6_000;
export const POMODORO_DPS = 0.65;
export const NORMAL_EVENT_DAMAGE = 12;
export const CRIT_EVENT_DAMAGE = 28;
export const OWNER_STRIKE_DAMAGE = 15;

export const MAX_RAID_STAT_TOTAL = 1_000_000_000;
export const MAX_RAID_STREAK = 10_000;
export const MAX_FOCUS_MINUTES_PER_EVENT = 180;
export const MAX_DAMAGE_PER_EVENT = 50_000;
export const TRANSIENT_THREAT_HOLD_MS = 20_000;

const THREAT_PRIORITY: Readonly<Record<BossKind, number>> = {
  sprint_titan: 1,
  stall_golem: 2,
  error_blob: 3,
  ci_wyvern: 4,
};

export const RAID_BOSS_CATALOG: Readonly<
  Record<
    BossKind,
    {
      maxHp: number;
      primaryColor: string;
      secondaryColor: string;
      accentColor: string;
      beamColor: string;
    }
  >
> = Object.freeze({
  error_blob: {
    maxHp: 220,
    primaryColor: '#e11d48',
    secondaryColor: '#9f1239',
    accentColor: '#fda4af',
    beamColor: '#fb7185',
  },
  stall_golem: {
    maxHp: 280,
    primaryColor: '#64748b',
    secondaryColor: '#334155',
    accentColor: '#fbbf24',
    beamColor: '#facc15',
  },
  ci_wyvern: {
    maxHp: 360,
    primaryColor: '#dc2626',
    secondaryColor: '#7f1d1d',
    accentColor: '#fb923c',
    beamColor: '#f97316',
  },
  sprint_titan: {
    maxHp: 320,
    primaryColor: '#4f46e5',
    secondaryColor: '#1e1b4b',
    accentColor: '#38bdf8',
    beamColor: '#38bdf8',
  },
});

const ALLOWED_OUTCOME_KEYS = new Set([
  'cleared',
  'pomodoroCompleted',
  'focusMinutes',
  'damageDealt',
  'resetStreak',
]);

function clampNonNegInt(val: unknown, max: number): number {
  if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) return 0;
  return Math.max(0, Math.min(max, Math.trunc(val)));
}

export function createEmptyBossRaidStats(nowMs = 0): BossRaidStats {
  const safeNow =
    typeof nowMs === 'number' && Number.isFinite(nowMs) && nowMs >= 0 ? Math.trunc(nowMs) : 0;
  return {
    version: 1,
    raidsCleared: 0,
    pomodorosCompleted: 0,
    totalFocusMinutes: 0,
    totalDamage: 0,
    currentStreak: 0,
    bestStreak: 0,
    updatedAtMs: safeNow,
  };
}

export function sanitizeBossRaidStats(raw: unknown, nowMs = 0): BossRaidStats {
  const base = createEmptyBossRaidStats(nowMs);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return base;
  }
  const clean = stripDangerousKeys(raw as Record<string, unknown>);
  const raidsCleared = clampNonNegInt(clean.raidsCleared, MAX_RAID_STAT_TOTAL);
  const pomodorosCompleted = clampNonNegInt(clean.pomodorosCompleted, MAX_RAID_STAT_TOTAL);
  const totalFocusMinutes = clampNonNegInt(clean.totalFocusMinutes, MAX_RAID_STAT_TOTAL);
  const totalDamage = clampNonNegInt(clean.totalDamage, MAX_RAID_STAT_TOTAL);
  const currentStreak = clampNonNegInt(clean.currentStreak, MAX_RAID_STREAK);
  const rawBest = clampNonNegInt(clean.bestStreak, MAX_RAID_STREAK);
  const bestStreak = Math.max(currentStreak, rawBest);
  const updatedAtMs =
    typeof clean.updatedAtMs === 'number' &&
    Number.isFinite(clean.updatedAtMs) &&
    clean.updatedAtMs >= 0
      ? Math.trunc(clean.updatedAtMs)
      : base.updatedAtMs;
  return {
    version: 1,
    raidsCleared,
    pomodorosCompleted,
    totalFocusMinutes,
    totalDamage,
    currentStreak,
    bestStreak,
    updatedAtMs,
  };
}

export function validateRecordRaidOutcomeInput(
  raw: unknown
): { ok: true; value: RecordRaidOutcomeInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'input must be an object' };
  }
  const rawObj = raw as Record<string, unknown>;
  for (const key of Object.keys(rawObj)) {
    if (!ALLOWED_OUTCOME_KEYS.has(key)) {
      return { ok: false, error: `Unsupported field: ${key}` };
    }
  }
  const clean = stripDangerousKeys(rawObj);
  const out: RecordRaidOutcomeInput = {};
  if (clean.cleared !== undefined) {
    if (typeof clean.cleared !== 'boolean') {
      return { ok: false, error: 'cleared must be a boolean' };
    }
    out.cleared = clean.cleared;
  }
  if (clean.pomodoroCompleted !== undefined) {
    if (typeof clean.pomodoroCompleted !== 'boolean') {
      return { ok: false, error: 'pomodoroCompleted must be a boolean' };
    }
    out.pomodoroCompleted = clean.pomodoroCompleted;
  }
  if (clean.resetStreak !== undefined) {
    if (typeof clean.resetStreak !== 'boolean') {
      return { ok: false, error: 'resetStreak must be a boolean' };
    }
    out.resetStreak = clean.resetStreak;
  }
  if (clean.focusMinutes !== undefined) {
    if (
      typeof clean.focusMinutes !== 'number' ||
      !Number.isFinite(clean.focusMinutes) ||
      clean.focusMinutes < 0
    ) {
      return { ok: false, error: 'focusMinutes must be a non-negative finite number' };
    }
    out.focusMinutes = Math.min(MAX_FOCUS_MINUTES_PER_EVENT, Math.trunc(clean.focusMinutes));
  }
  if (clean.damageDealt !== undefined) {
    if (
      typeof clean.damageDealt !== 'number' ||
      !Number.isFinite(clean.damageDealt) ||
      clean.damageDealt < 0
    ) {
      return { ok: false, error: 'damageDealt must be a non-negative finite number' };
    }
    out.damageDealt = Math.min(MAX_DAMAGE_PER_EVENT, Math.trunc(clean.damageDealt));
  }
  return { ok: true, value: out };
}

export function applyRaidOutcomeToStats(
  prev: BossRaidStats,
  input: RecordRaidOutcomeInput,
  nowMs: number
): BossRaidStats {
  const safePrev = sanitizeBossRaidStats(prev, nowMs);
  const raidsCleared = Math.min(
    MAX_RAID_STAT_TOTAL,
    safePrev.raidsCleared + (input.cleared ? 1 : 0)
  );
  const pomodorosCompleted = Math.min(
    MAX_RAID_STAT_TOTAL,
    safePrev.pomodorosCompleted + (input.pomodoroCompleted ? 1 : 0)
  );
  const addFocus = clampNonNegInt(input.focusMinutes ?? 0, MAX_FOCUS_MINUTES_PER_EVENT);
  const totalFocusMinutes = Math.min(MAX_RAID_STAT_TOTAL, safePrev.totalFocusMinutes + addFocus);
  const addDamage = clampNonNegInt(input.damageDealt ?? 0, MAX_DAMAGE_PER_EVENT);
  const totalDamage = Math.min(MAX_RAID_STAT_TOTAL, safePrev.totalDamage + addDamage);

  let currentStreak = safePrev.currentStreak;
  if (input.resetStreak) {
    currentStreak = 0;
  } else if (input.pomodoroCompleted) {
    currentStreak = Math.min(MAX_RAID_STREAK, currentStreak + 1);
  }
  const bestStreak = Math.max(safePrev.bestStreak, currentStreak);
  const safeNow =
    typeof nowMs === 'number' && Number.isFinite(nowMs) && nowMs >= 0
      ? Math.max(safePrev.updatedAtMs, Math.trunc(nowMs))
      : safePrev.updatedAtMs;

  return {
    version: 1,
    raidsCleared,
    pomodorosCompleted,
    totalFocusMinutes,
    totalDamage,
    currentStreak,
    bestStreak,
    updatedAtMs: safeNow,
  };
}

export type RaidSuppressionReason = 'off' | 'replay' | 'pet' | 'broadcast' | 'theater';

export function resolveRaidSuppressionReason(opts: {
  isReplay?: boolean;
  viewMode?: ViewMode;
  bossRaidMode?: BossRaidMode;
  isTheater?: boolean;
}): RaidSuppressionReason | null {
  if (opts.bossRaidMode === 'off') return 'off';
  if (opts.isTheater) return 'theater';
  if (opts.isReplay) return 'replay';
  if (opts.viewMode === 'pet') return 'pet';
  if (opts.viewMode === 'broadcast') return 'broadcast';
  return null;
}

export type BossEncounterSource = 'pomodoro' | 'threat' | 'practice';

export type EvaluatedThreat = {
  kind: BossKind;
  source: BossEncounterSource;
};

export function evaluateBossEncounter(opts: {
  snapshot: WorldSnapshot;
  stuckAlerts?: readonly StuckAlert[];
  events?: readonly WorldEvent[];
  pomodoroActive: boolean;
  currentStreak: number;
  practiceBossKind: BossKind | null;
}): EvaluatedThreat | null {
  if (opts.pomodoroActive) {
    return {
      kind: opts.currentStreak >= 2 ? 'ci_wyvern' : 'sprint_titan',
      source: 'pomodoro',
    };
  }

  const errorBotIds = new Set<string>();
  const failedAutoIds = new Set<string>();
  let workerFailures = 0;
  let needsYouCount = 0;
  let workingBots = 0;

  for (const [botId, bot] of Object.entries(opts.snapshot.bots)) {
    if (!isSafeKey(botId) || !bot) continue;
    if (bot.status.kind === 'Error') {
      errorBotIds.add(botId);
    } else if (bot.status.kind === 'NeedsOwner') {
      needsYouCount += 1;
    } else if (bot.status.kind === 'Working') {
      workingBots += 1;
    }
  }

  for (const [autoId, auto] of Object.entries(opts.snapshot.automations)) {
    if (!isSafeKey(autoId) || !auto) continue;
    if (auto.enabled && auto.lastRunStatus === 'failed') {
      failedAutoIds.add(autoId);
    }
  }

  for (const rawEv of opts.events ?? []) {
    if (!rawEv || typeof rawEv !== 'object') continue;
    const ev = rawEv as WorldEvent | { kind: string; botId?: string; automationId?: string; success?: boolean };
    switch (ev.kind) {
      case 'BotFailed':
      case 'BotError':
        if (typeof ev.botId === 'string' && ev.botId.length > 0) {
          errorBotIds.add(ev.botId);
        } else {
          workerFailures += 1;
        }
        break;
      case 'WorkerFailed':
        workerFailures += 1;
        break;
      case 'AutomationError':
        if (typeof ev.automationId === 'string' && ev.automationId.length > 0) {
          failedAutoIds.add(ev.automationId);
        } else {
          workerFailures += 1;
        }
        break;
      case 'AutomationRun':
        if (ev.success === false) {
          if (typeof ev.automationId === 'string' && ev.automationId.length > 0) {
            failedAutoIds.add(ev.automationId);
          } else {
            workerFailures += 1;
          }
        }
        break;
    }
  }

  const totalErrorCount = errorBotIds.size + failedAutoIds.size + workerFailures;
  const stuckCount = opts.stuckAlerts?.length ?? 0;
  let activeWorkers = 0;
  for (const w of Object.values(opts.snapshot.workers)) {
    if (w && isWorkerActive(w)) activeWorkers += 1;
  }

  if (totalErrorCount >= 2) {
    return { kind: 'ci_wyvern', source: 'threat' };
  }
  if (totalErrorCount >= 1) {
    return { kind: 'error_blob', source: 'threat' };
  }
  if (stuckCount >= 1 || needsYouCount >= 2) {
    return { kind: 'stall_golem', source: 'threat' };
  }
  if (workingBots + activeWorkers >= 4) {
    return { kind: 'sprint_titan', source: 'threat' };
  }

  if (opts.practiceBossKind && isValidBossKind(opts.practiceBossKind)) {
    return { kind: opts.practiceBossKind, source: 'practice' };
  }

  return null;
}

export type AttackBeam = {
  id: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  colorHex: string;
  isCrit: boolean;
  age: number;
  ttl: number;
};

export type DamageFloat = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  damage: number;
  isCrit: boolean;
  age: number;
  ttl: number;
};

export type RaidVictoryParticle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  gravity: number;
  age: number;
  ttl: number;
  colorHex: string;
  size: number;
};

export type RaidVictoryBanner = {
  bossKind: BossKind;
  ttl: number;
  maxTtl: number;
};

export type ActiveBossState = {
  kind: BossKind;
  source: BossEncounterSource;
  hp: number;
  maxHp: number;
  hitFlashSecs: number;
  spawnedAtMs: number;
  totalDamageTaken: number;
};

export type PomodoroState = {
  presetMinutes: PomodoroPresetMinutes;
  running: boolean;
  paused: boolean;
  remainingSecs: number;
  totalSecs: number;
  dpsAccumulator: number;
};

export type RaidOutcomeCallback = (outcome: RecordRaidOutcomeInput) => void;
export type RaidSoundCallback = (cue: Extract<SoundCueKind, 'raid_spawn' | 'raid_hit' | 'raid_victory'>) => void;

export type BossRaidStepInput = {
  snapshot: WorldSnapshot;
  theme: ThemeConfig;
  motion?: MotionDirector;
  stuckAlerts?: readonly StuckAlert[];
  bossRaidMode?: BossRaidMode;
  viewMode?: ViewMode;
  isReplay?: boolean;
  isTheater?: boolean;
  demoMode?: boolean;
  currentStreak?: number;
  nowMs?: number;
  onOutcome?: RaidOutcomeCallback;
  onSoundCue?: RaidSoundCallback;
};

export function classifyRaidAttackEvent(
  rawEvent: WorldEvent | Record<string, unknown>
): { damage: number; isCrit: boolean; botId: string | null } | null {
  if (!rawEvent || typeof rawEvent !== 'object') return null;
  const ev = rawEvent as {
    kind?: string;
    botId?: string;
    parentBotId?: string | null;
    from?: { kind?: string; botId?: string; parentBotId?: string | null };
    success?: boolean;
    noReply?: boolean;
  };
  switch (ev.kind) {
    case 'ItemDone':
      return {
        damage: CRIT_EVENT_DAMAGE,
        isCrit: true,
        botId: typeof ev.botId === 'string' && ev.botId ? ev.botId : null,
      };
    case 'WorkerDone':
    case 'WorkDone':
      return {
        damage: CRIT_EVENT_DAMAGE,
        isCrit: true,
        botId:
          typeof ev.parentBotId === 'string' && ev.parentBotId
            ? ev.parentBotId
            : typeof ev.botId === 'string' && ev.botId
              ? ev.botId
              : null,
      };
    case 'BotWorking':
    case 'WorkStarted':
    case 'ToolChanged':
    case 'ToolStart':
      return {
        damage: NORMAL_EVENT_DAMAGE,
        isCrit: false,
        botId: typeof ev.botId === 'string' && ev.botId ? ev.botId : null,
      };
    case 'WorkerStart':
      return {
        damage: NORMAL_EVENT_DAMAGE,
        isCrit: false,
        botId: typeof ev.parentBotId === 'string' && ev.parentBotId ? ev.parentBotId : null,
      };
    case 'Handoff':
    case 'Question':
    case 'StatusReport':
    case 'Reply': {
      const fromBot =
        ev.from?.kind === 'Bot' && typeof ev.from.botId === 'string'
          ? ev.from.botId
          : ev.from?.kind === 'Worker' && typeof ev.from.parentBotId === 'string'
            ? ev.from.parentBotId
            : null;
      return {
        damage: NORMAL_EVENT_DAMAGE,
        isCrit: false,
        botId: fromBot,
      };
    }
    case 'BossReplied':
    case 'MessageSent':
      return {
        damage: NORMAL_EVENT_DAMAGE,
        isCrit: false,
        botId: typeof ev.botId === 'string' && ev.botId ? ev.botId : null,
      };
    case 'AutomationRun':
      if (ev.success && !ev.noReply) {
        return {
          damage: NORMAL_EVENT_DAMAGE,
          isCrit: false,
          botId: typeof ev.botId === 'string' && ev.botId ? ev.botId : null,
        };
      }
      return null;
    default:
      return null;
  }
}

export function resolveBossAnchorDesignPos(theme: ThemeConfig): [number, number] {
  switch (theme.id) {
    case 'corporate_office':
      return [505, 192];
    case 'cozy_cafe':
      return [485, 196];
    case 'cyber_ops':
      return [535, 182];
    case 'startup_office':
    default:
      return [458, 206];
  }
}

export class BossRaidEngine {
  activeBoss: ActiveBossState | null = null;
  pomodoro: PomodoroState = {
    presetMinutes: 25,
    running: false,
    paused: false,
    remainingSecs: 25 * 60,
    totalSecs: 25 * 60,
    dpsAccumulator: 0,
  };
  practiceBossKind: BossKind | null = null;
  beams: AttackBeam[] = [];
  damageFloats: DamageFloat[] = [];
  particles: RaidVictoryParticle[] = [];
  victoryBanner: RaidVictoryBanner | null = null;
  lastOwnerStrikeAtMs = -Infinity;
  respawnCooldownUntilMs = 0;
  elapsedSecs = 0;

  private readonly botDamageByBotId = new Map<string, number>();
  private nextId = 1;
  private rngSeed = 0x51a7b055;
  private suppressed = false;
  private suppressionReason: RaidSuppressionReason | null = null;
  private pendingDamageForStats = 0;
  private practiceCycleIdx = 0;
  private transientThreatKind: BossKind | null = null;
  private transientThreatUntilMs = 0;

  private nextRand(): number {
    this.rngSeed = (this.rngSeed * 1664525 + 1013904223) >>> 0;
    return this.rngSeed / 0x100000000;
  }

  reset(): void {
    this.activeBoss = null;
    this.practiceBossKind = null;
    this.pomodoro = {
      presetMinutes: 25,
      running: false,
      paused: false,
      remainingSecs: 25 * 60,
      totalSecs: 25 * 60,
      dpsAccumulator: 0,
    };
    this.beams = [];
    this.damageFloats = [];
    this.particles = [];
    this.victoryBanner = null;
    this.botDamageByBotId.clear();
    this.lastOwnerStrikeAtMs = -Infinity;
    this.respawnCooldownUntilMs = 0;
    this.pendingDamageForStats = 0;
    this.transientThreatKind = null;
    this.transientThreatUntilMs = 0;
    this.suppressed = false;
    this.suppressionReason = null;
  }

  isSuppressed(): boolean {
    return this.suppressed;
  }

  getSuppressionReason(): RaidSuppressionReason | null {
    return this.suppressionReason;
  }

  isPomodoroActive(): boolean {
    return this.pomodoro.running || this.pomodoro.paused;
  }

  isPomodoroRunning(): boolean {
    return this.pomodoro.running && !this.pomodoro.paused;
  }

  isInRespawnCooldown(nowMs: number = Date.now()): boolean {
    return this.respawnCooldownUntilMs > nowMs;
  }

  respawnCooldownRemainingSecs(nowMs: number = Date.now()): number {
    if (this.respawnCooldownUntilMs <= nowMs) return 0;
    return Math.ceil((this.respawnCooldownUntilMs - nowMs) / 1000);
  }

  hasActiveVisuals(): boolean {
    return (
      (!this.suppressed && this.activeBoss !== null) ||
      this.beams.length > 0 ||
      this.damageFloats.length > 0 ||
      this.particles.length > 0 ||
      this.victoryBanner !== null
    );
  }

  setPomodoroPreset(minutes: PomodoroPresetMinutes): void {
    if (!isValidPomodoroPreset(minutes)) return;
    this.pomodoro.presetMinutes = minutes;
    if (!this.pomodoro.running && !this.pomodoro.paused) {
      this.pomodoro.totalSecs = minutes * 60;
      this.pomodoro.remainingSecs = minutes * 60;
      this.pomodoro.dpsAccumulator = 0;
    }
  }

  startPomodoro(
    minutes: PomodoroPresetMinutes = this.pomodoro.presetMinutes,
    opts?: {
      currentStreak?: number;
      nowMs?: number;
      bossRaidMode?: BossRaidMode;
      viewMode?: ViewMode;
      isReplay?: boolean;
      isTheater?: boolean;
      onSoundCue?: RaidSoundCallback;
    }
  ): void {
    const preset: PomodoroPresetMinutes = isValidPomodoroPreset(minutes) ? minutes : 25;
    this.pomodoro = {
      presetMinutes: preset,
      running: true,
      paused: false,
      remainingSecs: preset * 60,
      totalSecs: preset * 60,
      dpsAccumulator: 0,
    };
    this.respawnCooldownUntilMs = 0;
    const suppression = resolveRaidSuppressionReason({
      bossRaidMode: opts?.bossRaidMode,
      viewMode: opts?.viewMode,
      isReplay: opts?.isReplay,
      isTheater: opts?.isTheater,
    });
    if (!suppression) {
      const kind: BossKind = (opts?.currentStreak ?? 0) >= 2 ? 'ci_wyvern' : 'sprint_titan';
      if (!this.activeBoss || this.activeBoss.source !== 'pomodoro') {
        this.spawnBoss(kind, 'pomodoro', opts?.nowMs ?? Date.now(), opts?.onSoundCue);
      }
    }
  }

  pausePomodoro(): void {
    if (!this.pomodoro.running) return;
    this.pomodoro.running = false;
    this.pomodoro.paused = true;
  }

  resumePomodoro(): void {
    if (!this.pomodoro.paused) return;
    this.pomodoro.running = true;
    this.pomodoro.paused = false;
  }

  abandonPomodoro(opts?: {
    demoMode?: boolean;
    onOutcome?: RaidOutcomeCallback;
  }): void {
    const wasActive = this.pomodoro.running || this.pomodoro.paused;
    const preset = this.pomodoro.presetMinutes;
    this.pomodoro = {
      presetMinutes: preset,
      running: false,
      paused: false,
      remainingSecs: preset * 60,
      totalSecs: preset * 60,
      dpsAccumulator: 0,
    };
    if (this.activeBoss?.source === 'pomodoro') {
      this.activeBoss = null;
      this.botDamageByBotId.clear();
    }
    if (wasActive && !opts?.demoMode) {
      const damageToFlush = this.consumePendingDamage();
      opts?.onOutcome?.({
        resetStreak: true,
        ...(damageToFlush > 0 ? { damageDealt: damageToFlush } : {}),
      });
    } else if (wasActive) {
      this.pendingDamageForStats = 0;
      opts?.onOutcome?.({ resetStreak: true });
    }
  }

  summonPracticeBoss(
    kind?: BossKind,
    opts?: {
      nowMs?: number;
      bossRaidMode?: BossRaidMode;
      viewMode?: ViewMode;
      isReplay?: boolean;
      isTheater?: boolean;
      onSoundCue?: RaidSoundCallback;
    }
  ): BossKind | null {
    const suppression = resolveRaidSuppressionReason({
      bossRaidMode: opts?.bossRaidMode,
      viewMode: opts?.viewMode,
      isReplay: opts?.isReplay,
      isTheater: opts?.isTheater,
    });
    if (suppression || this.isPomodoroActive() || this.activeBoss?.source === 'threat') {
      return null;
    }
    const order: readonly BossKind[] = ['error_blob', 'stall_golem', 'ci_wyvern', 'sprint_titan'];
    const targetKind =
      kind && isValidBossKind(kind)
        ? kind
        : order[this.practiceCycleIdx++ % order.length];
    this.practiceBossKind = targetKind;
    this.respawnCooldownUntilMs = 0;
    this.transientThreatKind = null;
    this.transientThreatUntilMs = 0;
    this.spawnBoss(targetKind, 'practice', opts?.nowMs ?? Date.now(), opts?.onSoundCue);
    return targetKind;
  }

  private spawnBoss(
    kind: BossKind,
    source: BossEncounterSource,
    nowMs: number,
    onSoundCue?: RaidSoundCallback
  ): void {
    const spec = RAID_BOSS_CATALOG[kind];
    this.activeBoss = {
      kind,
      source,
      hp: spec.maxHp,
      maxHp: spec.maxHp,
      hitFlashSecs: 0,
      spawnedAtMs: nowMs,
      totalDamageTaken: 0,
    };
    this.botDamageByBotId.clear();
    onSoundCue?.('raid_spawn');
  }

  syncState(input: BossRaidStepInput & { events?: readonly WorldEvent[] }): void {
    const nowMs = input.nowMs ?? Date.now();
    const suppression = resolveRaidSuppressionReason({
      isReplay: input.isReplay,
      viewMode: input.viewMode,
      bossRaidMode: input.bossRaidMode,
      isTheater: input.isTheater,
    });
    this.suppressionReason = suppression;
    this.suppressed = suppression !== null;

    if (this.suppressed) {
      if (input.bossRaidMode === 'off') {
        this.activeBoss = null;
        this.practiceBossKind = null;
        this.transientThreatKind = null;
        this.transientThreatUntilMs = 0;
        this.beams = [];
        this.damageFloats = [];
        this.particles = [];
        this.victoryBanner = null;
      }
      return;
    }

    if (nowMs < this.respawnCooldownUntilMs) {
      return;
    }

    const evaluated = evaluateBossEncounter({
      snapshot: input.snapshot,
      stuckAlerts: input.stuckAlerts,
      events: input.events,
      pomodoroActive: this.isPomodoroActive(),
      currentStreak: input.currentStreak ?? 0,
      practiceBossKind: this.practiceBossKind,
    });

    if (input.events && input.events.length > 0 && evaluated?.source === 'threat') {
      const snapshotOnly = evaluateBossEncounter({
        snapshot: input.snapshot,
        stuckAlerts: input.stuckAlerts,
        pomodoroActive: false,
        currentStreak: 0,
        practiceBossKind: null,
      });
      if (
        !snapshotOnly ||
        snapshotOnly.source !== 'threat' ||
        THREAT_PRIORITY[evaluated.kind] > THREAT_PRIORITY[snapshotOnly.kind]
      ) {
        this.transientThreatKind = evaluated.kind;
        this.transientThreatUntilMs = nowMs + TRANSIENT_THREAT_HOLD_MS;
      } else {
        this.transientThreatKind = null;
        this.transientThreatUntilMs = 0;
      }
    }

    if (!evaluated) {
      if (
        this.activeBoss?.source === 'threat' &&
        this.transientThreatKind === this.activeBoss.kind &&
        nowMs < this.transientThreatUntilMs
      ) {
        return;
      }
      this.transientThreatKind = null;
      this.transientThreatUntilMs = 0;
      // Calm office: clear threat boss if threat resolved (keep practice boss until defeated)
      if (this.activeBoss && this.activeBoss.source !== 'practice') {
        this.activeBoss = null;
        this.botDamageByBotId.clear();
      }
      return;
    }

    if (!this.activeBoss) {
      this.spawnBoss(evaluated.kind, evaluated.source, nowMs, input.onSoundCue);
      return;
    }

    // Upgrade priority: Pomodoro boss overrides threat/practice, higher-priority untouched threat promotes
    if (
      evaluated.source === 'pomodoro' &&
      this.activeBoss.source !== 'pomodoro'
    ) {
      this.transientThreatKind = null;
      this.transientThreatUntilMs = 0;
      this.spawnBoss(evaluated.kind, evaluated.source, nowMs, input.onSoundCue);
    } else if (
      this.activeBoss.source === 'practice' &&
      evaluated.source === 'threat'
    ) {
      this.practiceBossKind = null;
      this.spawnBoss(evaluated.kind, evaluated.source, nowMs, input.onSoundCue);
    } else if (
      this.activeBoss.source === 'threat' &&
      evaluated.source === 'threat' &&
      this.activeBoss.hp === this.activeBoss.maxHp &&
      THREAT_PRIORITY[evaluated.kind] > THREAT_PRIORITY[this.activeBoss.kind]
    ) {
      this.spawnBoss(evaluated.kind, 'threat', nowMs, input.onSoundCue);
    }
  }

  onEvents(
    events: readonly (WorldEvent | Record<string, unknown>)[],
    ctx: BossRaidStepInput
  ): number {
    this.syncState({ ...ctx, events: events as WorldEvent[] });
    if (this.suppressed || !this.activeBoss) return 0;

    const nowMs = ctx.nowMs ?? Date.now();
    const bossPos = resolveBossAnchorDesignPos(ctx.theme);
    let totalHitDamage = 0;

    for (const ev of events) {
      if (!this.activeBoss) break;
      const attack = classifyRaidAttackEvent(ev);
      if (!attack) continue;

      let fromPos: [number, number] = [ctx.theme.bossDesk.x, ctx.theme.bossDesk.y];
      if (attack.botId && ctx.motion) {
        const desk = ctx.motion.layout.botDesks.get(attack.botId);
        if (desk) {
          const pose = ctx.motion.actorPose(`bot:${attack.botId}`, [desk.x, desk.y]);
          fromPos = [pose.footX, pose.footY - 26];
        }
      } else if (attack.botId) {
        const idx = ctx.snapshot.botOrder.indexOf(attack.botId);
        if (idx >= 0 && idx < ctx.theme.botDesks.length) {
          const slot = ctx.theme.botDesks[idx];
          fromPos = [slot.x, slot.y - 26];
        }
      }

      const applied = this.applyDamage(attack.damage, {
        isCrit: attack.isCrit,
        fromPos,
        toPos: [bossPos[0], bossPos[1] - 28],
        attackerBotId: attack.botId,
        nowMs,
        demoMode: ctx.demoMode,
        onOutcome: ctx.onOutcome,
        onSoundCue: ctx.onSoundCue,
      });
      totalHitDamage += applied;
    }

    return totalHitDamage;
  }

  strikeFromOwner(ctx: BossRaidStepInput & { fromPos?: [number, number] }): boolean {
    this.syncState(ctx);
    if (this.suppressed || !this.activeBoss) return false;
    const nowMs = ctx.nowMs ?? Date.now();
    if (nowMs - this.lastOwnerStrikeAtMs < OWNER_STRIKE_COOLDOWN_MS) {
      return false;
    }
    this.lastOwnerStrikeAtMs = nowMs;
    const bossPos = resolveBossAnchorDesignPos(ctx.theme);
    const origin: [number, number] = ctx.fromPos ?? [
      ctx.theme.bossDesk.x,
      ctx.theme.bossDesk.y - 20,
    ];
    this.applyDamage(OWNER_STRIKE_DAMAGE, {
      isCrit: false,
      fromPos: origin,
      toPos: [bossPos[0], bossPos[1] - 28],
      attackerBotId: null,
      nowMs,
      demoMode: ctx.demoMode,
      onOutcome: ctx.onOutcome,
      onSoundCue: ctx.onSoundCue,
      beamColor: '#38bdf8',
    });
    return true;
  }

  private applyDamage(
    rawDamage: number,
    opts: {
      isCrit: boolean;
      fromPos?: [number, number];
      toPos: [number, number];
      attackerBotId: string | null;
      nowMs: number;
      demoMode?: boolean;
      onOutcome?: RaidOutcomeCallback;
      onSoundCue?: RaidSoundCallback;
      beamColor?: string;
      silentVisual?: boolean;
    }
  ): number {
    const boss = this.activeBoss;
    if (!boss || boss.hp <= 0) return 0;
    const dmg = Math.max(1, Math.trunc(rawDamage));
    const actual = Math.min(boss.hp, dmg);
    boss.hp = Math.max(0, boss.hp - actual);
    boss.totalDamageTaken += actual;
    boss.hitFlashSecs = opts.silentVisual ? boss.hitFlashSecs : 0.14;
    if (!opts.demoMode && boss.source !== 'practice') {
      this.pendingDamageForStats = Math.min(
        MAX_DAMAGE_PER_EVENT,
        this.pendingDamageForStats + actual
      );
    }

    if (opts.attackerBotId && isSafeKey(opts.attackerBotId)) {
      this.botDamageByBotId.set(
        opts.attackerBotId,
        (this.botDamageByBotId.get(opts.attackerBotId) ?? 0) + actual
      );
    }

    if (!opts.silentVisual) {
      const spec = RAID_BOSS_CATALOG[boss.kind];
      if (opts.fromPos) {
        this.pushBeam({
          fromX: opts.fromPos[0],
          fromY: opts.fromPos[1],
          toX: opts.toPos[0],
          toY: opts.toPos[1],
          colorHex: opts.beamColor ?? (opts.isCrit ? '#facc15' : spec.beamColor),
          isCrit: opts.isCrit,
        });
      }
      this.pushDamageFloat({
        x: opts.toPos[0] + (this.nextRand() - 0.5) * 44,
        y: opts.toPos[1] - 18 - this.nextRand() * 14,
        damage: dmg,
        isCrit: opts.isCrit,
      });
      opts.onSoundCue?.('raid_hit');
    }

    if (boss.hp <= 0) {
      this.handleBossDefeated(boss, opts.toPos, opts.nowMs, opts.demoMode, opts.onOutcome, opts.onSoundCue);
    }
    return actual;
  }

  private handleBossDefeated(
    boss: ActiveBossState,
    pos: [number, number],
    nowMs: number,
    demoMode?: boolean,
    onOutcome?: RaidOutcomeCallback,
    onSoundCue?: RaidSoundCallback
  ): void {
    this.victoryBanner = {
      bossKind: boss.kind,
      ttl: 2.6,
      maxTtl: 2.6,
    };
    this.spawnVictoryParticles(pos);
    onSoundCue?.('raid_victory');

    const cooldownMs = demoMode ? DEMO_RESPAWN_COOLDOWN_MS : LIVE_RESPAWN_COOLDOWN_MS;
    this.respawnCooldownUntilMs = nowMs + cooldownMs;
    this.transientThreatKind = null;
    this.transientThreatUntilMs = 0;
    if (boss.source === 'practice') {
      this.practiceBossKind = null;
    }
    this.activeBoss = null;

    const damageToRecord = this.consumePendingDamage();
    if (!demoMode && boss.source !== 'practice') {
      onOutcome?.({
        cleared: true,
        damageDealt: damageToRecord,
      });
    }
  }

  private consumePendingDamage(): number {
    const dmg = this.pendingDamageForStats;
    this.pendingDamageForStats = 0;
    return dmg;
  }

  private pushBeam(opts: {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    colorHex: string;
    isCrit: boolean;
  }): void {
    while (this.beams.length >= MAX_ATTACK_BEAMS) {
      this.beams.shift();
    }
    this.beams.push({
      id: this.nextId++,
      fromX: opts.fromX,
      fromY: opts.fromY,
      toX: opts.toX,
      toY: opts.toY,
      colorHex: opts.colorHex,
      isCrit: opts.isCrit,
      age: 0,
      ttl: opts.isCrit ? 0.36 : 0.26,
    });
  }

  private pushDamageFloat(opts: {
    x: number;
    y: number;
    damage: number;
    isCrit: boolean;
  }): void {
    while (this.damageFloats.length >= MAX_DAMAGE_FLOATS) {
      this.damageFloats.shift();
    }
    this.damageFloats.push({
      id: this.nextId++,
      x: opts.x,
      y: opts.y,
      vx: (this.nextRand() - 0.5) * 18,
      vy: opts.isCrit ? -46 : -34,
      damage: opts.damage,
      isCrit: opts.isCrit,
      age: 0,
      ttl: opts.isCrit ? 1.15 : 0.85,
    });
  }

  private spawnVictoryParticles(origin: [number, number]): void {
    const colors = ['#facc15', '#4ade80', '#38bdf8', '#fb7185', '#a78bfa'];
    for (let i = 0; i < 24; i++) {
      if (this.particles.length >= MAX_RAID_PARTICLES) {
        this.particles.shift();
      }
      const ang = this.nextRand() * Math.PI * 2;
      const spd = 45 + this.nextRand() * 110;
      this.particles.push({
        x: origin[0],
        y: origin[1] - 12,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 65,
        gravity: 165,
        age: 0,
        ttl: 1.0 + this.nextRand() * 0.6,
        colorHex: colors[i % colors.length],
        size: 4 + this.nextRand() * 3.5,
      });
    }
  }

  stepVisuals(rawDtSecs: number): void {
    const dt =
      typeof rawDtSecs === 'number' && Number.isFinite(rawDtSecs) && rawDtSecs > 0
        ? Math.min(3600, rawDtSecs)
        : 0;
    if (dt <= 0) {
      return;
    }
    this.elapsedSecs += dt;

    if (this.activeBoss && this.activeBoss.hitFlashSecs > 0) {
      this.activeBoss.hitFlashSecs = Math.max(0, this.activeBoss.hitFlashSecs - dt);
    }

    // Advance beams, floats, particles, banner
    this.beams = this.beams.filter((b) => {
      b.age += dt;
      return b.age < b.ttl;
    });
    this.damageFloats = this.damageFloats.filter((f) => {
      f.age += dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      return f.age < f.ttl;
    });
    this.particles = this.particles.filter((p) => {
      p.age += dt;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      return p.age < p.ttl;
    });
    if (this.victoryBanner) {
      this.victoryBanner.ttl -= dt;
      if (this.victoryBanner.ttl <= 0) {
        this.victoryBanner = null;
      }
    }
  }

  stepPomodoro(
    rawDtSecs: number,
    ctx?: BossRaidStepInput
  ): { pomodoroCompleted: boolean } {
    const dt =
      typeof rawDtSecs === 'number' && Number.isFinite(rawDtSecs) && rawDtSecs > 0
        ? Math.min(3600, rawDtSecs)
        : 0;
    if (dt <= 0) {
      return { pomodoroCompleted: false };
    }

    if (ctx) {
      this.syncState(ctx);
    }

    let pomodoroCompleted = false;
    if (this.pomodoro.running && !this.pomodoro.paused) {
      this.pomodoro.remainingSecs = Math.max(0, this.pomodoro.remainingSecs - dt);

      // Sustained focus DPS while active & not suppressed
      if (!this.suppressed && this.activeBoss && ctx) {
        this.pomodoro.dpsAccumulator += POMODORO_DPS * dt;
        const wholeDmg = Math.floor(this.pomodoro.dpsAccumulator);
        if (wholeDmg >= 1) {
          this.pomodoro.dpsAccumulator -= wholeDmg;
          const bossPos = resolveBossAnchorDesignPos(ctx.theme);
          this.applyDamage(wholeDmg, {
            isCrit: false,
            toPos: [bossPos[0], bossPos[1] - 28],
            attackerBotId: null,
            nowMs: ctx.nowMs ?? Date.now(),
            demoMode: ctx.demoMode,
            onOutcome: ctx.onOutcome,
            onSoundCue: ctx.onSoundCue,
            silentVisual: dt > 1,
          });
        }
      }

      if (this.pomodoro.remainingSecs <= 0) {
        pomodoroCompleted = true;
        const completedMinutes = this.pomodoro.presetMinutes;
        this.pomodoro = {
          presetMinutes: completedMinutes,
          running: false,
          paused: false,
          remainingSecs: completedMinutes * 60,
          totalSecs: completedMinutes * 60,
          dpsAccumulator: 0,
        };
        if (this.activeBoss?.source === 'pomodoro') {
          const bossPos: [number, number] = ctx
            ? resolveBossAnchorDesignPos(ctx.theme)
            : [500, 200];
          this.victoryBanner = {
            bossKind: this.activeBoss.kind,
            ttl: 2.6,
            maxTtl: 2.6,
          };
          this.spawnVictoryParticles(bossPos);
          this.activeBoss = null;
        }
        if (!this.suppressed) {
          ctx?.onSoundCue?.('raid_victory');
        }
        const damageToRecord = this.consumePendingDamage();
        ctx?.onOutcome?.({
          pomodoroCompleted: true,
          focusMinutes: completedMinutes,
          ...(damageToRecord > 0 ? { damageDealt: damageToRecord } : {}),
        });
      }
    }

    return { pomodoroCompleted };
  }

  step(
    rawDtSecs: number,
    ctx?: BossRaidStepInput
  ): { pomodoroCompleted: boolean } {
    this.stepVisuals(rawDtSecs);
    return this.stepPomodoro(rawDtSecs, ctx);
  }

  getTopContributor(
    snapshot: WorldSnapshot,
    redactMode: boolean,
    locale: UiLocale
  ): { botId: string; displayName: string; damage: number } | null {
    let bestId: string | null = null;
    let bestDmg = 0;
    for (const [botId, dmg] of this.botDamageByBotId.entries()) {
      if (dmg > bestDmg) {
        bestDmg = dmg;
        bestId = botId;
      }
    }
    if (!bestId || bestDmg <= 0) return null;
    const bot = Object.hasOwn(snapshot.bots, bestId) ? snapshot.bots[bestId] : null;
    const displayName = redactMode
      ? getBotRedactedAlias(bestId, snapshot, locale)
      : bot
        ? scrubAll(bot.name)
        : tStrings(locale).botGeneric;
    return { botId: bestId, displayName, damage: bestDmg };
  }
}

export function formatCountdownMmSs(totalSecs: number): string {
  const safe = Math.max(0, Math.ceil(Number.isFinite(totalSecs) ? totalSecs : 0));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Canvas 2D Original Office Pixel Creature Renderer (Zero shadowBlur)
// ---------------------------------------------------------------------------

function toScreen(vt: ViewportTransform, dx: number, dy: number): [number, number] {
  return [vt.originX + dx * vt.scale, vt.originY + dy * vt.scale];
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rad = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

function pxBlock(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  unit: number,
  gx: number,
  gy: number,
  gw: number,
  gh: number,
  color: string
): void {
  ctx.fillStyle = color;
  ctx.fillRect(cx + gx * unit, cy + gy * unit, gw * unit, gh * unit);
}

function paintPixelCreature(
  ctx: CanvasRenderingContext2D,
  kind: BossKind,
  cx: number,
  cy: number,
  scale: number,
  elapsedSecs: number,
  hitFlash: boolean
): void {
  const unit = 4.2 * scale;
  const flashWhite = hitFlash;

  switch (kind) {
    case 'error_blob': {
      // 503 Glitch Blob: gelatinous office error slime with digital visor & glitch bars
      const wobble = Math.sin(elapsedSecs * 6) * 0.5;
      const bodyCol = flashWhite ? '#ffffff' : '#e11d48';
      const darkCol = flashWhite ? '#fecdd3' : '#881337';
      const glowCol = flashWhite ? '#ffffff' : '#fda4af';

      pxBlock(ctx, cx, cy, unit, -7, -2 + wobble, 14, 3, darkCol);
      pxBlock(ctx, cx, cy, unit, -6, -9 + wobble, 12, 8, bodyCol);
      pxBlock(ctx, cx, cy, unit, -4, -12 + wobble, 8, 3, bodyCol);
      pxBlock(ctx, cx, cy, unit, -8, -5 + wobble, 2, 4, bodyCol);
      pxBlock(ctx, cx, cy, unit, 6, -5 + wobble, 2, 4, bodyCol);
      // Digital visor
      pxBlock(ctx, cx, cy, unit, -5, -9 + wobble, 10, 3, '#0f172a');
      // 503 eyes
      pxBlock(ctx, cx, cy, unit, -4, -8 + wobble, 2, 1.5, glowCol);
      pxBlock(ctx, cx, cy, unit, -0.5, -8 + wobble, 1.5, 1.5, '#facc15');
      pxBlock(ctx, cx, cy, unit, 2, -8 + wobble, 2, 1.5, glowCol);
      // Glitch strips
      const shift = Math.sin(elapsedSecs * 15) > 0 ? 1 : -1;
      pxBlock(ctx, cx, cy, unit, -6 + shift, -4 + wobble, 4, 1, '#f43f5e');
      pxBlock(ctx, cx, cy, unit, 2 - shift, -11 + wobble, 3, 1, '#38bdf8');
      break;
    }
    case 'stall_golem': {
      // Stall Stone Golem: chunky granite golem with amber hourglass core & floating pebble fists
      const breathe = Math.sin(elapsedSecs * 2.5) * 0.4;
      const stone = flashWhite ? '#ffffff' : '#64748b';
      const stoneDark = flashWhite ? '#e2e8f0' : '#334155';
      const amber = flashWhite ? '#ffffff' : '#fbbf24';

      // Legs
      pxBlock(ctx, cx, cy, unit, -5, -3, 4, 3, stoneDark);
      pxBlock(ctx, cx, cy, unit, 1, -3, 4, 3, stoneDark);
      // Torso
      pxBlock(ctx, cx, cy, unit, -7, -11 + breathe, 14, 8, stone);
      pxBlock(ctx, cx, cy, unit, -6, -10 + breathe, 12, 6, stoneDark);
      // Head
      pxBlock(ctx, cx, cy, unit, -4, -15 + breathe, 8, 4, stone);
      pxBlock(ctx, cx, cy, unit, -2.5, -13.5 + breathe, 1.5, 1.2, amber);
      pxBlock(ctx, cx, cy, unit, 1, -13.5 + breathe, 1.5, 1.2, amber);
      // Hourglass core
      pxBlock(ctx, cx, cy, unit, -2, -9 + breathe, 4, 1, amber);
      pxBlock(ctx, cx, cy, unit, -1, -8 + breathe, 2, 2, '#fef08a');
      pxBlock(ctx, cx, cy, unit, -2, -6 + breathe, 4, 1, amber);
      // Floating pebble fists
      const fistBob = Math.cos(elapsedSecs * 3.2) * 1.1;
      pxBlock(ctx, cx, cy, unit, -10, -8 + fistBob, 3, 4, stone);
      pxBlock(ctx, cx, cy, unit, 7, -8 - fistBob, 3, 4, stone);
      break;
    }
    case 'ci_wyvern': {
      // Red-Build Spark Wyvern: angular crimson pixel dragon with flapping wings & spark tail
      const flap = Math.sin(elapsedSecs * 8) * 1.8;
      const body = flashWhite ? '#ffffff' : '#dc2626';
      const dark = flashWhite ? '#fee2e2' : '#7f1d1d';
      const spark = flashWhite ? '#ffffff' : '#fb923c';

      // Wings
      pxBlock(ctx, cx, cy, unit, -11, -12 + flap, 5, 4, dark);
      pxBlock(ctx, cx, cy, unit, -9, -10 + flap * 0.6, 4, 3, body);
      pxBlock(ctx, cx, cy, unit, 6, -12 + flap, 5, 4, dark);
      pxBlock(ctx, cx, cy, unit, 5, -10 + flap * 0.6, 4, 3, body);
      // Body & neck
      pxBlock(ctx, cx, cy, unit, -4, -9, 8, 8, body);
      pxBlock(ctx, cx, cy, unit, -3, -8, 6, 5, '#450a0a');
      // Chest spark X
      pxBlock(ctx, cx, cy, unit, -1.5, -6.5, 3, 2.5, spark);
      // Horned head
      pxBlock(ctx, cx, cy, unit, -4.5, -14, 9, 5, body);
      pxBlock(ctx, cx, cy, unit, -5, -17, 2, 3, spark);
      pxBlock(ctx, cx, cy, unit, 3, -17, 2, 3, spark);
      // Eyes
      pxBlock(ctx, cx, cy, unit, -3, -12.5, 2, 1.5, '#fef08a');
      pxBlock(ctx, cx, cy, unit, 1, -12.5, 2, 1.5, '#fef08a');
      // Tail flame
      pxBlock(ctx, cx, cy, unit, 4, -3, 4, 2, dark);
      pxBlock(ctx, cx, cy, unit, 8, -4 + Math.sin(elapsedSecs * 12) * 0.6, 2, 2, '#facc15');
      break;
    }
    case 'sprint_titan': {
      // Sprint Deadline Titan: navy-gold clockwork guardian with twin alarm bells & glowing core
      const hover = Math.sin(elapsedSecs * 3.8) * 0.6;
      const armor = flashWhite ? '#ffffff' : '#4f46e5';
      const trim = flashWhite ? '#e0e7ff' : '#1e1b4b';
      const gold = flashWhite ? '#ffffff' : '#facc15';
      const cyan = flashWhite ? '#ffffff' : '#38bdf8';

      // Base
      pxBlock(ctx, cx, cy, unit, -6, -3 + hover, 12, 3, trim);
      // Shoulders / Calendar plates
      pxBlock(ctx, cx, cy, unit, -9, -11 + hover, 4, 6, armor);
      pxBlock(ctx, cx, cy, unit, 5, -11 + hover, 4, 6, armor);
      pxBlock(ctx, cx, cy, unit, -9, -11 + hover, 4, 1.5, gold);
      pxBlock(ctx, cx, cy, unit, 5, -11 + hover, 4, 1.5, gold);
      // Core torso
      pxBlock(ctx, cx, cy, unit, -5, -12 + hover, 10, 9, armor);
      pxBlock(ctx, cx, cy, unit, -3, -10 + hover, 6, 5, trim);
      pxBlock(ctx, cx, cy, unit, -1.5, -9 + hover, 3, 3, cyan);
      // Clock head + alarm bells
      pxBlock(ctx, cx, cy, unit, -4, -16 + hover, 8, 4, '#e0f2fe');
      pxBlock(ctx, cx, cy, unit, -5, -17 + hover, 2, 2, gold);
      pxBlock(ctx, cx, cy, unit, 3, -17 + hover, 2, 2, gold);
      // Clock hands
      pxBlock(ctx, cx, cy, unit, -0.5, -15 + hover, 1, 2, '#0f172a');
      pxBlock(ctx, cx, cy, unit, -0.5, -14 + hover, 2.5, 1, '#dc2626');
      break;
    }
  }
}

export function paintBossRaidLayer(
  ctx: CanvasRenderingContext2D,
  vt: ViewportTransform,
  theme: ThemeConfig,
  engine: BossRaidEngine,
  opts: {
    locale: UiLocale;
    uiScale: number;
    fontFamily: string;
  }
): Rect | null {
  const s = tStrings(opts.locale);
  const bgW = vt.designW * vt.scale;
  let bossHitRect: Rect | null = null;

  // 1. Attack Beams (drawn without shadowBlur)
  for (const beam of engine.beams.slice(0, MAX_ATTACK_BEAMS)) {
    const t = Math.max(0, Math.min(1, beam.age / Math.max(0.01, beam.ttl)));
    const alpha = 1 - t;
    const [fx, fy] = toScreen(vt, beam.fromX, beam.fromY);
    const [tx, ty] = toScreen(vt, beam.toX, beam.toY);

    ctx.save();
    ctx.globalAlpha = alpha * 0.45;
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(tx, ty);
    ctx.lineWidth = (beam.isCrit ? 8 : 5) * vt.scale;
    ctx.lineCap = 'round';
    ctx.strokeStyle = beam.colorHex;
    ctx.stroke();

    ctx.globalAlpha = alpha * 0.95;
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(tx, ty);
    ctx.lineWidth = (beam.isCrit ? 3.2 : 2) * vt.scale;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    // Impact ring
    const impR = (4 + t * (beam.isCrit ? 20 : 12)) * vt.scale;
    ctx.beginPath();
    ctx.arc(tx, ty, impR, 0, Math.PI * 2);
    ctx.lineWidth = 2 * vt.scale;
    ctx.strokeStyle = beam.colorHex;
    ctx.stroke();
    ctx.restore();
  }

  // 2. Active Boss Sprite + HP Bar
  if (engine.activeBoss) {
    const boss = engine.activeBoss;
    const spec = RAID_BOSS_CATALOG[boss.kind];
    const [anchorX, anchorY] = resolveBossAnchorDesignPos(theme);
    const [bx, by] = toScreen(vt, anchorX, anchorY);
    const spriteScale = Math.max(0.6, vt.scale);

    // Ground shadow ellipse
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(bx, by + 2 * spriteScale, 34 * spriteScale, 10 * spriteScale, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.36)';
    ctx.fill();
    ctx.restore();

    paintPixelCreature(
      ctx,
      boss.kind,
      bx,
      by,
      spriteScale,
      engine.elapsedSecs,
      boss.hitFlashSecs > 0
    );

    const spriteW = 94 * spriteScale;
    const spriteH = 82 * spriteScale;
    bossHitRect = [bx - spriteW * 0.5, by - spriteH, spriteW, spriteH];

    // Boss Name + HP Bar above boss
    const barW = Math.max(132 * opts.uiScale, 152 * vt.scale);
    const barH = 26 * opts.uiScale;
    const barX = Math.max(
      vt.originX + 8,
      Math.min(vt.originX + bgW - barW - 8, bx - barW * 0.5)
    );
    const barY = Math.max(vt.originY + 8, by - spriteH - barH - 6 * opts.uiScale);

    ctx.save();
    drawRoundedRect(ctx, barX, barY, barW, barH, 7 * opts.uiScale);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.90)';
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = spec.accentColor;
    ctx.stroke();

    const bossTitle = s.raidBossNames[boss.kind];
    const tag =
      boss.source === 'pomodoro'
        ? '🍅'
        : boss.source === 'practice'
          ? `[${s.raidPracticeTag}]`
          : '⚔';
    ctx.font = `700 ${Math.round(9.5 * opts.uiScale)}px ${opts.fontFamily}`;
    ctx.fillStyle = '#f8fafc';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${tag} ${bossTitle}`, barX + 7 * opts.uiScale, barY + 9 * opts.uiScale);

    // HP Track
    const trackX = barX + 6 * opts.uiScale;
    const trackY = barY + 16 * opts.uiScale;
    const trackW = barW - 12 * opts.uiScale;
    const trackH = 6 * opts.uiScale;
    const hpRatio = Math.max(0, Math.min(1, boss.hp / Math.max(1, boss.maxHp)));
    drawRoundedRect(ctx, trackX, trackY, trackW, trackH, 3 * opts.uiScale);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.fill();
    if (hpRatio > 0) {
      drawRoundedRect(ctx, trackX, trackY, Math.max(4, trackW * hpRatio), trackH, 3 * opts.uiScale);
      ctx.fillStyle = spec.primaryColor;
      ctx.fill();
    }

    ctx.font = `700 ${Math.round(8.5 * opts.uiScale)}px ${opts.fontFamily}`;
    ctx.fillStyle = '#fef2f2';
    ctx.textAlign = 'right';
    ctx.fillText(`${boss.hp}/${boss.maxHp}`, barX + barW - 6 * opts.uiScale, barY + 9 * opts.uiScale);
    ctx.restore();
  }

  // 3. Damage Floats (capped <= 24)
  for (const df of engine.damageFloats.slice(0, MAX_DAMAGE_FLOATS)) {
    const t = Math.max(0, Math.min(1, df.age / Math.max(0.01, df.ttl)));
    const alpha = t < 0.7 ? 1 : Math.max(0, (1 - t) / 0.3);
    const [fx, fy] = toScreen(vt, df.x, df.y);
    const label = df.isCrit ? s.raidCritLabel(df.damage) : `-${df.damage}`;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `800 ${Math.round((df.isCrit ? 14 : 11.5) * opts.uiScale)}px ${opts.fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3 * opts.uiScale;
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.92)';
    ctx.strokeText(label, fx, fy);
    ctx.fillStyle = df.isCrit ? '#facc15' : '#f8fafc';
    ctx.fillText(label, fx, fy);
    ctx.restore();
  }

  // 4. Victory Confetti Particles
  for (const p of engine.particles.slice(0, MAX_RAID_PARTICLES)) {
    const alpha = Math.max(0, Math.min(1, 1 - p.age / Math.max(0.01, p.ttl)));
    if (alpha <= 0.02) continue;
    const [px, py] = toScreen(vt, p.x, p.y);
    const sz = p.size * Math.max(0.6, vt.scale);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(px, py);
    ctx.rotate(p.age * 7 + p.vx * 0.04);
    ctx.fillStyle = p.colorHex;
    ctx.fillRect(-sz * 0.55, -sz * 0.35, sz * 1.1, sz * 0.7);
    ctx.restore();
  }

  // 5. Victory Banner
  if (engine.victoryBanner) {
    const banner = engine.victoryBanner;
    const progress = 1 - banner.ttl / Math.max(0.01, banner.maxTtl);
    const alpha =
      progress < 0.1 ? progress / 0.1 : banner.ttl < 0.45 ? Math.max(0, banner.ttl / 0.45) : 1;
    if (alpha > 0.02) {
      const label = s.raidVictoryBanner(s.raidBossNames[banner.bossKind]);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = `700 ${Math.round(11.5 * opts.uiScale)}px ${opts.fontFamily}`;
      const pillW = Math.min(
        bgW - 24,
        Math.max(180 * opts.uiScale, ctx.measureText(label).width + 28 * opts.uiScale)
      );
      const pillH = 28 * opts.uiScale;
      const x = vt.originX + bgW * 0.5 - pillW * 0.5;
      const y = vt.originY + 46 * opts.uiScale;
      drawRoundedRect(ctx, x, y, pillW, pillH, 999);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.90)';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#4ade80';
      ctx.stroke();
      ctx.fillStyle = '#dcfce7';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + pillW * 0.5, y + pillH * 0.5);
      ctx.restore();
    }
  }

  return bossHitRect;
}

// ---------------------------------------------------------------------------
// Raid & Pomodoro Co-op Modal (DOM builder only)
// ---------------------------------------------------------------------------

export function renderBossRaidModal(
  backdrop: HTMLElement,
  opts: {
    open: boolean;
    locale: UiLocale;
    redactMode: boolean;
    demoMode: boolean;
    snapshot: WorldSnapshot;
    engine: BossRaidEngine;
    stats: BossRaidStats;
    suppressionReason: RaidSuppressionReason | null;
    nowMs?: number;
    onCoopStrike: () => void;
    onSummonPractice: () => void;
    onSelectPreset: (minutes: PomodoroPresetMinutes) => void;
    onStartPomodoro: () => void;
    onPausePomodoro: () => void;
    onResumePomodoro: () => void;
    onAbandonPomodoro: () => void;
    onClose: () => void;
  }
): void {
  clearChildren(backdrop);
  backdrop.classList.toggle('bw-hidden', !opts.open);
  if (!opts.open) return;

  const s = tStrings(opts.locale);
  const nowMs = opts.nowMs ?? Date.now();
  const boss = opts.engine.activeBoss;
  const pomo = opts.engine.pomodoro;
  const isSuppressed = opts.suppressionReason !== null;
  const cooldownSecs = opts.engine.respawnCooldownRemainingSecs(nowMs);
  const topContributor = opts.engine.getTopContributor(
    opts.snapshot,
    opts.redactMode,
    opts.locale
  );

  const bossCard = (() => {
    if (isSuppressed && opts.suppressionReason) {
      return el(
        'div',
        { className: 'bw-card bw-card-warn' },
        el('div', { className: 'bw-card-text' }, s.raidSuppressedNote(opts.suppressionReason))
      );
    }
    if (!boss) {
      return el(
        'div',
        { className: 'bw-card bw-raid-card' },
        el('div', { className: 'bw-raid-boss-title' }, s.raidCalmTitle),
        el('div', { className: 'bw-card-sub' }, s.raidCalmDesc),
        cooldownSecs > 0
          ? el('div', { className: 'bw-meta-time' }, s.raidRespawnCooldown(cooldownSecs))
          : null,
        el(
          'div',
          { className: 'bw-raid-actions-row' },
          el(
            'button',
            {
              type: 'button',
              className: 'bw-btn bw-btn-primary',
              onClick: opts.onSummonPractice,
            },
            s.raidSummonPractice
          )
        )
      );
    }

    const hpPct = Math.round((boss.hp / Math.max(1, boss.maxHp)) * 100);
    const step = Math.max(0, Math.min(20, Math.round((hpPct / 100) * 20)));
    const topLine = topContributor
      ? s.raidTopContributor(topContributor.displayName, topContributor.damage)
      : s.raidTopContributorNone;

    return el(
      'div',
      { className: 'bw-card bw-raid-card' },
      el(
        'div',
        { className: 'bw-raid-boss-head' },
        el('span', { className: 'bw-raid-boss-title' }, s.raidBossNames[boss.kind]),
        el('span', { className: 'bw-badge bw-badge-error' }, `${boss.hp} / ${boss.maxHp} HP`)
      ),
      el('div', { className: 'bw-card-sub' }, s.raidBossTriggers[boss.kind]),
      el(
        'div',
        { className: 'bw-report-bar-track' },
        el('div', { className: `bw-report-bar-fill bw-raid-hp-fill bw-fill-step-${step}` })
      ),
      el('div', { className: 'bw-meta-time' }, topLine),
      el(
        'div',
        { className: 'bw-raid-actions-row' },
        el(
          'button',
          {
            type: 'button',
            className: 'bw-btn bw-btn-primary',
            onClick: opts.onCoopStrike,
          },
          s.raidCoopStrike
        ),
        el(
          'button',
          {
            type: 'button',
            className: 'bw-btn',
            disabled: boss.source !== 'practice',
            onClick: opts.onSummonPractice,
          },
          s.raidSummonPractice
        )
      )
    );
  })();

  const presetsRow = el(
    'div',
    { className: 'bw-seg' },
    ...([15, 25, 50] as const).map((mins) => {
      const btn = el(
        'button',
        {
          type: 'button',
          className:
            pomo.presetMinutes === mins ? 'bw-seg-btn bw-seg-btn-active' : 'bw-seg-btn',
          onClick: () => opts.onSelectPreset(mins),
        },
        s.raidPomoPresetLabel(mins)
      ) as HTMLButtonElement;
      btn.disabled = pomo.running || pomo.paused;
      return btn;
    })
  );

  const countdownText = formatCountdownMmSs(pomo.remainingSecs);
  const pomoControls = pomo.running
    ? [
        el(
          'button',
          { type: 'button', className: 'bw-btn', onClick: opts.onPausePomodoro },
          s.raidPomoPause
        ),
        el(
          'button',
          { type: 'button', className: 'bw-btn bw-btn-warn', onClick: opts.onAbandonPomodoro },
          s.raidPomoStop
        ),
      ]
    : pomo.paused
      ? [
          el(
            'button',
            { type: 'button', className: 'bw-btn bw-btn-primary', onClick: opts.onResumePomodoro },
            s.raidPomoResume
          ),
          el(
            'button',
            { type: 'button', className: 'bw-btn bw-btn-warn', onClick: opts.onAbandonPomodoro },
            s.raidPomoStop
          ),
        ]
      : [
          el(
            'button',
            {
              type: 'button',
              className: 'bw-btn bw-btn-primary',
              onClick: opts.onStartPomodoro,
            },
            s.raidPomoStart
          ),
        ];

  const pomodoroSection = el(
    'div',
    { className: 'bw-section' },
    el(
      'div',
      { className: 'bw-section-title-row' },
      el('div', { className: 'bw-section-title' }, s.raidPomoSectionTitle),
      el(
        'span',
        { className: 'bw-chip' },
        s.raidStatStreak(opts.stats.currentStreak, opts.stats.bestStreak)
      )
    ),
    el(
      'div',
      { className: 'bw-card bw-raid-pomo-card' },
      el(
        'div',
        { className: 'bw-raid-pomo-row' },
        presetsRow,
        el('span', { className: 'bw-raid-timer-readout' }, countdownText)
      ),
      el('div', { className: 'bw-raid-actions-row' }, ...pomoControls)
    )
  );

  const statsSection = el(
    'div',
    { className: 'bw-section' },
    el('div', { className: 'bw-section-title' }, s.raidStatsSectionTitle),
    opts.demoMode ? el('div', { className: 'bw-report-redact-note' }, s.raidStatsDemoNote) : null,
    el(
      'div',
      { className: 'bw-report-kpis' },
      el(
        'div',
        { className: 'bw-report-kpi' },
        el('div', { className: 'bw-report-kpi-label' }, s.raidStatCleared),
        el('div', { className: 'bw-report-kpi-value' }, String(opts.stats.raidsCleared))
      ),
      el(
        'div',
        { className: 'bw-report-kpi' },
        el('div', { className: 'bw-report-kpi-label' }, s.raidStatPomodoros),
        el('div', { className: 'bw-report-kpi-value' }, String(opts.stats.pomodorosCompleted))
      ),
      el(
        'div',
        { className: 'bw-report-kpi' },
        el('div', { className: 'bw-report-kpi-label' }, s.raidStatFocusMin),
        el('div', { className: 'bw-report-kpi-value' }, String(opts.stats.totalFocusMinutes))
      ),
      el(
        'div',
        { className: 'bw-report-kpi' },
        el('div', { className: 'bw-report-kpi-label' }, s.raidStatDamage),
        el('div', { className: 'bw-report-kpi-value' }, String(opts.stats.totalDamage))
      )
    )
  );

  const dialog = el(
    'div',
    {
      className: 'bw-modal-dialog bw-raid-dialog',
      role: 'dialog',
      ariaLabel: s.raidModalTitle,
      onClick: (ev) => {
        ev.stopPropagation();
      },
    },
    el(
      'div',
      { className: 'bw-modal-header' },
      el(
        'div',
        null,
        el('div', { className: 'bw-modal-title' }, s.raidModalTitle),
        el('div', { className: 'bw-modal-subtitle' }, s.raidModalSubtitle)
      ),
      el(
        'button',
        {
          type: 'button',
          className: 'bw-btn bw-btn-ghost',
          ariaLabel: s.raidClose,
          onClick: opts.onClose,
        },
        '✕'
      )
    ),
    bossCard,
    pomodoroSection,
    statsSection
  );

  backdrop.appendChild(dialog);
}
