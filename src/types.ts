export type ThemeId = 'startup_office' | 'corporate_office';

export type CharacterId =
  | 'ddochi'
  | 'security'
  | 'iac'
  | 'cloud_ops'
  | 'cost'
  | 'internal_tools'
  | 'personal_assist'
  | 'cve'
  | 'doc_review'
  | 'bot_world'
  | 'worker_helper';

export const VALID_THEME_IDS: readonly ThemeId[] = [
  'startup_office',
  'corporate_office',
] as const;

export const POOL_CHARACTER_IDS: readonly CharacterId[] = [
  'ddochi',
  'security',
  'iac',
  'cloud_ops',
  'cost',
  'internal_tools',
  'personal_assist',
  'cve',
  'doc_review',
  'bot_world',
] as const;

export const VALID_CHARACTER_IDS: readonly CharacterId[] = [
  ...POOL_CHARACTER_IDS,
  'worker_helper',
] as const;

export const THEME_CONFIG_PATHS: Readonly<Record<ThemeId, string>> = Object.freeze({
  startup_office: '../assets/themes/startup_office/theme.json',
  corporate_office: '../assets/themes/corporate_office/theme.json',
});

export const THEME_BG_PATHS: Readonly<Record<ThemeId, string>> = Object.freeze({
  startup_office: '../assets/themes/startup_office/bg.png',
  corporate_office: '../assets/themes/corporate_office/bg.png',
});

export const CHARACTER_SPRITE_PATHS: Readonly<Record<CharacterId, string>> = Object.freeze({
  ddochi: '../assets/characters/ddochi/idle.png',
  security: '../assets/characters/security/idle.png',
  iac: '../assets/characters/iac/idle.png',
  cloud_ops: '../assets/characters/cloud_ops/idle.png',
  cost: '../assets/characters/cost/idle.png',
  internal_tools: '../assets/characters/internal_tools/idle.png',
  personal_assist: '../assets/characters/personal_assist/idle.png',
  cve: '../assets/characters/cve/idle.png',
  doc_review: '../assets/characters/doc_review/idle.png',
  bot_world: '../assets/characters/bot_world/idle.png',
  worker_helper: '../assets/characters/worker_helper/idle.png',
});

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
export const MAX_STRIP_DEPTH = 16;
export const MAX_BOT_APPEARANCES = 256;

export function isSafeKey(key: string): boolean {
  return typeof key === 'string' && key.length > 0 && key.length <= 256 && !DANGEROUS_KEYS.has(key);
}

export function stripDangerousKeys<T>(value: T, depth = 0): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_STRIP_DEPTH) {
    return (Array.isArray(value) ? [] : Object.create(null)) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripDangerousKeys(item, depth + 1)) as unknown as T;
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!DANGEROUS_KEYS.has(k)) {
      out[k] = stripDangerousKeys(v, depth + 1);
    }
  }
  return out as T;
}

export function toPlainSafeRecord<V>(entries: Iterable<[string, V]>): Record<string, V> {
  const obj: Record<string, V> = {};
  for (const [k, v] of entries) {
    if (isSafeKey(k)) {
      Object.defineProperty(obj, k, {
        value: v,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return obj;
}

export function safeJsonParse<T = unknown>(raw: string, maxBytes = 2 * 1024 * 1024): T {
  if (typeof raw !== 'string') {
    throw new Error('JSON input must be a string');
  }
  if (raw.length > maxBytes) {
    throw new Error(`JSON input exceeds maximum size (${maxBytes} chars)`);
  }
  const parsed: unknown = JSON.parse(raw, (key, val: unknown) => {
    if (DANGEROUS_KEYS.has(key)) {
      return undefined;
    }
    return val;
  });
  return stripDangerousKeys(parsed) as T;
}

export function isValidThemeId(id: unknown): id is ThemeId {
  return typeof id === 'string' && (VALID_THEME_IDS as readonly string[]).includes(id);
}

export function isValidCharacterId(id: unknown): id is CharacterId {
  return typeof id === 'string' && (VALID_CHARACTER_IDS as readonly string[]).includes(id);
}

export function isPoolCharacterId(id: unknown): id is CharacterId {
  return typeof id === 'string' && (POOL_CHARACTER_IDS as readonly string[]).includes(id);
}

export const MAX_BOTWORLD_DOC_BYTES = 256 * 1024;

export type BotWorldDocumentData = {
  version: 1;
  themeId: ThemeId;
  redactMode: boolean;
  selectedBotId: string | null;
  botAppearances: Record<string, CharacterId>;
};

export const DEFAULT_BOTWORLD_DOCUMENT: BotWorldDocumentData = {
  version: 1,
  themeId: 'startup_office',
  redactMode: false,
  selectedBotId: null,
  botAppearances: {},
};

export function validateBotWorldDocument(
  rawText: string,
  fallback: BotWorldDocumentData = DEFAULT_BOTWORLD_DOCUMENT
): { data: BotWorldDocumentData; valid: boolean } {
  if (typeof rawText !== 'string' || rawText.trim().length === 0) {
    return {
      data: {
        ...fallback,
        botAppearances: { ...fallback.botAppearances },
      },
      valid: false,
    };
  }
  if (new TextEncoder().encode(rawText).byteLength > MAX_BOTWORLD_DOC_BYTES) {
    return {
      data: {
        ...fallback,
        botAppearances: { ...fallback.botAppearances },
      },
      valid: false,
    };
  }
  try {
    const parsed = safeJsonParse<unknown>(rawText, MAX_BOTWORLD_DOC_BYTES);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        data: { ...fallback, botAppearances: { ...fallback.botAppearances } },
        valid: false,
      };
    }
    const rec = parsed as Record<string, unknown>;
    const themeId: ThemeId = isValidThemeId(rec.themeId) ? rec.themeId : fallback.themeId;
    const redactMode = typeof rec.redactMode === 'boolean' ? rec.redactMode : fallback.redactMode;
    const selectedBotId =
      typeof rec.selectedBotId === 'string' &&
      isSafeKey(rec.selectedBotId) &&
      rec.selectedBotId.length <= 128 &&
      !/[\x00-\x1f\x7f]/.test(rec.selectedBotId)
        ? rec.selectedBotId
        : null;

    const appearancesMap = new Map<string, CharacterId>();
    if (rec.botAppearances && typeof rec.botAppearances === 'object' && !Array.isArray(rec.botAppearances)) {
      for (const [botId, charId] of Object.entries(rec.botAppearances as Record<string, unknown>)) {
        if (appearancesMap.size >= MAX_BOT_APPEARANCES) break;
        if (
          isSafeKey(botId) &&
          botId.length <= 128 &&
          !CONTROL_CHAR_RE.test(botId) &&
          isPoolCharacterId(charId)
        ) {
          appearancesMap.set(botId, charId);
        }
      }
    }

    return {
      data: {
        version: 1,
        themeId,
        redactMode,
        selectedBotId,
        botAppearances: toPlainSafeRecord(appearancesMap),
      },
      valid: true,
    };
  } catch {
    return {
      data: { ...fallback, botAppearances: { ...fallback.botAppearances } },
      valid: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Domain models (ported from bot-world/src/orca/models.rs)
// ---------------------------------------------------------------------------

export type RuntimeHealth = {
  connected: boolean;
  reachable: boolean;
  state: string;
  runtimeId: string | null;
  appVersion: string | null;
  retryAfterSecs: number | null;
  errorMessage: string | null;
};

export type BotActivityStatus =
  | { kind: 'Paused' }
  | { kind: 'NeedsOwner'; count: number; prompt: string | null; optionsCount: number }
  | { kind: 'Blocked'; reason: string | null }
  | { kind: 'WaitingAnswer' }
  | { kind: 'Working'; tool: string | null }
  | { kind: 'Error'; message: string | null }
  | { kind: 'Idle' };

export function botStatusLabelKo(status: BotActivityStatus): string {
  switch (status.kind) {
    case 'Paused':
      return '일시 정지';
    case 'NeedsOwner':
      return '결정 대기';
    case 'Blocked':
      return '승인·차단';
    case 'WaitingAnswer':
      return '응답 대기';
    case 'Working':
      return '작업 중';
    case 'Error':
      return '오류';
    case 'Idle':
      return '대기 중';
  }
}

export type BotState = {
  id: string;
  name: string;
  agent: string;
  paused: boolean;
  specialty: string;
  status: BotActivityStatus;
  currentTaskTitle: string | null;
  currentTool: string | null;
  lastActivityAt: number | null;
  homeChatId: string | null;
  needsYouCount: number;
  activeWorkerCount: number;
};

export type WorkerLiveness = 'Live' | 'Exited' | 'Unverifiable';

export type WorkerState = {
  dispatchId: string;
  taskId: string | null;
  runId: string | null;
  parentBotId: string | null;
  parentBotName: string | null;
  provider: string;
  model: string | null;
  workerState: string;
  dispatchStatus: string;
  terminalState: string | null;
  terminalHandle: string | null;
  worktreeId: string | null;
  liveness: WorkerLiveness;
  activity: string;
  toolName: string | null;
  taskTitle: string | null;
  updatedAt: number | null;
};

export function isWorkerActive(w: WorkerState): boolean {
  return (
    w.workerState === 'ready' &&
    w.dispatchStatus === 'dispatched' &&
    w.terminalState !== 'released'
  );
}

export function isWorkerVisibleOnStage(w: WorkerState): boolean {
  return (
    isWorkerActive(w) ||
    (w.workerState === 'ready' && w.terminalState === 'retained')
  );
}

export function isWorkerUnverifiableWarning(w: WorkerState): boolean {
  return isWorkerActive(w) && w.liveness === 'Unverifiable';
}

export type BotItemState = {
  uid: string;
  number: number;
  ownerBotId: string;
  ownerBotName: string;
  title: string;
  status: string;
  version: number;
  lastEventId: string | null;
  questionPrompt: string | null;
  optionsCount: number;
  updatedAt: number | null;
};

export type AutomationState = {
  id: string;
  name: string;
  botId: string | null;
  enabled: boolean;
  lastRunStatus: string | null;
  lastRunAt: number | null;
  lastError: string | null;
  lastRunId: string | null;
  lastRunNoReply: boolean;
};

export type InboxMessage = {
  id: string;
  sequence: number;
  msgType: string;
  fromHandle: string;
  toHandle: string;
  runId: string | null;
  subject: string;
  body: string;
  createdAt: string | null;
  threadId: string | null;
  payload: string | null;
};

export type InboxCursor = {
  lastSequence: number;
  seenIds: string[];
  needsBackfill: boolean;
};

export type WorldSnapshot = {
  capturedAt: number;
  runtime: RuntimeHealth;
  bots: Record<string, BotState>;
  botOrder: string[];
  chatIndex: Record<string, string>;
  runBotIndex: Record<string, string>;
  workers: Record<string, WorkerState>;
  items: Record<string, BotItemState>;
  automations: Record<string, AutomationState>;
  inboxCursor: InboxCursor;
  recentMessages: InboxMessage[];
  rebaselineNeeded: boolean;
  initialSyncComplete: boolean;
};

export function createEmptySnapshot(): WorldSnapshot {
  return {
    capturedAt: 0,
    runtime: {
      connected: false,
      reachable: false,
      state: 'connecting',
      runtimeId: null,
      appVersion: null,
      retryAfterSecs: null,
      errorMessage: null,
    },
    bots: {},
    botOrder: [],
    chatIndex: {},
    runBotIndex: {},
    workers: {},
    items: {},
    automations: {},
    inboxCursor: {
      lastSequence: 0,
      seenIds: [],
      needsBackfill: false,
    },
    recentMessages: [],
    rebaselineNeeded: false,
    initialSyncComplete: false,
  };
}

// ---------------------------------------------------------------------------
// Events & Timeline models
// ---------------------------------------------------------------------------

export type ActorRef =
  | { kind: 'Bot'; botId: string; botName: string }
  | { kind: 'Worker'; dispatchId: string; parentBotId: string | null; label: string }
  | { kind: 'BossDesk' }
  | { kind: 'AutomationBoard' }
  | { kind: 'OfficeDoor' }
  | { kind: 'Unknown'; raw: string };

export type WorldEvent =
  | { kind: 'Handoff'; messageId: string; from: ActorRef; to: ActorRef; subject: string }
  | { kind: 'Question'; messageId: string; from: ActorRef; to: ActorRef; subject: string }
  | { kind: 'StatusReport'; messageId: string; from: ActorRef; to: ActorRef; subject: string }
  | { kind: 'Reply'; messageId: string; from: ActorRef; to: ActorRef; subject: string }
  | {
      kind: 'WorkerStart';
      dispatchId: string;
      parentBotId: string | null;
      parentBotName: string | null;
      provider: string;
      taskTitle: string | null;
    }
  | {
      kind: 'WorkerDone';
      dispatchId: string;
      parentBotId: string | null;
      parentBotName: string | null;
      subject: string;
    }
  | {
      kind: 'WorkerFailed';
      dispatchId: string;
      parentBotId: string | null;
      parentBotName: string | null;
      subject: string;
    }
  | { kind: 'Escalation'; actor: ActorRef; targetBotId: string | null; reason: string }
  | { kind: 'ApprovalClosed'; actor: ActorRef; parentBotId: string | null }
  | {
      kind: 'ItemNeedsYou';
      itemUid: string;
      number: number;
      botId: string;
      botName: string;
      title: string;
      optionsCount: number;
    }
  | {
      kind: 'BossReplied';
      botId: string;
      botName: string;
      itemNumber: number | null;
      subject: string;
    }
  | { kind: 'ItemDone'; itemUid: string; number: number; botId: string; botName: string; title: string }
  | { kind: 'ItemCanceled'; itemUid: string; number: number; botId: string; botName: string; title: string }
  | { kind: 'BotWorking'; botId: string; botName: string; tool: string | null }
  | { kind: 'ToolChanged'; botId: string; botName: string; tool: string | null }
  | { kind: 'BotIdle'; botId: string; botName: string }
  | { kind: 'WaitingAnswer'; botId: string; botName: string }
  | { kind: 'BotFailed'; botId: string; botName: string; message: string | null }
  | {
      kind: 'AutomationRun';
      automationId: string;
      automationName: string;
      botId: string | null;
      botName: string | null;
      success: boolean;
      noReply: boolean;
      error: string | null;
    }
  | { kind: 'BotPaused'; botId: string; botName: string }
  | {
      kind: 'WorkerExited';
      dispatchId: string;
      parentBotId: string | null;
      parentBotName: string | null;
      provider: string;
    }
  | {
      kind: 'WorkerReleased';
      dispatchId: string;
      parentBotId: string | null;
      parentBotName: string | null;
      provider: string;
    }
  | { kind: 'BotJoined'; botId: string; botName: string; specialty: string };

export type WorldEventRecord = {
  timestampMs: number;
  summary: string;
  redactedSummary: string;
  event: WorldEvent;
};

export type Keyframe = {
  timestampMs: number;
  snapshot: WorldSnapshot;
};

export type BotWorldStatePayload = {
  snapshot: WorldSnapshot;
  events: WorldEventRecord[];
  keyframes: Keyframe[];
  activeTheme: ThemeId;
  redactMode: boolean;
  botAppearances: Record<string, CharacterId>;
  pollIntervalSec: number;
};
