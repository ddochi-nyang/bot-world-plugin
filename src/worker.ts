import type { JsonValue, OrcaWorkerApi } from 'orca/worker';
import { diffSnapshots, redactWorldEvent, resolveHandle } from './events.ts';
import { OrcaCli, type OrcaClient } from './orca-cli.ts';
import { PollerSession } from './poller.ts';
import './protocol.ts';
import { redactLabel, scrubAll } from './redact.ts';
import { TimelineBuffer, scrubFullSnapshot } from './timeline.ts';
import {
  type ActorRef,
  type BotWorldStatePayload,
  type CharacterId,
  MAX_BOT_APPEARANCES,
  type ThemeId,
  type WorldSnapshot,
  botStatusLabelKo,
  createEmptySnapshot,
  isPoolCharacterId,
  isSafeKey,
  isValidThemeId,
  isWorkerActive,
  isWorkerVisibleOnStage,
  stripDangerousKeys,
  toPlainSafeRecord,
} from './types.ts';

const STORAGE_PREFS_KEY = 'botWorld.prefs';
const STORAGE_TIMELINE_KEY = 'botWorld.timeline';
export const MAX_IPC_PAYLOAD_BYTES = 220 * 1024;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const utf8Encoder = new TextEncoder();

function utf8ByteLength(value: unknown): number {
  return utf8Encoder.encode(JSON.stringify(value)).byteLength;
}

function truncateUiText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, maxChars).join('')}…`;
}

function redactSafeHandle(actor: ActorRef): string {
  switch (actor.kind) {
    case 'Bot':
      return actor.botId;
    case 'Worker':
      return `dispatch:${actor.dispatchId}`;
    case 'BossDesk':
      return 'orca:items';
    case 'AutomationBoard':
      return 'orca:automations';
    case 'OfficeDoor':
      return 'orca:door';
    case 'Unknown':
    default:
      return '비공개';
  }
}

type StoredPrefs = {
  activeTheme: ThemeId;
  redactMode: boolean;
  botAppearances: Record<string, CharacterId>;
  hasThemeOverride: boolean;
  hasRedactOverride: boolean;
};

function makeHostError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function validatePrefs(raw: unknown, defaults: { theme: ThemeId; redact: boolean }): StoredPrefs {
  const base: StoredPrefs = {
    activeTheme: defaults.theme,
    redactMode: defaults.redact,
    botAppearances: {},
    hasThemeOverride: false,
    hasRedactOverride: false,
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return base;
  }
  const clean = stripDangerousKeys(raw as Record<string, unknown>);
  if (isValidThemeId(clean.activeTheme)) {
    base.activeTheme = clean.activeTheme;
    base.hasThemeOverride = clean.hasThemeOverride === true;
  }
  if (typeof clean.redactMode === 'boolean') {
    base.redactMode = clean.redactMode;
    base.hasRedactOverride = clean.hasRedactOverride === true;
  }
  if (clean.botAppearances && typeof clean.botAppearances === 'object' && !Array.isArray(clean.botAppearances)) {
    const map = new Map<string, CharacterId>();
    for (const [botId, charId] of Object.entries(clean.botAppearances as Record<string, unknown>)) {
      if (map.size >= MAX_BOT_APPEARANCES) break;
      if (
        isSafeKey(botId) &&
        botId.length <= 128 &&
        !CONTROL_CHAR_RE.test(botId) &&
        isPoolCharacterId(charId)
      ) {
        map.set(botId, charId);
      }
    }
    base.botAppearances = toPlainSafeRecord(map);
  }
  return base;
}

export function prepareSnapshotForUi(snapshot: WorldSnapshot, redactMode: boolean): WorldSnapshot {
  const scrubbed = scrubFullSnapshot(snapshot);
  if (!redactMode) {
    const bots: WorldSnapshot['bots'] = {};
    for (const [id, bot] of Object.entries(scrubbed.bots)) {
      if (!isSafeKey(id)) continue;
      Object.defineProperty(bots, id, {
        value: {
          ...bot,
          specialty: truncateUiText(bot.specialty, 200),
          currentTaskTitle:
            bot.currentTaskTitle !== null ? truncateUiText(bot.currentTaskTitle, 200) : null,
          currentTool: bot.currentTool !== null ? truncateUiText(bot.currentTool, 80) : null,
        },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    const items: WorldSnapshot['items'] = {};
    for (const [id, it] of Object.entries(scrubbed.items)) {
      if (!isSafeKey(id)) continue;
      Object.defineProperty(items, id, {
        value: {
          ...it,
          title: truncateUiText(it.title, 200),
          questionPrompt:
            it.questionPrompt !== null ? truncateUiText(it.questionPrompt, 300) : null,
        },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    const automations: WorldSnapshot['automations'] = {};
    for (const [id, auto] of Object.entries(scrubbed.automations)) {
      if (!isSafeKey(id)) continue;
      Object.defineProperty(automations, id, {
        value: {
          ...auto,
          name: truncateUiText(auto.name, 120),
          lastError: auto.lastError !== null ? truncateUiText(auto.lastError, 240) : null,
        },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return {
      ...scrubbed,
      runtime: {
        ...scrubbed.runtime,
        errorMessage:
          scrubbed.runtime.errorMessage !== null
            ? truncateUiText(scrubbed.runtime.errorMessage, 240)
            : null,
      },
      bots,
      items,
      automations,
      inboxCursor: {
        ...scrubbed.inboxCursor,
        seenIds: [],
      },
      recentMessages: scrubbed.recentMessages.map((m) => ({
        ...m,
        subject: truncateUiText(m.subject, 200),
        body: truncateUiText(m.body, 240),
        payload: null,
      })),
    };
  }

  const bots: WorldSnapshot['bots'] = {};
  for (const [id, bot] of Object.entries(scrubbed.bots)) {
    if (!isSafeKey(id)) continue;
    const statusLabel = botStatusLabelKo(bot.status);
    let maskedStatus = bot.status;
    if (bot.status.kind === 'Working') {
      maskedStatus = { kind: 'Working', tool: null };
    } else if (bot.status.kind === 'NeedsOwner') {
      maskedStatus = {
        kind: 'NeedsOwner',
        count: bot.status.count,
        prompt: null,
        optionsCount: bot.status.optionsCount,
      };
    } else if (bot.status.kind === 'Blocked') {
      maskedStatus = { kind: 'Blocked', reason: null };
    } else if (bot.status.kind === 'Error') {
      maskedStatus = {
        kind: 'Error',
        message: bot.status.message !== null ? '오류 상세 가려짐' : null,
      };
    }

    Object.defineProperty(bots, id, {
      value: {
        ...bot,
        agent: '비공개',
        specialty: '',
        status: maskedStatus,
        currentTaskTitle: redactLabel(bot.name, statusLabel),
        currentTool: null,
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const workers: WorldSnapshot['workers'] = {};
  let workerIdx = 1;
  for (const [id, w] of Object.entries(scrubbed.workers)) {
    if (!isSafeKey(id)) continue;
    Object.defineProperty(workers, id, {
      value: {
        ...w,
        provider: `도우미 #${workerIdx++}`,
        model: null,
        toolName: null,
        taskTitle: null,
        worktreeId: null,
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const items: WorldSnapshot['items'] = {};
  for (const [id, it] of Object.entries(scrubbed.items)) {
    if (!isSafeKey(id)) continue;
    Object.defineProperty(items, id, {
      value: {
        ...it,
        title: `#${it.number}`,
        questionPrompt: null,
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const automations: WorldSnapshot['automations'] = {};
  const autoEntries = Object.entries(scrubbed.automations)
    .filter(([id]) => isSafeKey(id))
    .sort((a, b) => a[1].name.localeCompare(b[1].name, 'ko', { numeric: true }));
  let autoIdx = 1;
  for (const [id, auto] of autoEntries) {
    Object.defineProperty(automations, id, {
      value: {
        ...auto,
        name: `정기 자동화 #${autoIdx++}`,
        lastError: auto.lastError ? '오류 상세 가려짐' : null,
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return {
    ...scrubbed,
    runtime: {
      ...scrubbed.runtime,
      errorMessage: scrubbed.runtime.errorMessage !== null ? '오류 상세 가려짐' : null,
    },
    bots,
    workers,
    items,
    automations,
    inboxCursor: {
      ...scrubbed.inboxCursor,
      seenIds: [],
    },
    recentMessages: scrubbed.recentMessages.map((m) => {
      const fromActor = resolveHandle(m.fromHandle, m.runId, scrubbed, scrubbed);
      const toActor = resolveHandle(m.toHandle, m.runId, scrubbed, scrubbed);
      return {
        ...m,
        fromHandle: redactSafeHandle(fromActor),
        toHandle: redactSafeHandle(toActor),
        subject: '',
        body: '',
        threadId: null,
        payload: null,
      };
    }),
  };
}

export function formatStatusBarParams(
  snapshot: WorldSnapshot,
  redactMode: boolean
): {
  id: 'bot-world-status';
  text: string;
  icon: 'bot';
  tone: 'neutral' | 'accent' | 'warning';
  tooltip: string;
} {
  const bots = Object.values(snapshot.bots);
  const botCount = bots.length;
  const workingCount = bots.filter((b) => b.status.kind === 'Working').length;
  const needsOwnerCount = bots.filter((b) => b.status.kind === 'NeedsOwner').length;
  const activeWorkerCount = Object.values(snapshot.workers).filter((w) => isWorkerActive(w)).length;

  if (!snapshot.runtime.connected && botCount === 0) {
    return {
      id: 'bot-world-status',
      text: redactMode ? '봇 월드 · 가림 · 오프라인' : '봇 월드 (오프라인)',
      icon: 'bot',
      tone: 'warning',
      tooltip: redactMode
        ? '가림 모드 활성 · 오프라인'
        : 'Orca 런타임 연결 대기 중',
    };
  }

  if (redactMode) {
    const parts = ['봇 월드', '가림', `작업 ${workingCount}`];
    if (activeWorkerCount > 0) parts.push(`워커 +${activeWorkerCount}`);
    if (needsOwnerCount > 0) parts.push(`결정 ${needsOwnerCount}`);
    return {
      id: 'bot-world-status',
      text: parts.join(' · '),
      icon: 'bot',
      tone: needsOwnerCount > 0 ? 'warning' : workingCount > 0 ? 'accent' : 'neutral',
      tooltip: `가림 모드 활성 · 작업 ${workingCount} · 워커 ${activeWorkerCount} · 결정 대기 ${needsOwnerCount}`,
    };
  }

  if (needsOwnerCount > 0) {
    const parts = ['봇 월드', `결정 ${needsOwnerCount}`];
    if (workingCount > 0) parts.push(`작업 ${workingCount}`);
    if (activeWorkerCount > 0) parts.push(`워커 +${activeWorkerCount}`);
    return {
      id: 'bot-world-status',
      text: parts.join(' · '),
      icon: 'bot',
      tone: 'warning',
      tooltip: `결정 대기 ${needsOwnerCount} · 작업 중 ${workingCount} · 활성 워커 ${activeWorkerCount}`,
    };
  }

  if (workingCount > 0 || activeWorkerCount > 0) {
    const parts = ['봇 월드', `작업 ${workingCount}`];
    if (activeWorkerCount > 0) parts.push(`워커 +${activeWorkerCount}`);
    return {
      id: 'bot-world-status',
      text: parts.join(' · '),
      icon: 'bot',
      tone: 'accent',
      tooltip: `작업 중 ${workingCount} · 활성 워커 ${activeWorkerCount} · 전체 봇 ${botCount}`,
    };
  }

  return {
    id: 'bot-world-status',
    text: `봇 월드 · 대기 ${botCount}`,
    icon: 'bot',
    tone: 'neutral',
    tooltip: `전체 봇 ${botCount} · 모두 대기 중`,
  };
}

export class BotWorldWorkerController {
  private readonly orca: OrcaWorkerApi;
  private readonly cli: OrcaClient;
  private readonly session = new PollerSession();
  private timeline = new TimelineBuffer();
  private prefs: StoredPrefs = {
    activeTheme: 'startup_office',
    redactMode: false,
    botAppearances: {},
    hasThemeOverride: false,
    hasRedactOverride: false,
  };
  private pollIntervalSec = 5;
  private lastSettings: {
    defaultTheme: ThemeId;
    redactMode: boolean;
    pollIntervalSec: number;
  } = {
    defaultTheme: 'startup_office',
    redactMode: false,
    pollIntervalSec: 5,
  };
  private prevSnapshot: WorldSnapshot = createEmptySnapshot();
  private workerSeqCounter = 0;
  private readonly workerSeqMap = new Map<string, number>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private eventDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pollInFlight: Promise<void> | null = null;
  private settingsUpdateQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(orca: OrcaWorkerApi, cli?: OrcaClient) {
    this.orca = orca;
    this.cli = cli ?? new OrcaCli();
  }

  async init(options?: { disableAutoLoop?: boolean }): Promise<void> {
    const settings = await this.readSettings();
    this.lastSettings = settings;
    this.pollIntervalSec = settings.pollIntervalSec;
    this.session.setPollIntervalSec(this.pollIntervalSec);

    const storedPrefs = await this.orca.storage.get(STORAGE_PREFS_KEY);
    this.prefs = validatePrefs(storedPrefs, {
      theme: settings.defaultTheme,
      redact: settings.redactMode,
    });

    const storedTimeline = await this.orca.storage.get(STORAGE_TIMELINE_KEY);
    this.timeline = TimelineBuffer.hydrate(storedTimeline, Date.now());

    this.registerHandlers();
    await this.updateStatusBar();

    if (!options?.disableAutoLoop) {
      void this.executeScheduledPoll();
    }
  }

  private async readSettings(): Promise<{
    defaultTheme: ThemeId;
    redactMode: boolean;
    pollIntervalSec: number;
  }> {
    let defaultTheme: ThemeId = 'startup_office';
    let redactMode = false;
    let pollIntervalSec = 5;
    try {
      const all = await this.orca.settings.get();
      if (all && typeof all === 'object') {
        if (isValidThemeId(all.defaultTheme)) {
          defaultTheme = all.defaultTheme;
        }
        if (typeof all.redactMode === 'boolean') {
          redactMode = all.redactMode;
        }
        if (typeof all.pollIntervalSec === 'number' && Number.isFinite(all.pollIntervalSec)) {
          pollIntervalSec = Math.max(2, Math.min(60, Math.trunc(all.pollIntervalSec)));
        }
      }
    } catch {
      // Fallback to defaults if settings cannot be read
    }
    return { defaultTheme, redactMode, pollIntervalSec };
  }

  private assignWorkerSeq(dispatchId: string): number {
    const existing = this.workerSeqMap.get(dispatchId);
    if (existing !== undefined) return existing;
    this.workerSeqCounter += 1;
    if (this.workerSeqMap.size >= 512) {
      const oldest = this.workerSeqMap.keys().next().value;
      if (oldest !== undefined) this.workerSeqMap.delete(oldest);
    }
    this.workerSeqMap.set(dispatchId, this.workerSeqCounter);
    return this.workerSeqCounter;
  }

  buildStatePayload(sinceMs?: number): BotWorldStatePayload {
    const redact = this.prefs.redactMode;
    const safeSnapshot = prepareSnapshotForUi(this.session.snapshot, redact);
    const payload: BotWorldStatePayload = {
      snapshot: safeSnapshot,
      events: [],
      keyframes: [],
      activeTheme: this.prefs.activeTheme,
      redactMode: redact,
      botAppearances: { ...this.prefs.botAppearances },
      pollIntervalSec: this.pollIntervalSec,
    };

    const baseBytes = utf8ByteLength(payload);
    const timelineBudget = Math.max(0, MAX_IPC_PAYLOAD_BYTES - baseBytes - 1024);
    const { events, keyframes } = this.timeline.exportBounded(sinceMs, timelineBudget);

    const safeEvents = redact
      ? events.map((ev) => ({
          timestampMs: ev.timestampMs,
          summary: ev.redactedSummary,
          redactedSummary: ev.redactedSummary,
          event: redactWorldEvent(ev.event, (dispatchId) => {
            const seq = this.assignWorkerSeq(dispatchId);
            return `도우미 #${seq}`;
          }),
        }))
      : events;
    const safeKeyframes = keyframes.map((kf) => ({
      timestampMs: kf.timestampMs,
      snapshot: prepareSnapshotForUi(kf.snapshot, redact),
    }));

    payload.events = safeEvents;
    payload.keyframes = safeKeyframes;

    // Final exact budget guard across the entire serialized payload
    let totalBytes = utf8ByteLength(payload);
    while (totalBytes > MAX_IPC_PAYLOAD_BYTES && (payload.keyframes.length > 0 || payload.events.length > 0)) {
      if (payload.keyframes.length > 0) {
        payload.keyframes.splice(0, Math.max(1, Math.floor(payload.keyframes.length / 4)));
      } else if (payload.events.length > 0) {
        payload.events.splice(0, Math.max(1, Math.floor(payload.events.length / 4)));
      }
      totalBytes = utf8ByteLength(payload);
    }

    // If snapshot alone still exceeds MAX_IPC_PAYLOAD_BYTES, trim non-critical snapshot tails
    while (totalBytes > MAX_IPC_PAYLOAD_BYTES && payload.snapshot.recentMessages.length > 0) {
      payload.snapshot.recentMessages.splice(0, Math.max(1, Math.floor(payload.snapshot.recentMessages.length / 2)));
      totalBytes = utf8ByteLength(payload);
    }
    if (totalBytes > MAX_IPC_PAYLOAD_BYTES) {
      for (const [uid, it] of Object.entries(payload.snapshot.items)) {
        if (it.status === 'done' || it.status === 'canceled' || it.status === 'closed') {
          delete payload.snapshot.items[uid];
        }
      }
      totalBytes = utf8ByteLength(payload);
    }
    if (totalBytes > MAX_IPC_PAYLOAD_BYTES) {
      for (const [id, w] of Object.entries(payload.snapshot.workers)) {
        if (!isWorkerVisibleOnStage(w)) {
          delete payload.snapshot.workers[id];
        }
      }
      totalBytes = utf8ByteLength(payload);
    }
    if (totalBytes > MAX_IPC_PAYLOAD_BYTES) {
      payload.snapshot.chatIndex = {};
      payload.snapshot.runBotIndex = {};
    }

    return payload;
  }

  private async persistPrefs(): Promise<void> {
    await this.orca.storage.set(STORAGE_PREFS_KEY, this.prefs as unknown as JsonValue);
  }

  private async persistTimeline(): Promise<void> {
    const data = this.timeline.serialize();
    await this.orca.storage.set(STORAGE_TIMELINE_KEY, data as unknown as JsonValue);
  }

  private async updateStatusBar(): Promise<void> {
    if (!this.orca.host.has('statusBar.update')) return;
    try {
      const params = formatStatusBarParams(this.session.snapshot, this.prefs.redactMode);
      await this.orca.host.call('statusBar.update', params);
    } catch {
      // Ignore status bar refusal in headless/non-desktop tests
    }
  }

  private postStateUpdated(): void {
    try {
      const payload = this.buildStatePayload();
      this.orca.panels.post('botWorld.stateUpdated', payload);
    } catch {
      // Never throw from fire-and-forget post
    }
  }

  async runPollTick(forceFull = false): Promise<void> {
    if (this.disposed) return;
    if (this.pollInFlight) {
      let coalesced = false;
      while (this.pollInFlight) {
        if (!forceFull) {
          coalesced = true;
        }
        try {
          await this.pollInFlight;
        } catch {
          // Prior failure does not block queued poll
        }
        if (this.disposed) return;
      }
      if (coalesced) return;
    }
    if (this.disposed) return;

    const work = (async () => {
      const nowMs = Date.now();
      const hadPrevBots = Object.keys(this.prevSnapshot.bots).length > 0;
      const { snapshot } = await this.session.step(this.cli, { forceFull, nowMs });
      if (!snapshot || this.disposed) return;

      const suppressDiff = !hadPrevBots || !snapshot.initialSyncComplete;
      const newEvents = diffSnapshots(this.prevSnapshot, snapshot, suppressDiff);
      for (const ev of newEvents) {
        const seqHint = ev.kind === 'WorkerStart' ? this.assignWorkerSeq(ev.dispatchId) : 1;
        this.timeline.pushEvent(ev, nowMs, seqHint);
      }

      const keyframeRecorded = this.timeline.maybeRecordLiveKeyframe(
        snapshot,
        nowMs,
        newEvents.length > 0
      );
      this.prevSnapshot = structuredClone(snapshot);

      if (newEvents.length > 0 || keyframeRecorded) {
        await this.persistTimeline();
      }
      await this.updateStatusBar();
      this.postStateUpdated();
    })();

    this.pollInFlight = work;
    try {
      await work;
    } finally {
      if (this.pollInFlight === work) {
        this.pollInFlight = null;
      }
    }
  }

  private async executeScheduledPoll(): Promise<void> {
    try {
      await this.runPollTick(false);
    } catch {
      // Never let a single poll exception permanently halt the polling loop
    } finally {
      if (!this.disposed) {
        const retrySecs = this.session.snapshot.runtime.retryAfterSecs;
        const nextDelay = retrySecs !== null ? retrySecs * 1000 : 2_000;
        this.scheduleNextPoll(nextDelay);
      }
    }
  }

  private scheduleNextPoll(delayMs: number): void {
    if (this.disposed) return;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    const clamped = Math.max(500, Math.min(60_000, delayMs));
    this.pollTimer = setTimeout(() => {
      void this.executeScheduledPoll();
    }, clamped);
  }

  private registerHandlers(): void {
    this.disposables.push(
      this.orca.panels.handle('botWorld.getState', async (input) => {
        if (input !== undefined && input !== null) {
          if (typeof input !== 'object' || Array.isArray(input)) {
            throw makeHostError('invalid_params', 'input must be an object');
          }
          const clean = stripDangerousKeys(input as Record<string, unknown>);
          if (
            clean.sinceMs !== undefined &&
            (typeof clean.sinceMs !== 'number' || !Number.isFinite(clean.sinceMs) || clean.sinceMs < 0)
          ) {
            throw makeHostError('invalid_params', 'sinceMs must be a non-negative finite number');
          }
          return this.buildStatePayload(clean.sinceMs as number | undefined);
        }
        return this.buildStatePayload();
      }),

      this.orca.panels.handle('botWorld.refresh', async () => {
        await this.runPollTick(true);
        return this.buildStatePayload();
      }),

      this.orca.panels.handle('botWorld.setTheme', async (input) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw makeHostError('invalid_params', 'input must be an object');
        }
        const clean = stripDangerousKeys(input as Record<string, unknown>);
        if (!isValidThemeId(clean.themeId)) {
          throw makeHostError('invalid_params', 'Invalid themeId');
        }
        this.prefs.activeTheme = clean.themeId;
        this.prefs.hasThemeOverride = true;
        await this.persistPrefs();
        this.postStateUpdated();
        return { themeId: this.prefs.activeTheme };
      }),

      this.orca.panels.handle('botWorld.setRedactMode', async (input) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw makeHostError('invalid_params', 'input must be an object');
        }
        const clean = stripDangerousKeys(input as Record<string, unknown>);
        if (typeof clean.redactMode !== 'boolean') {
          throw makeHostError('invalid_params', 'redactMode must be a boolean');
        }
        this.prefs.redactMode = clean.redactMode;
        this.prefs.hasRedactOverride = true;
        await this.persistPrefs();
        await this.updateStatusBar();
        this.postStateUpdated();
        return { redactMode: this.prefs.redactMode };
      }),

      this.orca.panels.handle('botWorld.setBotAppearance', async (input) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw makeHostError('invalid_params', 'input must be an object');
        }
        const clean = stripDangerousKeys(input as Record<string, unknown>);
        const botId = clean.botId;
        const characterId = clean.characterId;
        if (
          typeof botId !== 'string' ||
          !isSafeKey(botId) ||
          botId.length > 128 ||
          CONTROL_CHAR_RE.test(botId)
        ) {
          throw makeHostError('invalid_params', 'Invalid botId');
        }
        if (!isPoolCharacterId(characterId)) {
          throw makeHostError('invalid_params', 'Invalid characterId');
        }
        if (
          !Object.hasOwn(this.prefs.botAppearances, botId) &&
          Object.keys(this.prefs.botAppearances).length >= MAX_BOT_APPEARANCES
        ) {
          throw makeHostError('invalid_params', 'Too many botAppearances entries');
        }
        Object.defineProperty(this.prefs.botAppearances, botId, {
          value: characterId,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        await this.persistPrefs();
        this.postStateUpdated();
        return { botAppearances: { ...this.prefs.botAppearances } };
      }),

      this.orca.events.on('agent.status.changed', () => {
        if (this.disposed) return;
        if (this.eventDebounceTimer) clearTimeout(this.eventDebounceTimer);
        this.eventDebounceTimer = setTimeout(() => {
          this.eventDebounceTimer = null;
          void this.runPollTick(false).catch(() => {});
        }, 250);
      }),

      this.orca.settings.onDidChange(() => {
        this.settingsUpdateQueue = this.settingsUpdateQueue.then(async () => {
          if (this.disposed) return;
          const next = await this.readSettings();
          const prev = this.lastSettings;
          this.lastSettings = next;
          this.pollIntervalSec = next.pollIntervalSec;
          this.session.setPollIntervalSec(this.pollIntervalSec);

          let prefsChanged = false;
          if (next.defaultTheme !== prev.defaultTheme || !this.prefs.hasThemeOverride) {
            this.prefs.activeTheme = next.defaultTheme;
            if (next.defaultTheme !== prev.defaultTheme) {
              this.prefs.hasThemeOverride = false;
            }
            prefsChanged = true;
          }
          if (next.redactMode !== prev.redactMode || !this.prefs.hasRedactOverride) {
            this.prefs.redactMode = next.redactMode;
            if (next.redactMode !== prev.redactMode) {
              this.prefs.hasRedactOverride = false;
            }
            prefsChanged = true;
          }
          if (prefsChanged) {
            await this.persistPrefs();
          }
          await this.updateStatusBar();
          this.postStateUpdated();
        }).catch(() => {});
        return this.settingsUpdateQueue;
      }),

      this.orca.commands.register('bot-world.open', async () => {
        await this.runPollTick(false);
        const botCount = Object.keys(this.session.snapshot.bots).length;
        return `봇 월드 활성 (${botCount}개 봇)`;
      }),

      this.orca.commands.register('bot-world.refresh', async () => {
        await this.runPollTick(true);
        const botCount = Object.keys(this.session.snapshot.bots).length;
        return `봇 월드 새로고침 완료 (${botCount}개 봇)`;
      })
    );
  }

  dispose(): void {
    this.disposed = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.eventDebounceTimer) {
      clearTimeout(this.eventDebounceTimer);
      this.eventDebounceTimer = null;
    }
    if (this.cli instanceof OrcaCli) {
      this.cli.stop();
    }
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
    this.orca.log('bot-world worker deactivated');
  }
}

let activeController: BotWorldWorkerController | null = null;

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  if (activeController) {
    activeController.dispose();
    activeController = null;
  }
  const controller = new BotWorldWorkerController(orca);
  activeController = controller;
  await controller.init();
  orca.log('bot-world worker activated');
}

export async function deactivate(): Promise<void> {
  if (activeController) {
    activeController.dispose();
    activeController = null;
  }
}
