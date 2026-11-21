import type { JsonValue, OrcaWorkerApi } from 'orca/worker';
import {
  effectiveLocale,
  localizeBotErrorMessage,
  normalizeLanguageSetting,
  tStrings,
} from '../shared/i18n.ts';
import {
  diffSnapshots,
  extractWorkerSeq,
  formatEventSummaries,
  redactWorldEvent,
  resolveHandle,
} from './events.ts';
import { OrcaCli, type OrcaClient } from './orca-cli.ts';
import { PollerSession } from './poller.ts';
import './protocol.ts';
import { redactLabel, scrubAll } from './redact.ts';
import { TimelineBuffer, scrubFullSnapshot } from './timeline.ts';
import {
  type ActorRef,
  type BotWorldStatePayload,
  type CharacterId,
  type LanguageSetting,
  MAX_BOT_APPEARANCES,
  type ThemeId,
  type UiLocale,
  type WorldEventRecord,
  type WorldSnapshot,
  botStatusLabel,
  createEmptySnapshot,
  isPoolCharacterId,
  isSafeKey,
  isValidLanguageSetting,
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
const LOCALE_TAG_RE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8}){0,6}$/;
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

function redactSafeHandle(actor: ActorRef, locale: UiLocale = 'en'): string {
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
      return tStrings(locale).privateLabel;
  }
}

type StoredPrefs = {
  activeTheme: ThemeId;
  redactMode: boolean;
  botAppearances: Record<string, CharacterId>;
  languageSetting: LanguageSetting;
  hasThemeOverride: boolean;
  hasRedactOverride: boolean;
  hasLanguageOverride: boolean;
};

function makeHostError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function validatePrefs(
  raw: unknown,
  defaults: { theme: ThemeId; redact: boolean; language: LanguageSetting }
): StoredPrefs {
  const base: StoredPrefs = {
    activeTheme: defaults.theme,
    redactMode: defaults.redact,
    botAppearances: {},
    languageSetting: defaults.language,
    hasThemeOverride: false,
    hasRedactOverride: false,
    hasLanguageOverride: false,
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
  if (isValidLanguageSetting(clean.languageSetting)) {
    base.languageSetting = clean.languageSetting;
    base.hasLanguageOverride = clean.hasLanguageOverride === true;
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

export function prepareSnapshotForUi(
  snapshot: WorldSnapshot,
  redactMode: boolean,
  locale: UiLocale = 'en'
): WorldSnapshot {
  const s = tStrings(locale);
  const scrubbed = scrubFullSnapshot(snapshot);
  if (!redactMode) {
    const bots: WorldSnapshot['bots'] = {};
    for (const [id, bot] of Object.entries(scrubbed.bots)) {
      if (!isSafeKey(id)) continue;
      const localizedStatus =
        bot.status.kind === 'Error' && bot.status.message !== null
          ? {
              kind: 'Error' as const,
              message: localizeBotErrorMessage(bot.status.message, locale),
            }
          : bot.status;
      Object.defineProperty(bots, id, {
        value: {
          ...bot,
          status: localizedStatus,
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
    const statusLabel = botStatusLabel(bot.status, locale);
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
        message: bot.status.message !== null ? s.errorHiddenLabel : null,
      };
    }

    Object.defineProperty(bots, id, {
      value: {
        ...bot,
        agent: s.privateLabel,
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
        provider: s.workerNumbered(workerIdx++),
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
    .sort((a, b) => a[1].name.localeCompare(b[1].name, locale, { numeric: true }));
  let autoIdx = 1;
  for (const [id, auto] of autoEntries) {
    Object.defineProperty(automations, id, {
      value: {
        ...auto,
        name: s.automationNumbered(autoIdx++),
        lastError: auto.lastError ? s.errorHiddenLabel : null,
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
      errorMessage: scrubbed.runtime.errorMessage !== null ? s.errorHiddenLabel : null,
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
      const fromActor = resolveHandle(m.fromHandle, m.runId, scrubbed, scrubbed, locale);
      const toActor = resolveHandle(m.toHandle, m.runId, scrubbed, scrubbed, locale);
      return {
        ...m,
        fromHandle: redactSafeHandle(fromActor, locale),
        toHandle: redactSafeHandle(toActor, locale),
        subject: '',
        body: '',
        threadId: null,
        payload: null,
      };
    }),
  };
}

export function buildStatusBarText(
  snapshot: WorldSnapshot,
  redactMode: boolean,
  locale: UiLocale = 'en'
): string {
  const s = tStrings(locale);
  const bots = Object.values(snapshot.bots);
  const botCount = bots.length;
  const workingCount = bots.filter((b) => b.status.kind === 'Working').length;
  const needsOwnerCount = bots.filter((b) => b.status.kind === 'NeedsOwner').length;
  const activeWorkerCount = Object.values(snapshot.workers).filter((w) => isWorkerActive(w)).length;

  if (!snapshot.runtime.connected && botCount === 0) {
    return redactMode ? s.statusBarOfflineRedacted : s.statusBarOffline;
  }

  if (locale === 'ko') {
    if (redactMode) {
      const parts = [s.statusBarBrand, s.statusBarRedactedTag, `작업 ${workingCount}`];
      if (activeWorkerCount > 0) parts.push(`워커 +${activeWorkerCount}`);
      if (needsOwnerCount > 0) parts.push(`결정 ${needsOwnerCount}`);
      return parts.join(' · ');
    }
    if (needsOwnerCount > 0) {
      const parts = [s.statusBarBrand, `결정 ${needsOwnerCount}`];
      if (workingCount > 0) parts.push(`작업 ${workingCount}`);
      if (activeWorkerCount > 0) parts.push(`워커 +${activeWorkerCount}`);
      return parts.join(' · ');
    }
    if (workingCount > 0 || activeWorkerCount > 0) {
      const parts = [s.statusBarBrand, `작업 ${workingCount}`];
      if (activeWorkerCount > 0) parts.push(`워커 +${activeWorkerCount}`);
      return parts.join(' · ');
    }
    return `${s.statusBarBrand} · 대기 ${botCount}`;
  }

  if (redactMode) {
    return `${s.statusBarBrand} · ${s.statusBarRedactedTag} · ${workingCount}/${botCount} active`;
  }
  if (needsOwnerCount > 0) {
    const parts = [s.statusBarBrand, `${needsOwnerCount} needs you`];
    if (workingCount > 0) parts.push(`${workingCount} working`);
    if (activeWorkerCount > 0) parts.push(`+${activeWorkerCount} workers`);
    return parts.join(' · ');
  }
  if (workingCount > 0 || activeWorkerCount > 0) {
    const parts = [s.statusBarBrand, `${workingCount} working`];
    if (activeWorkerCount > 0) parts.push(`+${activeWorkerCount} workers`);
    return parts.join(' · ');
  }
  return `${s.statusBarBrand} · ${botCount} idle`;
}

export function formatStatusBarParams(
  snapshot: WorldSnapshot,
  redactMode: boolean,
  locale: UiLocale = 'en'
): {
  id: 'bot-world-status';
  text: string;
  icon: 'bot';
  tone: 'neutral' | 'accent' | 'warning';
  tooltip: string;
} {
  const s = tStrings(locale);
  const bots = Object.values(snapshot.bots);
  const botCount = bots.length;
  const workingCount = bots.filter((b) => b.status.kind === 'Working').length;
  const needsOwnerCount = bots.filter((b) => b.status.kind === 'NeedsOwner').length;
  const activeWorkerCount = Object.values(snapshot.workers).filter((w) => isWorkerActive(w)).length;
  const text = buildStatusBarText(snapshot, redactMode, locale);

  if (!snapshot.runtime.connected && botCount === 0) {
    return {
      id: 'bot-world-status',
      text,
      icon: 'bot',
      tone: 'warning',
      tooltip: redactMode ? s.statusBarOfflineTooltipRedacted : s.statusBarOfflineTooltip,
    };
  }

  const tone: 'neutral' | 'accent' | 'warning' =
    needsOwnerCount > 0
      ? 'warning'
      : workingCount > 0 || activeWorkerCount > 0
        ? 'accent'
        : 'neutral';

  if (locale === 'ko') {
    const tooltip = redactMode
      ? `가림 모드 활성 · 작업 ${workingCount} · 워커 ${activeWorkerCount} · 결정 대기 ${needsOwnerCount}`
      : needsOwnerCount > 0
        ? `결정 대기 ${needsOwnerCount} · 작업 중 ${workingCount} · 활성 워커 ${activeWorkerCount}`
        : workingCount > 0 || activeWorkerCount > 0
          ? `작업 중 ${workingCount} · 활성 워커 ${activeWorkerCount} · 전체 봇 ${botCount}`
          : `전체 봇 ${botCount} · 모두 대기 중`;
    return { id: 'bot-world-status', text, icon: 'bot', tone, tooltip };
  }

  const tooltip = redactMode
    ? `Redact mode active · ${workingCount} working · ${activeWorkerCount} workers · ${needsOwnerCount} needs you`
    : needsOwnerCount > 0
      ? `${needsOwnerCount} needs you · ${workingCount} working · ${activeWorkerCount} active workers`
      : workingCount > 0 || activeWorkerCount > 0
        ? `${workingCount} working · ${activeWorkerCount} active workers · ${botCount} total bots`
        : `${botCount} total bots · All idle`;
  return { id: 'bot-world-status', text, icon: 'bot', tone, tooltip };
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
    languageSetting: 'auto',
    hasThemeOverride: false,
    hasRedactOverride: false,
    hasLanguageOverride: false,
  };
  private pollIntervalSec = 5;
  private hostLocale = 'en';
  private lastSettings: {
    defaultTheme: ThemeId;
    redactMode: boolean;
    pollIntervalSec: number;
    language: LanguageSetting;
  } = {
    defaultTheme: 'startup_office',
    redactMode: false,
    pollIntervalSec: 5,
    language: 'auto',
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
    try {
      this.hostLocale = Intl.DateTimeFormat().resolvedOptions().locale || 'en';
    } catch {
      this.hostLocale = 'en';
    }
  }

  currentLocale(): UiLocale {
    return effectiveLocale(this.prefs.languageSetting, this.hostLocale);
  }

  private setHostLocale(rawLocale: unknown): boolean {
    if (rawLocale === undefined || rawLocale === null) return false;
    if (
      typeof rawLocale !== 'string' ||
      rawLocale.length > 64 ||
      CONTROL_CHAR_RE.test(rawLocale)
    ) {
      throw makeHostError('invalid_params', 'Invalid locale');
    }
    const trimmed = rawLocale.trim();
    if (trimmed.length === 0 || trimmed !== rawLocale || !LOCALE_TAG_RE.test(trimmed)) {
      throw makeHostError('invalid_params', 'Invalid locale');
    }
    const prevEffective = this.currentLocale();
    this.hostLocale = trimmed;
    return this.currentLocale() !== prevEffective;
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
      language: settings.language,
    });

    const storedTimeline = await this.orca.storage.get(STORAGE_TIMELINE_KEY);
    this.timeline = TimelineBuffer.hydrate(storedTimeline, Date.now());
    for (const rec of this.timeline.eventLog) {
      if (rec.event.kind === 'WorkerStart') {
        const seq = extractWorkerSeq(rec);
        if (seq !== undefined) {
          if (!this.workerSeqMap.has(rec.event.dispatchId)) {
            if (this.workerSeqMap.size >= 512) {
              const oldest = this.workerSeqMap.keys().next().value;
              if (oldest !== undefined) this.workerSeqMap.delete(oldest);
            }
            this.workerSeqMap.set(rec.event.dispatchId, seq);
          }
          if (seq > this.workerSeqCounter) {
            this.workerSeqCounter = seq;
          }
        }
      }
    }

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
    language: LanguageSetting;
  }> {
    let defaultTheme: ThemeId = 'startup_office';
    let redactMode = false;
    let pollIntervalSec = 5;
    let language: LanguageSetting = 'auto';
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
        language = normalizeLanguageSetting(all.language);
      }
    } catch {
      // Fallback to defaults if settings cannot be read
    }
    return { defaultTheme, redactMode, pollIntervalSec, language };
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
    const locale = this.currentLocale();
    const s = tStrings(locale);
    const safeSnapshot = prepareSnapshotForUi(this.session.snapshot, redact, locale);
    const payload: BotWorldStatePayload = {
      snapshot: safeSnapshot,
      events: [],
      keyframes: [],
      activeTheme: this.prefs.activeTheme,
      redactMode: redact,
      botAppearances: { ...this.prefs.botAppearances },
      pollIntervalSec: this.pollIntervalSec,
      locale,
      languageSetting: this.prefs.languageSetting,
    };

    const baseBytes = utf8ByteLength(payload);
    const timelineBudget = Math.max(0, MAX_IPC_PAYLOAD_BYTES - baseBytes - 1024);
    const { events, keyframes } = this.timeline.exportBounded(sinceMs, timelineBudget);

    const safeEvents = events.map((ev): WorldEventRecord => {
      const seqHint =
        ev.event.kind === 'WorkerStart'
          ? (extractWorkerSeq(ev) ?? this.assignWorkerSeq(ev.event.dispatchId))
          : 1;
      const [summary, redactedSummary] = formatEventSummaries(ev.event, seqHint, locale);
      const out: WorldEventRecord = redact
        ? {
            timestampMs: ev.timestampMs,
            summary: redactedSummary,
            redactedSummary,
            event: redactWorldEvent(
              ev.event,
              (dispatchId) =>
                s.workerNumbered(
                  ev.event.kind === 'WorkerStart' && dispatchId === ev.event.dispatchId
                    ? seqHint
                    : this.assignWorkerSeq(dispatchId)
                ),
              locale
            ),
          }
        : {
            timestampMs: ev.timestampMs,
            summary,
            redactedSummary,
            event: ev.event,
          };
      if (ev.event.kind === 'WorkerStart') {
        out.workerSeq = seqHint;
      }
      return out;
    });
    const safeKeyframes = keyframes.map((kf) => ({
      timestampMs: kf.timestampMs,
      snapshot: prepareSnapshotForUi(kf.snapshot, redact, locale),
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
      const params = formatStatusBarParams(
        this.session.snapshot,
        this.prefs.redactMode,
        this.currentLocale()
      );
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
      const locale = this.currentLocale();
      const newEvents = diffSnapshots(this.prevSnapshot, snapshot, suppressDiff, locale);
      for (const ev of newEvents) {
        const seqHint = ev.kind === 'WorkerStart' ? this.assignWorkerSeq(ev.dispatchId) : 1;
        this.timeline.pushEvent(ev, nowMs, seqHint, locale);
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
          if (this.setHostLocale(clean.locale)) {
            await this.updateStatusBar();
          }
          return this.buildStatePayload(clean.sinceMs as number | undefined);
        }
        return this.buildStatePayload();
      }),

      this.orca.panels.handle('botWorld.refresh', async (input) => {
        if (input !== undefined && input !== null) {
          if (typeof input !== 'object' || Array.isArray(input)) {
            throw makeHostError('invalid_params', 'input must be an object');
          }
          const clean = stripDangerousKeys(input as Record<string, unknown>);
          this.setHostLocale(clean.locale);
        }
        await this.runPollTick(true);
        return this.buildStatePayload();
      }),

      this.orca.panels.handle('botWorld.setLanguage', async (input) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw makeHostError('invalid_params', 'input must be an object');
        }
        const clean = stripDangerousKeys(input as Record<string, unknown>);
        if (!isValidLanguageSetting(clean.language)) {
          throw makeHostError('invalid_params', 'Invalid language');
        }
        if (clean.hostLocale !== undefined) {
          this.setHostLocale(clean.hostLocale);
        }
        this.prefs.languageSetting = clean.language;
        this.prefs.hasLanguageOverride = true;
        await this.persistPrefs();
        await this.updateStatusBar();
        this.postStateUpdated();
        return {
          languageSetting: this.prefs.languageSetting,
          locale: this.currentLocale(),
        };
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
          if (next.language !== prev.language || !this.prefs.hasLanguageOverride) {
            this.prefs.languageSetting = next.language;
            if (next.language !== prev.language) {
              this.prefs.hasLanguageOverride = false;
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
        return tStrings(this.currentLocale()).cmdOpenResult(botCount);
      }),

      this.orca.commands.register('bot-world.refresh', async () => {
        await this.runPollTick(true);
        const botCount = Object.keys(this.session.snapshot.bots).length;
        return tStrings(this.currentLocale()).cmdRefreshResult(botCount);
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
