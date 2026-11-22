import { scrubAll } from '../src/redact.ts';
import {
  type BotState,
  type UiLocale,
  type WorldSnapshot,
  botStatusLabel,
  isSafeKey,
  isWorkerActive,
  isWorkerVisibleOnStage,
} from '../src/types.ts';
import { tStrings } from './i18n.ts';

export type StatusFilterPreset = 'all' | 'working' | 'needs_you' | 'error' | 'workers';

export const STATUS_FILTER_PRESETS: readonly StatusFilterPreset[] = [
  'all',
  'working',
  'needs_you',
  'error',
  'workers',
] as const;

export type FilterCriteria = {
  preset: StatusFilterPreset;
  query: string;
  redactMode: boolean;
  locale: UiLocale;
};

export function orderedSnapshotBotIds(snapshot: WorldSnapshot): string[] {
  if (snapshot.botOrder.length > 0) {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of snapshot.botOrder) {
      if (isSafeKey(id) && Object.hasOwn(snapshot.bots, id) && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    for (const id of Object.keys(snapshot.bots)) {
      if (isSafeKey(id) && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  }
  return Object.keys(snapshot.bots).filter((id) => isSafeKey(id));
}

export function getBotRedactedAlias(
  botId: string,
  snapshot: WorldSnapshot,
  locale: UiLocale = 'en'
): string {
  const s = tStrings(locale);
  const ordered = orderedSnapshotBotIds(snapshot);
  const idx = ordered.indexOf(botId);
  if (idx >= 0) {
    return s.botNumbered(idx + 1);
  }
  return s.botGeneric;
}

export function botHasActiveWorker(bot: BotState, snapshot: WorldSnapshot): boolean {
  if (bot.activeWorkerCount > 0) return true;
  for (const w of Object.values(snapshot.workers)) {
    if (!isWorkerActive(w)) continue;
    if (w.parentBotId === bot.id || (w.parentBotName !== null && w.parentBotName === bot.name)) {
      return true;
    }
  }
  return false;
}

export function matchesStatusPreset(
  bot: BotState,
  preset: StatusFilterPreset,
  snapshot: WorldSnapshot
): boolean {
  switch (preset) {
    case 'all':
      return true;
    case 'working':
      return bot.status.kind === 'Working';
    case 'needs_you':
      return bot.status.kind === 'NeedsOwner' || bot.status.kind === 'Blocked';
    case 'error':
      return bot.status.kind === 'Error';
    case 'workers':
      return botHasActiveWorker(bot, snapshot);
  }
}

export function countFilterPresets(snapshot: WorldSnapshot): Record<StatusFilterPreset, number> {
  const counts: Record<StatusFilterPreset, number> = {
    all: 0,
    working: 0,
    needs_you: 0,
    error: 0,
    workers: 0,
  };
  for (const id of orderedSnapshotBotIds(snapshot)) {
    const bot = snapshot.bots[id];
    if (!bot) continue;
    counts.all += 1;
    if (matchesStatusPreset(bot, 'working', snapshot)) counts.working += 1;
    if (matchesStatusPreset(bot, 'needs_you', snapshot)) counts.needs_you += 1;
    if (matchesStatusPreset(bot, 'error', snapshot)) counts.error += 1;
    if (matchesStatusPreset(bot, 'workers', snapshot)) counts.workers += 1;
  }
  return counts;
}

export function matchesSearchQuery(
  bot: BotState,
  query: string,
  options: { snapshot: WorldSnapshot; redactMode: boolean; locale: UiLocale }
): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;

  const statusText = botStatusLabel(bot.status, options.locale).toLowerCase();
  if (options.redactMode) {
    // Strict Redact Mode: NEVER inspect real bot name, specialty, task titles, tools, or worker titles
    const alias = getBotRedactedAlias(bot.id, options.snapshot, options.locale).toLowerCase();
    return alias.includes(q) || statusText.includes(q);
  }

  const fields: string[] = [
    scrubAll(bot.name).toLowerCase(),
    scrubAll(bot.specialty).toLowerCase(),
    statusText,
  ];
  if (bot.currentTaskTitle) {
    fields.push(scrubAll(bot.currentTaskTitle).toLowerCase());
  }
  if (bot.currentTool) {
    fields.push(scrubAll(bot.currentTool).toLowerCase());
  }

  for (const w of Object.values(options.snapshot.workers)) {
    if (!isWorkerVisibleOnStage(w) && !isWorkerActive(w)) continue;
    if (w.parentBotId !== bot.id && w.parentBotName !== bot.name) continue;
    if (w.taskTitle) fields.push(scrubAll(w.taskTitle).toLowerCase());
    if (w.provider) fields.push(scrubAll(w.provider).toLowerCase());
    if (w.toolName) fields.push(scrubAll(w.toolName).toLowerCase());
  }

  return fields.some((f) => f.includes(q));
}

export function isFilterActive(preset: StatusFilterPreset, query: string): boolean {
  return preset !== 'all' || query.trim().length > 0;
}

export function filterBotIds(
  snapshot: WorldSnapshot,
  criteria: FilterCriteria
): Set<string> {
  const matched = new Set<string>();
  for (const id of orderedSnapshotBotIds(snapshot)) {
    const bot = snapshot.bots[id];
    if (!bot) continue;
    if (
      matchesStatusPreset(bot, criteria.preset, snapshot) &&
      matchesSearchQuery(bot, criteria.query, {
        snapshot,
        redactMode: criteria.redactMode,
        locale: criteria.locale,
      })
    ) {
      matched.add(id);
    }
  }
  return matched;
}
