import { scrubAll } from '../src/redact.ts';
import {
  type StuckAlert,
  type UiLocale,
  type WorldSnapshot,
  isSafeKey,
  isWorkerActive,
} from '../src/types.ts';
import { getBotRedactedAlias } from './filter.ts';
import { tStrings } from './i18n.ts';

export const DEFAULT_STUCK_THRESHOLD_MIN = 15;
export const MAX_STUCK_THRESHOLD_MIN = 180;
export const STUCK_NOTIFY_COOLDOWN_MS = 15 * 60_000;
export const MAX_TRACKED_WATCHDOG_ENTRIES = 256;

export function clampStuckThresholdMin(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return DEFAULT_STUCK_THRESHOLD_MIN;
  }
  return Math.max(0, Math.min(MAX_STUCK_THRESHOLD_MIN, Math.trunc(raw)));
}

function botWatchdogSignature(
  statusKind: string,
  taskTitle: string | null,
  tool: string | null
): string {
  return `${statusKind}\0${taskTitle ?? ''}\0${tool ?? ''}`;
}

function workerWatchdogSignature(
  workerState: string,
  activity: string,
  toolName: string | null,
  taskTitle: string | null
): string {
  return `${workerState}\0${activity}\0${toolName ?? ''}\0${taskTitle ?? ''}`;
}

function resolveInitialChangedAt(observedTs: number | null, nowMs: number): number {
  if (
    typeof observedTs === 'number' &&
    Number.isFinite(observedTs) &&
    observedTs > 0 &&
    observedTs <= nowMs
  ) {
    return observedTs;
  }
  return nowMs;
}

/**
 * Pure evaluation of stuck Working bots and active sub-workers from a snapshot
 * and optional tracked last-change timestamps.
 */
export function computeStuckAlerts(
  snapshot: WorldSnapshot,
  opts: {
    thresholdMin: number;
    nowMs?: number;
    redactMode?: boolean;
    locale?: UiLocale;
    botChangedAt?: ReadonlyMap<string, number>;
    workerChangedAt?: ReadonlyMap<string, number>;
  }
): StuckAlert[] {
  const thresholdMin = clampStuckThresholdMin(opts.thresholdMin);
  if (thresholdMin <= 0 || !snapshot.runtime.connected) return [];

  const nowMs =
    typeof opts.nowMs === 'number' && Number.isFinite(opts.nowMs) && opts.nowMs > 0
      ? opts.nowMs
      : snapshot.capturedAt > 0
        ? snapshot.capturedAt
        : Date.now();
  const thresholdMs = thresholdMin * 60_000;
  const redactMode = Boolean(opts.redactMode);
  const locale = opts.locale ?? 'en';
  const s = tStrings(locale);
  const alerts: StuckAlert[] = [];

  for (const [botId, bot] of Object.entries(snapshot.bots)) {
    if (!isSafeKey(botId) || !bot || bot.status.kind !== 'Working') continue;
    const trackedTs = opts.botChangedAt?.get(botId);
    const lastChangedAtMs =
      trackedTs !== undefined ? trackedTs : resolveInitialChangedAt(bot.lastActivityAt, nowMs);
    const elapsedMs = Math.max(0, nowMs - lastChangedAtMs);
    if (elapsedMs < thresholdMs) continue;

    const tool = bot.currentTool ?? bot.status.tool ?? null;
    alerts.push({
      targetKind: 'bot',
      botId,
      botName: redactMode
        ? getBotRedactedAlias(botId, snapshot, locale)
        : scrubAll(bot.name).trim() || s.botGeneric,
      elapsedMs,
      elapsedMinutes: Math.max(thresholdMin, Math.floor(elapsedMs / 60_000)),
      lastChangedAtMs,
      lastStatusKind: 'Working',
      lastTool: redactMode || !tool ? null : scrubAll(tool),
      lastTaskTitle:
        redactMode || !bot.currentTaskTitle ? null : scrubAll(bot.currentTaskTitle),
    });
  }

  for (const [dispatchId, worker] of Object.entries(snapshot.workers)) {
    if (!isSafeKey(dispatchId) || !worker || !isWorkerActive(worker)) continue;
    const parentBotId =
      worker.parentBotId && isSafeKey(worker.parentBotId) ? worker.parentBotId : null;
    if (!parentBotId || !Object.hasOwn(snapshot.bots, parentBotId)) continue;

    const trackedTs = opts.workerChangedAt?.get(dispatchId);
    const lastChangedAtMs =
      trackedTs !== undefined ? trackedTs : resolveInitialChangedAt(worker.updatedAt, nowMs);
    const elapsedMs = Math.max(0, nowMs - lastChangedAtMs);
    if (elapsedMs < thresholdMs) continue;

    const parentBot = snapshot.bots[parentBotId];
    alerts.push({
      targetKind: 'worker',
      botId: parentBotId,
      botName: redactMode
        ? getBotRedactedAlias(parentBotId, snapshot, locale)
        : scrubAll(parentBot.name).trim() || s.botGeneric,
      workerDispatchId: dispatchId,
      elapsedMs,
      elapsedMinutes: Math.max(thresholdMin, Math.floor(elapsedMs / 60_000)),
      lastChangedAtMs,
      lastStatusKind: scrubAll(worker.activity || worker.workerState),
      lastTool: redactMode || !worker.toolName ? null : scrubAll(worker.toolName),
      lastTaskTitle: redactMode || !worker.taskTitle ? null : scrubAll(worker.taskTitle),
    });
  }

  alerts.sort(
    (a, b) =>
      b.elapsedMs - a.elapsedMs ||
      a.botName.localeCompare(b.botName) ||
      a.targetKind.localeCompare(b.targetKind)
  );
  return alerts;
}

export function stuckAlertByBotMap(alerts: readonly StuckAlert[]): Map<string, StuckAlert> {
  const map = new Map<string, StuckAlert>();
  for (const alert of alerts) {
    if (!isSafeKey(alert.botId)) continue;
    const prev = map.get(alert.botId);
    if (!prev || alert.elapsedMs > prev.elapsedMs) {
      map.set(alert.botId, alert);
    }
  }
  return map;
}

export function stuckAlertsSignature(alerts: readonly StuckAlert[]): string {
  return alerts
    .map(
      (a) =>
        `${a.targetKind}:${a.botId}:${a.workerDispatchId ?? ''}:${a.elapsedMinutes}:${a.lastStatusKind}`
    )
    .join('|');
}

type TrackedEntry = {
  signature: string;
  lastChangedAtMs: number;
  lastObservedActivityAt: number | null;
};

/**
 * Stateful tracker that records when each Working bot or active sub-worker
 * last changed its status, task title, or tool.
 */
export class StuckWatchdogTracker {
  private readonly bots = new Map<string, TrackedEntry>();
  private readonly workers = new Map<string, TrackedEntry>();

  reset(): void {
    this.bots.clear();
    this.workers.clear();
  }

  observe(snapshot: WorldSnapshot, nowMs: number = Date.now()): void {
    const activeBotIds = new Set<string>();
    for (const [botId, bot] of Object.entries(snapshot.bots)) {
      if (isSafeKey(botId) && bot && bot.status.kind === 'Working') {
        activeBotIds.add(botId);
      }
    }
    for (const trackedId of this.bots.keys()) {
      if (!activeBotIds.has(trackedId)) {
        this.bots.delete(trackedId);
      }
    }

    for (const botId of activeBotIds) {
      const bot = snapshot.bots[botId];
      if (!bot) continue;
      const sig = botWatchdogSignature(
        bot.status.kind,
        bot.currentTaskTitle,
        bot.currentTool ?? bot.status.tool
      );
      const prev = this.bots.get(botId);
      const obsTs =
        typeof bot.lastActivityAt === 'number' &&
        Number.isFinite(bot.lastActivityAt) &&
        bot.lastActivityAt > 0 &&
        bot.lastActivityAt <= nowMs
          ? bot.lastActivityAt
          : null;

      if (!prev) {
        if (this.bots.size >= MAX_TRACKED_WATCHDOG_ENTRIES) {
          const oldest = this.bots.keys().next().value;
          if (oldest !== undefined) this.bots.delete(oldest);
        }
        this.bots.set(botId, {
          signature: sig,
          lastChangedAtMs: resolveInitialChangedAt(obsTs, nowMs),
          lastObservedActivityAt: obsTs,
        });
      } else if (prev.signature !== sig) {
        this.bots.set(botId, {
          signature: sig,
          lastChangedAtMs: nowMs,
          lastObservedActivityAt: obsTs,
        });
      } else if (
        obsTs !== null &&
        (prev.lastObservedActivityAt === null || obsTs > prev.lastObservedActivityAt)
      ) {
        prev.lastChangedAtMs = Math.max(prev.lastChangedAtMs, obsTs);
        prev.lastObservedActivityAt = obsTs;
      }
    }

    const activeWorkerIds = new Set<string>();
    for (const [dispatchId, worker] of Object.entries(snapshot.workers)) {
      if (isSafeKey(dispatchId) && worker && isWorkerActive(worker)) {
        activeWorkerIds.add(dispatchId);
      }
    }
    for (const trackedId of this.workers.keys()) {
      if (!activeWorkerIds.has(trackedId)) {
        this.workers.delete(trackedId);
      }
    }

    for (const dispatchId of activeWorkerIds) {
      const worker = snapshot.workers[dispatchId];
      if (!worker) continue;
      const sig = workerWatchdogSignature(
        worker.workerState,
        worker.activity,
        worker.toolName,
        worker.taskTitle
      );
      const prev = this.workers.get(dispatchId);
      const obsTs =
        typeof worker.updatedAt === 'number' &&
        Number.isFinite(worker.updatedAt) &&
        worker.updatedAt > 0 &&
        worker.updatedAt <= nowMs
          ? worker.updatedAt
          : null;

      if (!prev) {
        if (this.workers.size >= MAX_TRACKED_WATCHDOG_ENTRIES) {
          const oldest = this.workers.keys().next().value;
          if (oldest !== undefined) this.workers.delete(oldest);
        }
        this.workers.set(dispatchId, {
          signature: sig,
          lastChangedAtMs: resolveInitialChangedAt(obsTs, nowMs),
          lastObservedActivityAt: obsTs,
        });
      } else if (prev.signature !== sig) {
        this.workers.set(dispatchId, {
          signature: sig,
          lastChangedAtMs: nowMs,
          lastObservedActivityAt: obsTs,
        });
      } else if (
        obsTs !== null &&
        (prev.lastObservedActivityAt === null || obsTs > prev.lastObservedActivityAt)
      ) {
        prev.lastChangedAtMs = Math.max(prev.lastChangedAtMs, obsTs);
        prev.lastObservedActivityAt = obsTs;
      }
    }
  }

  evaluate(
    snapshot: WorldSnapshot,
    opts: {
      thresholdMin: number;
      nowMs?: number;
      redactMode?: boolean;
      locale?: UiLocale;
    }
  ): StuckAlert[] {
    const thresholdMin = clampStuckThresholdMin(opts.thresholdMin);
    if (thresholdMin <= 0) {
      this.reset();
      return [];
    }
    if (!snapshot.runtime.connected) {
      return [];
    }
    const nowMs =
      typeof opts.nowMs === 'number' && Number.isFinite(opts.nowMs) && opts.nowMs > 0
        ? opts.nowMs
        : snapshot.capturedAt > 0
          ? snapshot.capturedAt
          : Date.now();
    this.observe(snapshot, nowMs);
    return this.getAlerts(snapshot, { ...opts, thresholdMin, nowMs });
  }

  getAlerts(
    snapshot: WorldSnapshot,
    opts: {
      thresholdMin: number;
      nowMs?: number;
      redactMode?: boolean;
      locale?: UiLocale;
    }
  ): StuckAlert[] {
    const botChangedAt = new Map<string, number>();
    for (const [id, entry] of this.bots.entries()) {
      botChangedAt.set(id, entry.lastChangedAtMs);
    }
    const workerChangedAt = new Map<string, number>();
    for (const [id, entry] of this.workers.entries()) {
      workerChangedAt.set(id, entry.lastChangedAtMs);
    }

    return computeStuckAlerts(snapshot, {
      ...opts,
      botChangedAt,
      workerChangedAt,
    });
  }
}
