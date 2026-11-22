import { eventRelatedBotId } from './events.ts';
import {
  type DailyTrendPoint,
  type WorldEvent,
  type WorldEventRecord,
  stripDangerousKeys,
} from './types.ts';

export type { DailyTrendPoint } from './types.ts';

export const MAX_WEEKLY_TREND_DAYS = 14;
export const MAX_SEEN_EVENT_IDS = 1000;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type WeeklyTrendStore = {
  days: DailyTrendPoint[];
  seenIds: string[];
};

export function formatLocalDateKey(epochMs: number): string {
  const ts = Number.isFinite(epochMs) && epochMs > 0 ? epochMs : Date.now();
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shiftLocalDateKey(nowMs: number, daysAgo: number): string {
  const ts = Number.isFinite(nowMs) && nowMs > 0 ? nowMs : Date.now();
  const base = new Date(ts);
  const shifted = new Date(base.getFullYear(), base.getMonth(), base.getDate() - daysAgo);
  return formatLocalDateKey(shifted.getTime());
}

function nonNegInt(val: unknown): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return 0;
  return Math.max(0, Math.trunc(val));
}

function sanitizeDailyPoint(raw: unknown): DailyTrendPoint | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.date !== 'string' || !DATE_KEY_RE.test(rec.date)) return null;
  return {
    date: rec.date,
    events: nonNegInt(rec.events),
    tasksDone: nonNegInt(rec.tasksDone),
    workerRuns: nonNegInt(rec.workerRuns),
    collaborations: nonNegInt(rec.collaborations),
  };
}

function isTaskDoneEvent(ev: WorldEvent): boolean {
  if (ev.kind === 'ItemDone' || ev.kind === 'WorkerDone') return true;
  if (ev.kind === 'AutomationRun') return ev.success === true;
  return false;
}

function isCollaborationEvent(ev: WorldEvent): boolean {
  return (
    ev.kind === 'Handoff' ||
    ev.kind === 'Question' ||
    ev.kind === 'Reply' ||
    ev.kind === 'StatusReport'
  );
}

/**
 * Generates a deterministic, PII-free deduplication key for a timeline event record.
 */
export function buildEventDedupKey(rec: WorldEventRecord): string | null {
  if (
    !rec ||
    typeof rec.timestampMs !== 'number' ||
    !Number.isFinite(rec.timestampMs) ||
    rec.timestampMs <= 0 ||
    !rec.event ||
    typeof rec.event !== 'object'
  ) {
    return null;
  }
  const ev = rec.event;
  switch (ev.kind) {
    case 'Handoff':
    case 'Question':
    case 'StatusReport':
    case 'Reply':
      return `msg:${ev.kind}:${ev.messageId || rec.timestampMs}`;
    case 'WorkerStart':
    case 'WorkerDone':
    case 'WorkerFailed':
    case 'WorkerExited':
    case 'WorkerReleased':
      return `wrk:${ev.kind}:${ev.dispatchId || rec.timestampMs}`;
    case 'ItemNeedsYou':
    case 'ItemDone':
    case 'ItemCanceled':
      return `itm:${ev.kind}:${ev.itemUid || ev.number}`;
    case 'AutomationRun':
      return `auto:${ev.automationId}:${Math.trunc(rec.timestampMs)}`;
    default: {
      const botId = eventRelatedBotId(ev) ?? 'none';
      return `${ev.kind}:${botId}:${Math.trunc(rec.timestampMs)}`;
    }
  }
}

function accumulateEventIntoPoint(point: DailyTrendPoint, ev: WorldEvent): void {
  point.events += 1;
  if (isTaskDoneEvent(ev)) {
    point.tasksDone += 1;
  }
  if (ev.kind === 'WorkerStart') {
    point.workerRuns += 1;
  }
  if (isCollaborationEvent(ev)) {
    point.collaborations += 1;
  }
}

function pruneAndSortDays(
  dayMap: Map<string, DailyTrendPoint>,
  nowMs: number,
  maxDays: number
): DailyTrendPoint[] {
  const safeMaxDays = Math.max(1, Math.min(90, Math.trunc(maxDays)));
  const todayKey = formatLocalDateKey(nowMs);
  const cutoffKey = shiftLocalDateKey(nowMs, safeMaxDays - 1);
  return Array.from(dayMap.values())
    .filter((pt) => pt.date >= cutoffKey && pt.date <= todayKey)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Idempotently merges a 24h event window into archived daily trend points.
 * Re-running with the same events never double-counts counts for a day.
 */
export function mergeEventsIntoWeeklyTrend(
  existing: readonly DailyTrendPoint[],
  events: readonly WorldEventRecord[],
  nowMs: number = Date.now(),
  maxDays = MAX_WEEKLY_TREND_DAYS
): DailyTrendPoint[] {
  const safeNow = Number.isFinite(nowMs) && nowMs > 0 ? nowMs : Date.now();
  const dayMap = new Map<string, DailyTrendPoint>();
  if (Array.isArray(existing)) {
    for (const raw of existing) {
      const pt = sanitizeDailyPoint(raw);
      if (pt) {
        dayMap.set(pt.date, pt);
      }
    }
  }

  const perDayFromEvents = new Map<string, DailyTrendPoint>();
  const seenInBatch = new Set<string>();
  for (const rec of events) {
    const key = buildEventDedupKey(rec);
    if (!key || seenInBatch.has(key)) continue;
    seenInBatch.add(key);

    const dateKey = formatLocalDateKey(rec.timestampMs);
    let bucket = perDayFromEvents.get(dateKey);
    if (!bucket) {
      bucket = {
        date: dateKey,
        events: 0,
        tasksDone: 0,
        workerRuns: 0,
        collaborations: 0,
      };
      perDayFromEvents.set(dateKey, bucket);
    }
    accumulateEventIntoPoint(bucket, rec.event);
  }

  for (const [dateKey, fresh] of perDayFromEvents.entries()) {
    const prev = dayMap.get(dateKey);
    if (!prev) {
      dayMap.set(dateKey, fresh);
    } else {
      dayMap.set(dateKey, {
        date: dateKey,
        events: Math.max(prev.events, fresh.events),
        tasksDone: Math.max(prev.tasksDone, fresh.tasksDone),
        workerRuns: Math.max(prev.workerRuns, fresh.workerRuns),
        collaborations: Math.max(prev.collaborations, fresh.collaborations),
      });
    }
  }

  return pruneAndSortDays(dayMap, safeNow, maxDays);
}

export function hydrateWeeklyTrendStore(
  raw: unknown,
  nowMs: number = Date.now(),
  maxDays = MAX_WEEKLY_TREND_DAYS
): WeeklyTrendStore {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { days: [], seenIds: [] };
  }
  const clean = stripDangerousKeys(raw as Record<string, unknown>);
  const dayMap = new Map<string, DailyTrendPoint>();
  if (Array.isArray(clean.days)) {
    for (const item of clean.days) {
      const pt = sanitizeDailyPoint(item);
      if (pt) dayMap.set(pt.date, pt);
    }
  }
  const seenIds: string[] = [];
  const seenSet = new Set<string>();
  if (Array.isArray(clean.seenIds)) {
    for (const rawId of clean.seenIds) {
      if (typeof rawId === 'string' && rawId.length > 0 && rawId.length <= 160 && !seenSet.has(rawId)) {
        seenSet.add(rawId);
        seenIds.push(rawId);
      }
    }
  }
  if (seenIds.length > MAX_SEEN_EVENT_IDS) {
    seenIds.splice(0, seenIds.length - MAX_SEEN_EVENT_IDS);
  }
  return {
    days: pruneAndSortDays(dayMap, nowMs, maxDays),
    seenIds,
  };
}

/**
 * Incrementally merges timeline events into a persisted store using a bounded seen-ID ring
 * so polling never double-counts events even if older events are evicted from the 24h buffer.
 */
export function mergeWeeklyTrendStore(
  store: WeeklyTrendStore,
  events: readonly WorldEventRecord[],
  nowMs: number = Date.now(),
  maxDays = MAX_WEEKLY_TREND_DAYS
): { store: WeeklyTrendStore; changed: boolean } {
  const safeNow = Number.isFinite(nowMs) && nowMs > 0 ? nowMs : Date.now();
  const dayMap = new Map<string, DailyTrendPoint>();
  for (const pt of store.days) {
    const clean = sanitizeDailyPoint(pt);
    if (clean) dayMap.set(clean.date, { ...clean });
  }
  const seenIds = [...store.seenIds];
  const seenSet = new Set<string>(seenIds);
  let changed = false;

  for (const rec of events) {
    const key = buildEventDedupKey(rec);
    if (!key || seenSet.has(key)) continue;

    seenSet.add(key);
    seenIds.push(key);
    if (seenIds.length > MAX_SEEN_EVENT_IDS) {
      const dropped = seenIds.shift();
      if (dropped) seenSet.delete(dropped);
    }

    const dateKey = formatLocalDateKey(rec.timestampMs);
    let bucket = dayMap.get(dateKey);
    if (!bucket) {
      bucket = {
        date: dateKey,
        events: 0,
        tasksDone: 0,
        workerRuns: 0,
        collaborations: 0,
      };
      dayMap.set(dateKey, bucket);
    }
    accumulateEventIntoPoint(bucket, rec.event);
    changed = true;
  }

  const nextDays = pruneAndSortDays(dayMap, safeNow, maxDays);
  if (nextDays.length !== store.days.length) {
    changed = true;
  }

  return {
    store: {
      days: nextDays,
      seenIds,
    },
    changed,
  };
}

/**
 * Returns exactly 7 chronologically ordered days ending on today's local date,
 * filling missing days with zero counts.
 */
export function getLastSevenDaysTrend(
  points: readonly DailyTrendPoint[],
  nowMs: number = Date.now()
): DailyTrendPoint[] {
  const safeNow = Number.isFinite(nowMs) && nowMs > 0 ? nowMs : Date.now();
  const byDate = new Map<string, DailyTrendPoint>();
  if (Array.isArray(points)) {
    for (const raw of points) {
      const pt = sanitizeDailyPoint(raw);
      if (pt) {
        byDate.set(pt.date, pt);
      }
    }
  }

  const out: DailyTrendPoint[] = [];
  for (let offset = 6; offset >= 0; offset--) {
    const dateKey = shiftLocalDateKey(safeNow, offset);
    const existing = byDate.get(dateKey);
    out.push(
      existing
        ? { ...existing }
        : {
            date: dateKey,
            events: 0,
            tasksDone: 0,
            workerRuns: 0,
            collaborations: 0,
          }
    );
  }
  return out;
}
