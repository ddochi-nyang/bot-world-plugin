import {
  createEventRecord,
  extractWorkerSeq,
  isValidWorkerSeq,
  scrubWorldEvent,
} from './events.ts';
import { scrubAll } from './redact.ts';
import {
  type ActorRef,
  type BotActivityStatus,
  type BotState,
  type Keyframe,
  type RuntimeHealth,
  type UiLocale,
  type WorkerState,
  type WorldEvent,
  type WorldEventRecord,
  type WorldSnapshot,
  createEmptySnapshot,
  isSafeKey,
  isWorkerVisibleOnStage,
  stripDangerousKeys,
} from './types.ts';

export const MAX_KEYFRAMES = 240;
export const MAX_EVENTS = 500;
export const EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_IDLE_KEYFRAME_INTERVAL_MS = 30_000;
export const SAFE_IPC_PAYLOAD_BYTES = 180 * 1024;

export type KeyframeInterpolation = {
  prevIndex: number;
  nextIndex: number;
  prevTimestampMs: number;
  nextTimestampMs: number;
  alpha: number;
};

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isStrOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNumOrNull(v: unknown): v is number | null {
  return v === null || isFiniteNum(v);
}

function isValidActorRef(raw: unknown): raw is ActorRef {
  if (!isPlainObj(raw) || typeof raw.kind !== 'string') return false;
  switch (raw.kind) {
    case 'Bot':
      return typeof raw.botId === 'string' && isSafeKey(raw.botId) && typeof raw.botName === 'string';
    case 'Worker':
      return (
        typeof raw.dispatchId === 'string' &&
        isStrOrNull(raw.parentBotId) &&
        typeof raw.label === 'string'
      );
    case 'BossDesk':
    case 'AutomationBoard':
    case 'OfficeDoor':
      return true;
    case 'Unknown':
      return typeof raw.raw === 'string';
    default:
      return false;
  }
}

export function isValidWorldEvent(raw: unknown): raw is WorldEvent {
  if (!isPlainObj(raw) || typeof raw.kind !== 'string') return false;
  switch (raw.kind) {
    case 'Handoff':
    case 'Question':
    case 'StatusReport':
    case 'Reply':
      return (
        typeof raw.messageId === 'string' &&
        isValidActorRef(raw.from) &&
        isValidActorRef(raw.to) &&
        typeof raw.subject === 'string'
      );
    case 'WorkerStart':
      return (
        typeof raw.dispatchId === 'string' &&
        isStrOrNull(raw.parentBotId) &&
        isStrOrNull(raw.parentBotName) &&
        typeof raw.provider === 'string' &&
        isStrOrNull(raw.taskTitle)
      );
    case 'WorkerDone':
    case 'WorkerFailed':
      return (
        typeof raw.dispatchId === 'string' &&
        isStrOrNull(raw.parentBotId) &&
        isStrOrNull(raw.parentBotName) &&
        typeof raw.subject === 'string'
      );
    case 'Escalation':
      return (
        isValidActorRef(raw.actor) &&
        isStrOrNull(raw.targetBotId) &&
        typeof raw.reason === 'string'
      );
    case 'ApprovalClosed':
      return isValidActorRef(raw.actor) && isStrOrNull(raw.parentBotId);
    case 'ItemNeedsYou':
      return (
        typeof raw.itemUid === 'string' &&
        isFiniteNum(raw.number) &&
        typeof raw.botId === 'string' &&
        typeof raw.botName === 'string' &&
        typeof raw.title === 'string' &&
        isFiniteNum(raw.optionsCount)
      );
    case 'BossReplied':
      return (
        typeof raw.botId === 'string' &&
        typeof raw.botName === 'string' &&
        isNumOrNull(raw.itemNumber) &&
        typeof raw.subject === 'string'
      );
    case 'ItemDone':
    case 'ItemCanceled':
      return (
        typeof raw.itemUid === 'string' &&
        isFiniteNum(raw.number) &&
        typeof raw.botId === 'string' &&
        typeof raw.botName === 'string' &&
        typeof raw.title === 'string'
      );
    case 'BotWorking':
    case 'ToolChanged':
      return (
        typeof raw.botId === 'string' &&
        typeof raw.botName === 'string' &&
        isStrOrNull(raw.tool)
      );
    case 'BotIdle':
    case 'WaitingAnswer':
    case 'BotPaused':
      return typeof raw.botId === 'string' && typeof raw.botName === 'string';
    case 'BotFailed':
      return (
        typeof raw.botId === 'string' &&
        typeof raw.botName === 'string' &&
        isStrOrNull(raw.message)
      );
    case 'AutomationRun':
      return (
        typeof raw.automationId === 'string' &&
        typeof raw.automationName === 'string' &&
        isStrOrNull(raw.botId) &&
        isStrOrNull(raw.botName) &&
        typeof raw.success === 'boolean' &&
        typeof raw.noReply === 'boolean' &&
        isStrOrNull(raw.error)
      );
    case 'WorkerExited':
    case 'WorkerReleased':
      return (
        typeof raw.dispatchId === 'string' &&
        isStrOrNull(raw.parentBotId) &&
        isStrOrNull(raw.parentBotName) &&
        typeof raw.provider === 'string'
      );
    case 'BotJoined':
      return (
        typeof raw.botId === 'string' &&
        typeof raw.botName === 'string' &&
        typeof raw.specialty === 'string'
      );
    default:
      return false;
  }
}

function sanitizeBotStatus(raw: unknown): BotActivityStatus {
  if (!isPlainObj(raw) || typeof raw.kind !== 'string') {
    return { kind: 'Idle' };
  }
  switch (raw.kind) {
    case 'Paused':
      return { kind: 'Paused' };
    case 'NeedsOwner':
      return {
        kind: 'NeedsOwner',
        count: isFiniteNum(raw.count) ? raw.count : 1,
        prompt: typeof raw.prompt === 'string' ? scrubAll(raw.prompt) : null,
        optionsCount: isFiniteNum(raw.optionsCount) ? raw.optionsCount : 0,
      };
    case 'Blocked':
      return {
        kind: 'Blocked',
        reason: typeof raw.reason === 'string' ? scrubAll(raw.reason) : null,
      };
    case 'WaitingAnswer':
      return { kind: 'WaitingAnswer' };
    case 'Working':
      return {
        kind: 'Working',
        tool: typeof raw.tool === 'string' ? scrubAll(raw.tool) : null,
      };
    case 'Error':
      return {
        kind: 'Error',
        message: typeof raw.message === 'string' ? scrubAll(raw.message) : null,
      };
    case 'Idle':
    default:
      return { kind: 'Idle' };
  }
}

function sanitizeKeyframeSnapshot(raw: unknown, fallbackTimestampMs: number): WorldSnapshot | null {
  if (!isPlainObj(raw)) return null;
  if (!isPlainObj(raw.bots) || !isPlainObj(raw.workers) || !Array.isArray(raw.botOrder) || !isPlainObj(raw.runtime)) {
    return null;
  }
  const base = createEmptySnapshot();
  const rt = raw.runtime;
  const runtime: RuntimeHealth = {
    connected: typeof rt.connected === 'boolean' ? rt.connected : false,
    reachable: typeof rt.reachable === 'boolean' ? rt.reachable : false,
    state: typeof rt.state === 'string' ? scrubAll(rt.state) : 'unknown',
    runtimeId: typeof rt.runtimeId === 'string' ? rt.runtimeId : null,
    appVersion: typeof rt.appVersion === 'string' ? scrubAll(rt.appVersion) : null,
    retryAfterSecs: isFiniteNum(rt.retryAfterSecs) ? rt.retryAfterSecs : null,
    errorMessage: typeof rt.errorMessage === 'string' ? scrubAll(rt.errorMessage) : null,
  };

  const bots: Record<string, BotState> = {};
  for (const [id, rawBot] of Object.entries(raw.bots)) {
    if (!isSafeKey(id) || !isPlainObj(rawBot)) continue;
    if (typeof rawBot.name !== 'string') continue;
    const bot: BotState = {
      id: typeof rawBot.id === 'string' && isSafeKey(rawBot.id) ? rawBot.id : id,
      name: scrubAll(rawBot.name),
      agent: typeof rawBot.agent === 'string' ? scrubAll(rawBot.agent) : '',
      paused: typeof rawBot.paused === 'boolean' ? rawBot.paused : false,
      specialty: typeof rawBot.specialty === 'string' ? scrubAll(rawBot.specialty) : '',
      status: sanitizeBotStatus(rawBot.status),
      currentTaskTitle:
        typeof rawBot.currentTaskTitle === 'string' ? scrubAll(rawBot.currentTaskTitle) : null,
      currentTool: typeof rawBot.currentTool === 'string' ? scrubAll(rawBot.currentTool) : null,
      lastActivityAt: isFiniteNum(rawBot.lastActivityAt) ? rawBot.lastActivityAt : null,
      homeChatId: typeof rawBot.homeChatId === 'string' ? rawBot.homeChatId : null,
      needsYouCount: isFiniteNum(rawBot.needsYouCount) ? rawBot.needsYouCount : 0,
      activeWorkerCount: isFiniteNum(rawBot.activeWorkerCount) ? rawBot.activeWorkerCount : 0,
    };
    Object.defineProperty(bots, id, {
      value: bot,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const workers: Record<string, WorkerState> = {};
  for (const [id, rawW] of Object.entries(raw.workers)) {
    if (!isSafeKey(id) || !isPlainObj(rawW)) continue;
    if (typeof rawW.provider !== 'string' || typeof rawW.workerState !== 'string') continue;
    const liveness =
      rawW.liveness === 'Live' || rawW.liveness === 'Exited' || rawW.liveness === 'Unverifiable'
        ? rawW.liveness
        : 'Unverifiable';
    const worker: WorkerState = {
      dispatchId: typeof rawW.dispatchId === 'string' && isSafeKey(rawW.dispatchId) ? rawW.dispatchId : id,
      taskId: typeof rawW.taskId === 'string' ? rawW.taskId : null,
      runId: typeof rawW.runId === 'string' ? rawW.runId : null,
      parentBotId: typeof rawW.parentBotId === 'string' ? rawW.parentBotId : null,
      parentBotName: typeof rawW.parentBotName === 'string' ? scrubAll(rawW.parentBotName) : null,
      provider: scrubAll(rawW.provider),
      model: typeof rawW.model === 'string' ? scrubAll(rawW.model) : null,
      workerState: rawW.workerState,
      dispatchStatus: typeof rawW.dispatchStatus === 'string' ? rawW.dispatchStatus : '',
      terminalState: typeof rawW.terminalState === 'string' ? rawW.terminalState : null,
      terminalHandle: typeof rawW.terminalHandle === 'string' ? rawW.terminalHandle : null,
      worktreeId: typeof rawW.worktreeId === 'string' ? rawW.worktreeId : null,
      liveness,
      activity: typeof rawW.activity === 'string' ? scrubAll(rawW.activity) : '',
      toolName: typeof rawW.toolName === 'string' ? scrubAll(rawW.toolName) : null,
      taskTitle: typeof rawW.taskTitle === 'string' ? scrubAll(rawW.taskTitle) : null,
      updatedAt: isFiniteNum(rawW.updatedAt) ? rawW.updatedAt : null,
    };
    Object.defineProperty(workers, id, {
      value: worker,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const botOrder = raw.botOrder.filter((id): id is string => typeof id === 'string' && isSafeKey(id));

  return {
    ...base,
    capturedAt: isFiniteNum(raw.capturedAt) ? raw.capturedAt : fallbackTimestampMs,
    runtime,
    bots,
    botOrder,
    workers,
    initialSyncComplete: typeof raw.initialSyncComplete === 'boolean' ? raw.initialSyncComplete : false,
  };
}

/**
 * Produces a lightweight, scrubbed clone of a WorldSnapshot suitable for
 * 24-hour keyframe storage & IPC transport without bloating over Orca's 256 KiB post limit.
 */
export function compactKeyframeSnapshot(snapshot: WorldSnapshot): WorldSnapshot {
  const bots: WorldSnapshot['bots'] = {};
  const rawBots = isPlainObj(snapshot.bots) ? snapshot.bots : {};
  for (const [id, b] of Object.entries(rawBots)) {
    if (!isSafeKey(id) || !b || typeof b !== 'object') continue;
    Object.defineProperty(bots, id, {
      value: {
        ...b,
        name: scrubAll(typeof b.name === 'string' ? b.name : id),
        specialty: '', // Omit bulky specialty text from historical keyframes
        currentTaskTitle:
          typeof b.currentTaskTitle === 'string' ? scrubAll(b.currentTaskTitle) : null,
        currentTool: typeof b.currentTool === 'string' ? scrubAll(b.currentTool) : null,
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const workers: WorldSnapshot['workers'] = {};
  const rawWorkers = isPlainObj(snapshot.workers) ? snapshot.workers : {};
  for (const [id, w] of Object.entries(rawWorkers)) {
    if (!isSafeKey(id) || !w || typeof w !== 'object' || !isWorkerVisibleOnStage(w)) continue;
    Object.defineProperty(workers, id, {
      value: {
        ...w,
        provider: scrubAll(typeof w.provider === 'string' ? w.provider : ''),
        activity: scrubAll(typeof w.activity === 'string' ? w.activity : ''),
        toolName: typeof w.toolName === 'string' ? scrubAll(w.toolName) : null,
        taskTitle: typeof w.taskTitle === 'string' ? scrubAll(w.taskTitle) : null,
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return {
    capturedAt: isFiniteNum(snapshot.capturedAt) ? snapshot.capturedAt : 0,
    runtime: isPlainObj(snapshot.runtime) ? { ...snapshot.runtime } : createEmptySnapshot().runtime,
    bots,
    botOrder: Array.isArray(snapshot.botOrder)
      ? snapshot.botOrder.filter((id) => typeof id === 'string' && isSafeKey(id))
      : [],
    chatIndex: {},
    runBotIndex: {},
    workers,
    items: {},
    automations: {},
    inboxCursor: { lastSequence: 0, seenIds: [], needsBackfill: false },
    recentMessages: [],
    rebaselineNeeded: false,
    initialSyncComplete: Boolean(snapshot.initialSyncComplete),
  };
}

export function scrubFullSnapshot(snapshot: WorldSnapshot): WorldSnapshot {
  const clean = stripDangerousKeys(snapshot);
  const bots: WorldSnapshot['bots'] = {};
  for (const [id, b] of Object.entries(clean.bots)) {
    if (!isSafeKey(id)) continue;
    Object.defineProperty(bots, id, {
      value: {
        ...b,
        name: scrubAll(b.name),
        agent: scrubAll(b.agent),
        specialty: scrubAll(b.specialty),
        currentTaskTitle: b.currentTaskTitle !== null ? scrubAll(b.currentTaskTitle) : null,
        currentTool: b.currentTool !== null ? scrubAll(b.currentTool) : null,
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const workers: WorldSnapshot['workers'] = {};
  for (const [id, w] of Object.entries(clean.workers)) {
    if (!isSafeKey(id)) continue;
    Object.defineProperty(workers, id, {
      value: {
        ...w,
        provider: scrubAll(w.provider),
        model: w.model !== null ? scrubAll(w.model) : null,
        activity: scrubAll(w.activity),
        toolName: w.toolName !== null ? scrubAll(w.toolName) : null,
        taskTitle: w.taskTitle !== null ? scrubAll(w.taskTitle) : null,
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const items: WorldSnapshot['items'] = {};
  for (const [id, it] of Object.entries(clean.items)) {
    if (!isSafeKey(id)) continue;
    const scrubbedOptions = Array.isArray(it.questionOptions)
      ? it.questionOptions
          .slice(0, 6)
          .filter((o) => o && typeof o === 'object' && typeof o.label === 'string' && o.label.trim().length > 0)
          .map((o) => ({
            label: scrubAll(o.label),
            ...(typeof o.detail === 'string' && o.detail.trim().length > 0 ? { detail: scrubAll(o.detail) } : {}),
            ...(o.recommended === true ? { recommended: true } : {}),
          }))
      : [];
    Object.defineProperty(items, id, {
      value: {
        ...it,
        ownerBotName: scrubAll(it.ownerBotName),
        title: scrubAll(it.title),
        questionPrompt: it.questionPrompt !== null ? scrubAll(it.questionPrompt) : null,
        questionOptions: scrubbedOptions,
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const automations: WorldSnapshot['automations'] = {};
  for (const [id, a] of Object.entries(clean.automations)) {
    if (!isSafeKey(id)) continue;
    Object.defineProperty(automations, id, {
      value: {
        ...a,
        name: scrubAll(a.name),
        lastError: a.lastError !== null ? scrubAll(a.lastError) : null,
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return {
    ...clean,
    runtime: {
      ...clean.runtime,
      state: scrubAll(clean.runtime.state),
      appVersion: clean.runtime.appVersion !== null ? scrubAll(clean.runtime.appVersion) : null,
      errorMessage: clean.runtime.errorMessage !== null ? scrubAll(clean.runtime.errorMessage) : null,
    },
    bots,
    workers,
    items,
    automations,
    recentMessages: clean.recentMessages.map((m) => ({
      ...m,
      fromHandle: scrubAll(m.fromHandle),
      toHandle: scrubAll(m.toHandle),
      subject: scrubAll(m.subject),
      body: scrubAll(m.body),
      payload: m.payload !== null ? scrubAll(m.payload) : null,
    })),
  };
}

export class TimelineBuffer {
  keyframes: Keyframe[] = [];
  eventLog: WorldEventRecord[] = [];

  recordKeyframe(snapshot: WorldSnapshot, timestampMs: number): void {
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) return;
    const compact = compactKeyframeSnapshot(snapshot);
    compact.capturedAt = timestampMs;

    const last = this.keyframes[this.keyframes.length - 1];
    if (last) {
      if (last.timestampMs === timestampMs) {
        last.snapshot = compact;
        return;
      }
      if (timestampMs < last.timestampMs) {
        let pos = 0;
        while (pos < this.keyframes.length && this.keyframes[pos].timestampMs < timestampMs) {
          pos++;
        }
        if (this.keyframes[pos]?.timestampMs === timestampMs) {
          this.keyframes[pos].snapshot = compact;
        } else {
          this.keyframes.splice(pos, 0, { timestampMs, snapshot: compact });
        }
        this.pruneExpired(timestampMs);
        while (this.keyframes.length > MAX_KEYFRAMES) {
          this.keyframes.shift();
        }
        return;
      }
    }

    this.keyframes.push({ timestampMs, snapshot: compact });
    this.pruneExpired(timestampMs);
    while (this.keyframes.length > MAX_KEYFRAMES) {
      this.keyframes.shift();
    }
  }

  maybeRecordLiveKeyframe(
    snapshot: WorldSnapshot,
    timestampMs: number,
    hasEvents: boolean,
    minIdleIntervalMs = DEFAULT_IDLE_KEYFRAME_INTERVAL_MS
  ): boolean {
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) return false;
    const last = this.keyframes[this.keyframes.length - 1];
    const shouldRecord =
      !last || hasEvents || timestampMs - last.timestampMs >= minIdleIntervalMs;
    if (shouldRecord) {
      this.recordKeyframe(snapshot, timestampMs);
      return true;
    }
    return false;
  }

  pushEventRecord(record: WorldEventRecord): void {
    const scrubbed: WorldEventRecord = {
      timestampMs: record.timestampMs,
      summary: scrubAll(record.summary),
      redactedSummary: scrubAll(record.redactedSummary),
      event: scrubWorldEvent(record.event),
    };
    if (isValidWorkerSeq(record.workerSeq)) {
      scrubbed.workerSeq = record.workerSeq;
    }
    if (scrubbed.timestampMs > 0) {
      this.pruneExpired(scrubbed.timestampMs);
    }
    while (this.eventLog.length >= MAX_EVENTS) {
      this.eventLog.shift();
    }
    this.eventLog.push(scrubbed);
  }

  pushEvent(
    event: WorldEvent,
    timestampMs: number,
    workerSeqHint = 1,
    locale: UiLocale = 'en'
  ): WorldEventRecord {
    const rec = createEventRecord(event, timestampMs, workerSeqHint, locale);
    this.pushEventRecord(rec);
    return rec;
  }

  pruneExpired(nowMs: number): void {
    if (!Number.isFinite(nowMs) || nowMs <= 0) return;
    while (
      this.keyframes.length > 0 &&
      this.keyframes[0].timestampMs > 0 &&
      nowMs - this.keyframes[0].timestampMs > EVENT_RETENTION_MS
    ) {
      this.keyframes.shift();
    }
    while (
      this.eventLog.length > 0 &&
      this.eventLog[0].timestampMs > 0 &&
      nowMs - this.eventLog[0].timestampMs > EVENT_RETENTION_MS
    ) {
      this.eventLog.shift();
    }
  }

  timeBounds(): [number, number] | null {
    let minTs: number | null = null;
    let maxTs: number | null = null;
    const candidates = [
      this.keyframes[0]?.timestampMs,
      this.keyframes[this.keyframes.length - 1]?.timestampMs,
      this.eventLog[0]?.timestampMs,
      this.eventLog[this.eventLog.length - 1]?.timestampMs,
    ];
    for (const ts of candidates) {
      if (typeof ts !== 'number' || ts <= 0) continue;
      minTs = minTs === null ? ts : Math.min(minTs, ts);
      maxTs = maxTs === null ? ts : Math.max(maxTs, ts);
    }
    if (minTs === null || maxTs === null) return null;
    return [minTs, Math.max(minTs, maxTs)];
  }

  interpolateAt(timestampMs: number): KeyframeInterpolation | null {
    if (this.keyframes.length === 0) return null;
    if (this.keyframes.length === 1) {
      const ts = this.keyframes[0].timestampMs;
      return {
        prevIndex: 0,
        nextIndex: 0,
        prevTimestampMs: ts,
        nextTimestampMs: ts,
        alpha: 0,
      };
    }
    const firstTs = this.keyframes[0].timestampMs;
    if (timestampMs <= firstTs) {
      return {
        prevIndex: 0,
        nextIndex: 0,
        prevTimestampMs: firstTs,
        nextTimestampMs: firstTs,
        alpha: 0,
      };
    }
    const lastIdx = this.keyframes.length - 1;
    const lastTs = this.keyframes[lastIdx].timestampMs;
    if (timestampMs >= lastTs) {
      return {
        prevIndex: lastIdx,
        nextIndex: lastIdx,
        prevTimestampMs: lastTs,
        nextTimestampMs: lastTs,
        alpha: 1,
      };
    }

    let nextIndex = 0;
    while (nextIndex < lastIdx && this.keyframes[nextIndex].timestampMs <= timestampMs) {
      nextIndex++;
    }
    const prevIndex = Math.max(0, nextIndex - 1);
    const prevTs = this.keyframes[prevIndex].timestampMs;
    const nextTs = this.keyframes[nextIndex].timestampMs;
    const span = Math.max(1, nextTs - prevTs);
    const alpha = Math.max(0, Math.min(1, (timestampMs - prevTs) / span));

    return {
      prevIndex,
      nextIndex,
      prevTimestampMs: prevTs,
      nextTimestampMs: nextTs,
      alpha,
    };
  }

  snapshotAt(timestampMs: number): WorldSnapshot | null {
    const interp = this.interpolateAt(timestampMs);
    if (!interp) return null;
    const base = this.keyframes[interp.prevIndex]?.snapshot;
    if (!base) return null;
    return {
      ...base,
      capturedAt: Math.max(timestampMs, interp.prevTimestampMs),
    };
  }

  eventRecordsInRange(fromMs: number, toMs: number): WorldEventRecord[] {
    if (toMs < fromMs) return [];
    return this.eventLog
      .filter((rec) => rec.timestampMs > fromMs && rec.timestampMs <= toMs)
      .sort((a, b) => a.timestampMs - b.timestampMs);
  }

  eventsInRange(fromMs: number, toMs: number): WorldEvent[] {
    return this.eventRecordsInRange(fromMs, toMs).map((r) => r.event);
  }

  /**
   * Returns events and keyframes bounded to stay safely within Orca's 256 KiB IPC limit.
   */
  exportBounded(
    sinceMs?: number,
    budgetBytes: number = SAFE_IPC_PAYLOAD_BYTES
  ): { events: WorldEventRecord[]; keyframes: Keyframe[] } {
    const filteredEvents =
      typeof sinceMs === 'number' && Number.isFinite(sinceMs)
        ? this.eventLog.filter((e) => e.timestampMs >= sinceMs)
        : [...this.eventLog];
    const events = filteredEvents.slice(-MAX_EVENTS);
    const keyframes = this.keyframes.slice(-MAX_KEYFRAMES);

    const maxBytes = Math.max(0, Math.trunc(budgetBytes));
    const encoder = new TextEncoder();
    const outEvents = [...events];
    const outKeyframes = [...keyframes];
    let size = encoder.encode(JSON.stringify({ events: outEvents, keyframes: outKeyframes })).byteLength;

    while (size > maxBytes && (outKeyframes.length > 0 || outEvents.length > 0)) {
      if (outKeyframes.length > 0 && (outKeyframes.length > 2 || outEvents.length === 0)) {
        outKeyframes.splice(0, Math.max(1, Math.floor(outKeyframes.length / 4)));
      } else if (outEvents.length > 0) {
        outEvents.splice(0, Math.max(1, Math.floor(outEvents.length / 4)));
      } else if (outKeyframes.length > 0) {
        outKeyframes.splice(0, Math.max(1, Math.floor(outKeyframes.length / 4)));
      }
      size = encoder.encode(JSON.stringify({ events: outEvents, keyframes: outKeyframes })).byteLength;
    }

    return { events: outEvents, keyframes: outKeyframes };
  }

  serialize(): { events: WorldEventRecord[]; keyframes: Keyframe[] } {
    return this.exportBounded();
  }

  static hydrate(raw: unknown, nowMs: number = Date.now()): TimelineBuffer {
    const buf = new TimelineBuffer();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return buf;
    }
    const clean = stripDangerousKeys(raw as Record<string, unknown>);
    if (Array.isArray(clean.events)) {
      for (const item of clean.events) {
        try {
          if (!isPlainObj(item)) continue;
          const rec = item as Partial<WorldEventRecord>;
          if (
            typeof rec.timestampMs === 'number' &&
            Number.isFinite(rec.timestampMs) &&
            rec.timestampMs > 0 &&
            isValidWorldEvent(rec.event)
          ) {
            const eventCopy = scrubWorldEvent(rec.event);
            const validWorkerSeq = isValidWorkerSeq(rec.workerSeq)
              ? rec.workerSeq
              : extractWorkerSeq({
                  event: eventCopy,
                  redactedSummary:
                    typeof rec.redactedSummary === 'string' ? rec.redactedSummary : '',
                });
            const fallbackSummaries = createEventRecord(
              eventCopy,
              rec.timestampMs,
              validWorkerSeq ?? 1
            );
            const recordToPush: WorldEventRecord = {
              timestampMs: rec.timestampMs,
              summary:
                typeof rec.summary === 'string' && rec.summary.length > 0
                  ? rec.summary
                  : fallbackSummaries.summary,
              redactedSummary:
                typeof rec.redactedSummary === 'string' && rec.redactedSummary.length > 0
                  ? rec.redactedSummary
                  : fallbackSummaries.redactedSummary,
              event: eventCopy,
            };
            if (validWorkerSeq !== undefined) {
              recordToPush.workerSeq = validWorkerSeq;
            }
            buf.pushEventRecord(recordToPush);
          }
        } catch {
          // Skip malformed event record without crashing hydrate
        }
      }
    }
    if (Array.isArray(clean.keyframes)) {
      for (const item of clean.keyframes) {
        try {
          if (!isPlainObj(item)) continue;
          const kf = item as Partial<Keyframe>;
          if (
            typeof kf.timestampMs === 'number' &&
            Number.isFinite(kf.timestampMs) &&
            kf.timestampMs > 0
          ) {
            const sanitized = sanitizeKeyframeSnapshot(kf.snapshot, kf.timestampMs);
            if (sanitized) {
              buf.recordKeyframe(sanitized, kf.timestampMs);
            }
          }
        } catch {
          // Skip malformed keyframe record without crashing hydrate
        }
      }
    }
    buf.pruneExpired(nowMs);
    return buf;
  }
}

export { formatTimeHms } from '../shared/i18n.ts';

export function formatKstHms(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) {
    return '--:--:--';
  }
  const totalSecs = Math.floor(epochMs / 1000);
  const kstSecs = ((totalSecs + 9 * 3600) % 86_400 + 86_400) % 86_400;
  const h = Math.floor(kstSecs / 3600);
  const m = Math.floor((kstSecs % 3600) / 60);
  const s = kstSecs % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
