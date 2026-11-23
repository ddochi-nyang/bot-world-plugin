import {
  type BotRpgProfile,
  type BotRpgStore,
  type DeskPropId,
  MAX_RPG_PROFILES,
  type RpgXpAction,
  type StoredBotRpgRecord,
  type UiLocale,
  type WorldEvent,
  type WorldSnapshot,
  isSafeKey,
  isValidDeskPropId,
} from '../src/types.ts';
import { tStrings } from './i18n.ts';

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const MAX_XP_VALUE = 10_000_000;
const MAX_COUNTER_VALUE = 1_000_000;
export const MAX_SEEN_RPG_EVENT_IDS = 1_000;
export const RPG_ACTION_COOLDOWN_MS = 3_000;

export const RPG_ACTION_XP: Readonly<Record<RpgXpAction, number>> = Object.freeze({
  headpat: 5,
  toy: 5,
  high_five: 8,
  coffee: 10,
});

export type DeskPropSpec = {
  id: Exclude<DeskPropId, 'none'>;
  unlockLevel: number;
  emoji: string;
};

export const DESK_PROP_CATALOG: readonly DeskPropSpec[] = Object.freeze([
  { id: 'rubber_duck', unlockLevel: 1, emoji: '🦆' },
  { id: 'mini_plant', unlockLevel: 2, emoji: '🪴' },
  { id: 'mech_keyboard', unlockLevel: 3, emoji: '⌨️' },
  { id: 'dual_monitor', unlockLevel: 4, emoji: '🖥️' },
  { id: 'cat_plush', unlockLevel: 5, emoji: '🐱' },
  { id: 'gold_trophy', unlockLevel: 6, emoji: '🏆' },
]);

const BASE_LEVEL_THRESHOLDS = [0, 40, 100, 190, 320, 500] as const;

function clampInt(val: unknown, max: number): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return 0;
  return Math.max(0, Math.min(max, Math.trunc(val)));
}

export function levelForXp(rawXp: number): number {
  const xp = clampInt(rawXp, MAX_XP_VALUE);
  if (xp < BASE_LEVEL_THRESHOLDS[1]) return 1;
  if (xp < BASE_LEVEL_THRESHOLDS[2]) return 2;
  if (xp < BASE_LEVEL_THRESHOLDS[3]) return 3;
  if (xp < BASE_LEVEL_THRESHOLDS[4]) return 4;
  if (xp < BASE_LEVEL_THRESHOLDS[5]) return 5;
  return 6 + Math.floor((xp - BASE_LEVEL_THRESHOLDS[5]) / 250);
}

export function xpFloorForLevel(level: number): number {
  const lv = Math.max(1, Math.trunc(Number.isFinite(level) ? level : 1));
  if (lv <= 6) {
    return BASE_LEVEL_THRESHOLDS[lv - 1];
  }
  return BASE_LEVEL_THRESHOLDS[5] + (lv - 6) * 250;
}

export function nextLevelXpThreshold(level: number): number {
  return xpFloorForLevel(Math.max(1, Math.trunc(level)) + 1);
}

export function rpgTitleForLevel(level: number, locale: UiLocale = 'en'): string {
  const titles = tStrings(locale).rpgLevelTitles;
  const idx = Math.max(0, Math.min(titles.length - 1, Math.trunc(level) - 1));
  return titles[idx];
}

export function propEmoji(propId: DeskPropId): string {
  if (propId === 'none') return '—';
  const found = DESK_PROP_CATALOG.find((p) => p.id === propId);
  return found ? found.emoji : '—';
}

export function unlockedPropsForLevel(level: number): DeskPropId[] {
  const lv = Math.max(1, Math.trunc(Number.isFinite(level) ? level : 1));
  return DESK_PROP_CATALOG.filter((p) => p.unlockLevel <= lv).map((p) => p.id);
}

export function resolveEquippedProp(
  storedProp: DeskPropId | undefined,
  level: number,
  xp: number
): DeskPropId {
  if (storedProp === 'none') {
    return 'none';
  }
  const unlocked = unlockedPropsForLevel(level);
  if (storedProp && isValidDeskPropId(storedProp) && unlocked.includes(storedProp)) {
    return storedProp;
  }
  // Auto-showcase highest unlocked prop once bot hits Lv.2+ (xp >= 40) if not manually pinned
  if (xp >= 40 && unlocked.length > 0) {
    return unlocked[unlocked.length - 1];
  }
  return 'none';
}

export function createEmptyStoredRecord(): StoredBotRpgRecord {
  return {
    xp: 0,
    completions: 0,
    delegations: 0,
    headpats: 0,
    highFives: 0,
    coffees: 0,
  };
}

export function createEmptyBotRpgStore(nowMs = 0): BotRpgStore {
  return {
    version: 1,
    updatedAtMs: typeof nowMs === 'number' && Number.isFinite(nowMs) && nowMs >= 0 ? Math.trunc(nowMs) : 0,
    profiles: {},
  };
}

export function computeBotRpgProfile(
  botId: string,
  record?: Partial<StoredBotRpgRecord>
): BotRpgProfile {
  const xp = clampInt(record?.xp ?? 0, MAX_XP_VALUE);
  const level = levelForXp(xp);
  const unlockedProps = unlockedPropsForLevel(level);
  const storedProp =
    record?.equippedProp && isValidDeskPropId(record.equippedProp)
      ? record.equippedProp
      : undefined;
  return {
    botId,
    xp,
    level,
    completions: clampInt(record?.completions ?? 0, MAX_COUNTER_VALUE),
    delegations: clampInt(record?.delegations ?? 0, MAX_COUNTER_VALUE),
    headpats: clampInt(record?.headpats ?? 0, MAX_COUNTER_VALUE),
    highFives: clampInt(record?.highFives ?? 0, MAX_COUNTER_VALUE),
    coffees: clampInt(record?.coffees ?? 0, MAX_COUNTER_VALUE),
    equippedProp: resolveEquippedProp(storedProp, level, xp),
    unlockedProps,
  };
}

export function sanitizeBotRpgStore(raw: unknown, nowMs = 0): BotRpgStore {
  const base = createEmptyBotRpgStore(nowMs);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return base;
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec.updatedAtMs === 'number' && Number.isFinite(rec.updatedAtMs) && rec.updatedAtMs >= 0) {
    base.updatedAtMs = Math.trunc(rec.updatedAtMs);
  }
  const rawProfiles = rec.profiles;
  if (!rawProfiles || typeof rawProfiles !== 'object' || Array.isArray(rawProfiles)) {
    return base;
  }
  const validEntries: Array<[string, StoredBotRpgRecord]> = [];
  for (const [botId, entry] of Object.entries(rawProfiles as Record<string, unknown>)) {
    if (
      !isSafeKey(botId) ||
      botId.length > 128 ||
      CONTROL_CHAR_RE.test(botId) ||
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry)
    ) {
      continue;
    }
    const r = entry as Record<string, unknown>;
    const cleanRec: StoredBotRpgRecord = {
      xp: clampInt(r.xp, MAX_XP_VALUE),
      completions: clampInt(r.completions, MAX_COUNTER_VALUE),
      delegations: clampInt(r.delegations, MAX_COUNTER_VALUE),
      headpats: clampInt(r.headpats, MAX_COUNTER_VALUE),
      highFives: clampInt(r.highFives, MAX_COUNTER_VALUE),
      coffees: clampInt(r.coffees, MAX_COUNTER_VALUE),
    };
    if (isValidDeskPropId(r.equippedProp)) {
      cleanRec.equippedProp = r.equippedProp;
    }
    validEntries.push([botId, cleanRec]);
  }

  // Cap at MAX_RPG_PROFILES (keep highest XP profiles first)
  if (validEntries.length > MAX_RPG_PROFILES) {
    validEntries.sort((a, b) => b[1].xp - a[1].xp || a[0].localeCompare(b[0]));
    validEntries.length = MAX_RPG_PROFILES;
  }

  for (const [botId, cleanRec] of validEntries) {
    Object.defineProperty(base.profiles, botId, {
      value: cleanRec,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return base;
}

function getOrCreateRecord(store: BotRpgStore, botId: string): StoredBotRpgRecord | null {
  if (!isSafeKey(botId) || botId.length > 128 || CONTROL_CHAR_RE.test(botId)) {
    return null;
  }
  if (Object.hasOwn(store.profiles, botId)) {
    return store.profiles[botId];
  }
  if (Object.keys(store.profiles).length >= MAX_RPG_PROFILES) {
    // Evict lowest-XP profile to keep store bounded at MAX_RPG_PROFILES
    let lowestId: string | null = null;
    let lowestXp = Infinity;
    for (const [k, v] of Object.entries(store.profiles)) {
      if (v.xp < lowestXp) {
        lowestXp = v.xp;
        lowestId = k;
      }
    }
    if (lowestId) {
      delete store.profiles[lowestId];
    } else {
      return null;
    }
  }
  const created = createEmptyStoredRecord();
  Object.defineProperty(store.profiles, botId, {
    value: created,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return created;
}

export function buildRpgProfilesForSnapshot(
  store: BotRpgStore,
  snapshot: WorldSnapshot
): Record<string, BotRpgProfile> {
  const out: Record<string, BotRpgProfile> = {};
  const ids =
    snapshot.botOrder.length > 0
      ? snapshot.botOrder.filter((id) => isSafeKey(id) && Object.hasOwn(snapshot.bots, id))
      : Object.keys(snapshot.bots).filter((id) => isSafeKey(id));
  for (const botId of ids) {
    const rec = Object.hasOwn(store.profiles, botId) ? store.profiles[botId] : undefined;
    Object.defineProperty(out, botId, {
      value: computeBotRpgProfile(botId, rec),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

export function applyRpgActionToStore(
  store: BotRpgStore,
  botId: string,
  action: RpgXpAction,
  nowMs: number,
  cooldowns?: Map<string, number>,
  cooldownMs: number = RPG_ACTION_COOLDOWN_MS
): {
  ok: boolean;
  reason?: 'cooldown';
  xpAwarded: number;
  leveledUp: boolean;
  cooldownRemainingMs?: number;
  profile: BotRpgProfile;
} {
  const rec = getOrCreateRecord(store, botId);
  if (!rec) {
    return {
      ok: false,
      xpAwarded: 0,
      leveledUp: false,
      profile: computeBotRpgProfile(botId),
    };
  }
  const cdKey = `${botId}:${action}`;
  if (cooldowns) {
    const prevMs = cooldowns.get(cdKey);
    if (prevMs !== undefined && nowMs - prevMs < cooldownMs) {
      return {
        ok: false,
        reason: 'cooldown',
        xpAwarded: 0,
        leveledUp: false,
        cooldownRemainingMs: Math.max(0, cooldownMs - (nowMs - prevMs)),
        profile: computeBotRpgProfile(botId, rec),
      };
    }
    if (cooldowns.size >= 512) {
      const oldest = cooldowns.keys().next().value;
      if (oldest !== undefined) cooldowns.delete(oldest);
    }
    cooldowns.set(cdKey, nowMs);
  }

  const prevLevel = levelForXp(rec.xp);
  const delta = RPG_ACTION_XP[action];
  rec.xp = clampInt(rec.xp + delta, MAX_XP_VALUE);
  if (action === 'headpat' || action === 'toy') {
    rec.headpats = clampInt(rec.headpats + 1, MAX_COUNTER_VALUE);
  } else if (action === 'high_five') {
    rec.highFives = clampInt(rec.highFives + 1, MAX_COUNTER_VALUE);
  } else if (action === 'coffee') {
    rec.coffees = clampInt(rec.coffees + 1, MAX_COUNTER_VALUE);
  }
  store.updatedAtMs = Math.trunc(nowMs);
  const profile = computeBotRpgProfile(botId, rec);
  return {
    ok: true,
    xpAwarded: delta,
    leveledUp: profile.level > prevLevel,
    profile,
  };
}

export function equipDeskPropInStore(
  store: BotRpgStore,
  botId: string,
  propId: DeskPropId,
  nowMs: number
): {
  ok: boolean;
  reason?: 'prop_locked';
  profile: BotRpgProfile;
} {
  const rec = getOrCreateRecord(store, botId);
  if (!rec) {
    return {
      ok: false,
      reason: 'prop_locked',
      profile: computeBotRpgProfile(botId),
    };
  }
  const currentLevel = levelForXp(rec.xp);
  const unlocked = unlockedPropsForLevel(currentLevel);
  if (propId !== 'none' && !unlocked.includes(propId)) {
    return {
      ok: false,
      reason: 'prop_locked',
      profile: computeBotRpgProfile(botId, rec),
    };
  }
  rec.equippedProp = propId;
  store.updatedAtMs = Math.trunc(nowMs);
  return {
    ok: true,
    profile: computeBotRpgProfile(botId, rec),
  };
}

function trackBoundedEventId(seen: Set<string>, id: string): boolean {
  if (seen.has(id)) return false;
  if (seen.size >= MAX_SEEN_RPG_EVENT_IDS) {
    const oldest = seen.keys().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  seen.add(id);
  return true;
}

export function applyWorldEventsToRpgStore(
  store: BotRpgStore,
  events: readonly WorldEvent[],
  seenEventIds: Set<string>,
  nowMs: number
): { changed: boolean; awardedBotIds: string[] } {
  let changed = false;
  const awarded = new Set<string>();

  for (let idx = 0; idx < events.length; idx++) {
    const ev = events[idx];
    if (!ev || typeof ev !== 'object') continue;

    let botId: string | null = null;
    let xpDelta = 0;
    let completionInc = 0;
    let delegationInc = 0;
    let dedupeKey = '';

    switch (ev.kind) {
      case 'ItemDone':
        botId = ev.botId;
        xpDelta = 25;
        completionInc = 1;
        dedupeKey = `itemDone:${ev.itemUid}`;
        break;
      case 'WorkerDone':
        botId = ev.parentBotId;
        xpDelta = 25;
        completionInc = 1;
        dedupeKey = `workerDone:${ev.dispatchId}`;
        break;
      case 'AutomationRun':
        if (ev.success && ev.botId) {
          botId = ev.botId;
          xpDelta = 25;
          completionInc = 1;
          dedupeKey = `auto:${ev.automationId}:${Math.trunc(nowMs)}:${idx}`;
        }
        break;
      case 'WorkerStart':
        botId = ev.parentBotId;
        xpDelta = 10;
        delegationInc = 1;
        dedupeKey = `workerStart:${ev.dispatchId}`;
        break;
      case 'Handoff':
      case 'Question':
      case 'StatusReport':
      case 'Reply':
        if (ev.from.kind === 'Bot') {
          botId = ev.from.botId;
          xpDelta = 10;
          delegationInc = 1;
          dedupeKey = `msg:${ev.messageId}`;
        }
        break;
      case 'BotWorking':
        botId = ev.botId;
        xpDelta = 5;
        dedupeKey = `work:${ev.botId}:${Math.trunc(nowMs)}:${idx}`;
        break;
      default:
        break;
    }

    if (!botId || xpDelta <= 0 || !dedupeKey) continue;
    if (!trackBoundedEventId(seenEventIds, dedupeKey)) continue;

    const rec = getOrCreateRecord(store, botId);
    if (!rec) continue;

    rec.xp = clampInt(rec.xp + xpDelta, MAX_XP_VALUE);
    rec.completions = clampInt(rec.completions + completionInc, MAX_COUNTER_VALUE);
    rec.delegations = clampInt(rec.delegations + delegationInc, MAX_COUNTER_VALUE);
    store.updatedAtMs = Math.trunc(nowMs);
    changed = true;
    awarded.add(botId);
  }

  return { changed, awardedBotIds: Array.from(awarded) };
}
