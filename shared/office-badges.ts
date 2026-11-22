import { eventRelatedBotId } from '../src/events.ts';
import { scrubAll } from '../src/redact.ts';
import {
  type UiLocale,
  type WorldEventRecord,
  type WorldSnapshot,
  isSafeKey,
  isWorkerVisibleOnStage,
} from '../src/types.ts';
import { getBotRedactedAlias } from './filter.ts';
import { tStrings } from './i18n.ts';

export type OfficeBadgeId = 'mvp' | 'delegator' | 'night_owl' | 'steady';

export type OfficeBadgeAward = {
  badgeId: OfficeBadgeId;
  botId: string;
  botName: string;
  score: number;
  detailCount: number;
};

export type OfficeBadgesSummary = {
  awards: OfficeBadgeAward[];
  mvpBotId: string | null;
  badgesByBot: Record<string, OfficeBadgeId[]>;
};

const HOUR_MS = 3600_000;
const BADGE_WINDOW_HOURS = 24;

type BotBadgeAccum = {
  botId: string;
  rawName: string;
  eventCount: number;
  doneCount: number;
  nightCount: number;
  errorCount: number;
  delegationIds: Set<string>;
};

export function badgeEmoji(badgeId: OfficeBadgeId): string {
  switch (badgeId) {
    case 'mvp':
      return '👑';
    case 'delegator':
      return '🧭';
    case 'night_owl':
      return '🦉';
    case 'steady':
      return '🛡️';
  }
}

export function badgeDisplayMeta(
  badgeId: OfficeBadgeId,
  locale: UiLocale = 'en'
): { emoji: string; label: string; subtitle: string } {
  const s = tStrings(locale);
  switch (badgeId) {
    case 'mvp':
      return { emoji: '👑', label: s.badgeMvpLabel, subtitle: s.badgeMvpDesc };
    case 'delegator':
      return { emoji: '🧭', label: s.badgeDelegatorLabel, subtitle: s.badgeDelegatorDesc };
    case 'night_owl':
      return { emoji: '🦉', label: s.badgeNightOwlLabel, subtitle: s.badgeNightOwlDesc };
    case 'steady':
      return { emoji: '🛡️', label: s.badgeSteadyLabel, subtitle: s.badgeSteadyDesc };
  }
}

export function computeOfficeBadges(
  events: readonly WorldEventRecord[],
  snapshot: WorldSnapshot,
  opts?: { nowMs?: number; redactMode?: boolean; locale?: UiLocale }
): OfficeBadgesSummary {
  const locale = opts?.locale ?? 'en';
  const redactMode = Boolean(opts?.redactMode);
  const s = tStrings(locale);
  const nowMs =
    typeof opts?.nowMs === 'number' && Number.isFinite(opts.nowMs) && opts.nowMs > 0
      ? opts.nowMs
      : snapshot.capturedAt > 0
        ? snapshot.capturedAt
        : Date.now();
  const windowStartMs = nowMs - BADGE_WINDOW_HOURS * HOUR_MS;
  const windowEndMs = nowMs + 60_000;

  const stats = new Map<string, BotBadgeAccum>();
  const ensureBot = (botId: string, nameHint?: string | null): BotBadgeAccum | null => {
    if (!isSafeKey(botId)) return null;
    let acc = stats.get(botId);
    if (!acc) {
      const snapName = Object.hasOwn(snapshot.bots, botId) ? snapshot.bots[botId].name : null;
      const resolvedName =
        snapName && snapName.trim().length > 0
          ? scrubAll(snapName)
          : nameHint && nameHint.trim().length > 0
            ? scrubAll(nameHint)
            : s.botGeneric;
      acc = {
        botId,
        rawName: resolvedName,
        eventCount: 0,
        doneCount: 0,
        nightCount: 0,
        errorCount: 0,
        delegationIds: new Set<string>(),
      };
      stats.set(botId, acc);
    }
    return acc;
  };

  for (const [id, bot] of Object.entries(snapshot.bots)) {
    if (isSafeKey(id)) {
      ensureBot(id, bot.name);
    }
  }

  for (const worker of Object.values(snapshot.workers)) {
    if (!isWorkerVisibleOnStage(worker) || !worker.parentBotId) continue;
    const acc = ensureBot(worker.parentBotId, worker.parentBotName);
    if (acc && isSafeKey(worker.dispatchId)) {
      acc.delegationIds.add(worker.dispatchId);
    }
  }

  for (const it of Object.values(snapshot.items)) {
    if (it.status === 'done' && isSafeKey(it.ownerBotId)) {
      const acc = ensureBot(it.ownerBotId, it.ownerBotName);
      if (acc) acc.doneCount += 1;
    }
  }

  for (const rec of events) {
    if (
      !rec ||
      typeof rec.timestampMs !== 'number' ||
      !Number.isFinite(rec.timestampMs) ||
      rec.timestampMs < windowStartMs ||
      rec.timestampMs > windowEndMs
    ) {
      continue;
    }
    const ev = rec.event;
    if (!ev) continue;

    const botId = eventRelatedBotId(ev);
    if (!botId || !isSafeKey(botId)) continue;
    const nameHint =
      'botName' in ev && typeof ev.botName === 'string'
        ? ev.botName
        : 'parentBotName' in ev && typeof ev.parentBotName === 'string'
          ? ev.parentBotName
          : null;
    const acc = ensureBot(botId, nameHint);
    if (!acc) continue;

    acc.eventCount += 1;
    const hour = new Date(rec.timestampMs).getHours();
    if (hour >= 21 || hour <= 4) {
      acc.nightCount += 1;
    }

    if (ev.kind === 'ItemDone') {
      acc.doneCount += 1;
    } else if (ev.kind === 'WorkerStart' && isSafeKey(ev.dispatchId)) {
      acc.delegationIds.add(ev.dispatchId);
    } else if (
      ev.kind === 'BotFailed' ||
      ev.kind === 'WorkerFailed' ||
      (ev.kind === 'AutomationRun' && !ev.success)
    ) {
      acc.errorCount += 1;
    }
  }

  const displayNameFor = (acc: BotBadgeAccum): string =>
    redactMode ? getBotRedactedAlias(acc.botId, snapshot, locale) : acc.rawName;

  const delegationCountFor = (acc: BotBadgeAccum): number => {
    const snapCount = Object.hasOwn(snapshot.bots, acc.botId)
      ? snapshot.bots[acc.botId].activeWorkerCount
      : 0;
    return Math.max(acc.delegationIds.size, snapCount);
  };

  const allEntries = Array.from(stats.values());
  const awards: OfficeBadgeAward[] = [];
  const badgesByBot: Record<string, OfficeBadgeId[]> = {};
  const assignBadge = (botId: string, badgeId: OfficeBadgeId): void => {
    if (!isSafeKey(botId)) return;
    if (!Object.hasOwn(badgesByBot, botId)) {
      Object.defineProperty(badgesByBot, botId, {
        value: [badgeId],
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else if (!badgesByBot[botId].includes(badgeId)) {
      badgesByBot[botId].push(badgeId);
    }
  };

  // 1. Daily MVP (>= 2 events; highest activity score = events + doneCount + delegations)
  const mvpCandidates = allEntries
    .filter((acc) => acc.eventCount >= 2)
    .map((acc) => ({
      acc,
      score: acc.eventCount + acc.doneCount + delegationCountFor(acc),
      name: displayNameFor(acc),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.acc.eventCount - a.acc.eventCount ||
        a.name.localeCompare(b.name) ||
        a.acc.botId.localeCompare(b.acc.botId)
    );
  let mvpBotId: string | null = null;
  if (mvpCandidates.length > 0) {
    const top = mvpCandidates[0];
    mvpBotId = top.acc.botId;
    assignBadge(mvpBotId, 'mvp');
    awards.push({
      badgeId: 'mvp',
      botId: mvpBotId,
      botName: top.name,
      score: top.score,
      detailCount: top.acc.eventCount,
    });
  }

  // 2. Top Delegator (>= 1 delegation)
  const delegatorCandidates = allEntries
    .map((acc) => ({
      acc,
      count: delegationCountFor(acc),
      name: displayNameFor(acc),
    }))
    .filter((entry) => entry.count >= 1)
    .sort(
      (a, b) =>
        b.count - a.count ||
        b.acc.eventCount - a.acc.eventCount ||
        a.name.localeCompare(b.name) ||
        a.acc.botId.localeCompare(b.acc.botId)
    );
  if (delegatorCandidates.length > 0) {
    const top = delegatorCandidates[0];
    assignBadge(top.acc.botId, 'delegator');
    awards.push({
      badgeId: 'delegator',
      botId: top.acc.botId,
      botName: top.name,
      score: top.count,
      detailCount: top.count,
    });
  }

  // 3. Night Owl (>= 2 night events during 21:00-04:59 local time)
  const nightCandidates = allEntries
    .filter((acc) => acc.nightCount >= 2)
    .map((acc) => ({
      acc,
      name: displayNameFor(acc),
    }))
    .sort(
      (a, b) =>
        b.acc.nightCount - a.acc.nightCount ||
        b.acc.eventCount - a.acc.eventCount ||
        a.name.localeCompare(b.name) ||
        a.acc.botId.localeCompare(b.acc.botId)
    );
  if (nightCandidates.length > 0) {
    const top = nightCandidates[0];
    assignBadge(top.acc.botId, 'night_owl');
    awards.push({
      badgeId: 'night_owl',
      botId: top.acc.botId,
      botName: top.name,
      score: top.acc.nightCount,
      detailCount: top.acc.nightCount,
    });
  }

  // 4. Error-Free Streak (>= 3 events, 0 error events, not currently in Error state)
  const steadyCandidates = allEntries
    .filter((acc) => {
      if (acc.eventCount < 3 || acc.errorCount > 0) return false;
      const currentBot = Object.hasOwn(snapshot.bots, acc.botId) ? snapshot.bots[acc.botId] : null;
      return currentBot?.status.kind !== 'Error';
    })
    .map((acc) => ({
      acc,
      name: displayNameFor(acc),
    }))
    .sort(
      (a, b) =>
        b.acc.eventCount - a.acc.eventCount ||
        a.name.localeCompare(b.name) ||
        a.acc.botId.localeCompare(b.acc.botId)
    );
  for (const entry of steadyCandidates) {
    assignBadge(entry.acc.botId, 'steady');
    awards.push({
      badgeId: 'steady',
      botId: entry.acc.botId,
      botName: entry.name,
      score: entry.acc.eventCount,
      detailCount: entry.acc.eventCount,
    });
  }

  return {
    awards,
    mvpBotId,
    badgesByBot,
  };
}
