import { eventRelatedBotId } from '../src/events.ts';
import { scrubAll } from '../src/redact.ts';
import {
  type BotRpgProfile,
  type DailyTrendPoint,
  type DeskPropId,
  type StuckAlert,
  type UiLocale,
  type WorldEvent,
  type WorldEventRecord,
  type WorldSnapshot,
  botStatusLabel,
  isSafeKey,
} from '../src/types.ts';
import { getLastSevenDaysTrend, mergeEventsIntoWeeklyTrend } from '../src/weekly-trend.ts';
import { propEmoji, rpgTitleForLevel } from './bot-rpg.ts';
import { clearChildren, el } from './dom.ts';
import { getBotRedactedAlias, orderedSnapshotBotIds } from './filter.ts';
import { formatTimeHms, tStrings } from './i18n.ts';
import {
  type OfficeBadgeId,
  badgeDisplayMeta,
  computeOfficeBadges,
} from './office-badges.ts';
import { stuckAlertByBotMap } from './watchdog.ts';

export type OfficeReportTopBot = {
  botId: string;
  botName: string;
  eventCount: number;
  sharePct: number;
};

export type OfficeReportHourlyBucket = {
  hourLabel: string;
  hourStartMs: number;
  count: number;
};

export type OfficeReportBadgeEntry = {
  badgeId: OfficeBadgeId;
  emoji: string;
  label: string;
  subtitle: string;
  winners: string[];
};

export type OfficeReportRpgBot = {
  botId: string;
  botName: string;
  level: number;
  title: string;
  xp: number;
  equippedProp: DeskPropId;
  propEmoji: string;
};

export type OfficeReportStandupBot = {
  botId: string;
  botName: string;
  estimatedWorkMinutes: number;
  completedCount: number;
  needsYouCount: number;
  stuckMinutes: number | null;
  statusText: string;
  activeTask: string | null;
};

export type OfficeReport = {
  redacted?: boolean;
  windowHours: number;
  generatedAtMs: number;
  totalEvents: number;
  workerRuns: number;
  collaborations: number;
  automationsTotal: number;
  automationsSucceeded: number;
  automationSuccessRate: number | null;
  needsOwnerCount: number;
  activeBotsCount: number;
  totalBotsCount: number;
  topBots: OfficeReportTopBot[];
  hourlyBuckets: OfficeReportHourlyBucket[];
  weeklyTrend?: DailyTrendPoint[];
  badges: OfficeReportBadgeEntry[];
  topRpgBots?: OfficeReportRpgBot[];
  standupBots?: OfficeReportStandupBot[];
};

const HOUR_MS = 3600_000;
const REPORT_WINDOW_HOURS = 24;
const HOURLY_BUCKET_COUNT = 12;

function extractEventBotName(event: WorldEvent): string | null {
  if (!event || typeof event !== 'object') return null;
  switch (event.kind) {
    case 'Handoff':
    case 'Question':
    case 'StatusReport':
    case 'Reply':
      if (event.from.kind === 'Bot' && event.from.botName) return event.from.botName;
      if (event.to.kind === 'Bot' && event.to.botName) return event.to.botName;
      return null;
    case 'WorkerStart':
    case 'WorkerDone':
    case 'WorkerFailed':
    case 'WorkerExited':
    case 'WorkerReleased':
      return event.parentBotName;
    case 'Escalation':
    case 'ApprovalClosed':
      return event.actor.kind === 'Bot' && event.actor.botName ? event.actor.botName : null;
    case 'ItemNeedsYou':
    case 'BossReplied':
    case 'ItemDone':
    case 'ItemCanceled':
    case 'BotWorking':
    case 'ToolChanged':
    case 'BotIdle':
    case 'WaitingAnswer':
    case 'BotFailed':
    case 'BotPaused':
    case 'BotJoined':
      return event.botName;
    case 'AutomationRun':
      return event.botName;
    default:
      return null;
  }
}

function formatHourBucketLabel(hourStartMs: number, locale: UiLocale): string {
  const hms = formatTimeHms(hourStartMs, locale);
  const hh = hms.slice(0, 2);
  return /^\d{2}$/.test(hh) ? `${hh}:00` : '--:00';
}

function stepClass(prefix: string, ratio: number): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const step = Math.round(clamped * 20);
  return `${prefix}-${step}`;
}

export function buildOfficeReport(
  events: readonly WorldEventRecord[],
  snapshot: WorldSnapshot,
  opts: {
    nowMs?: number;
    redactMode: boolean;
    locale: UiLocale;
    weeklyTrend?: readonly DailyTrendPoint[];
    rpgProfiles?: Readonly<Record<string, BotRpgProfile>>;
    stuckAlerts?: readonly StuckAlert[];
  }
): OfficeReport {
  const s = tStrings(opts.locale);
  const nowMs =
    typeof opts.nowMs === 'number' && Number.isFinite(opts.nowMs) && opts.nowMs > 0
      ? opts.nowMs
      : snapshot.capturedAt > 0
        ? snapshot.capturedAt
        : Date.now();

  const windowStartMs = nowMs - REPORT_WINDOW_HOURS * HOUR_MS;
  const windowEndMs = nowMs + 60_000;

  const windowEvents = events.filter(
    (rec) =>
      rec &&
      typeof rec.timestampMs === 'number' &&
      Number.isFinite(rec.timestampMs) &&
      rec.timestampMs >= windowStartMs &&
      rec.timestampMs <= windowEndMs
  );

  let workerRuns = 0;
  let collaborations = 0;
  let automationsTotal = 0;
  let automationsSucceeded = 0;
  let needsOwnerCount = 0;

  const botCounts = new Map<string, number>();
  const botNames = new Map<string, string>();

  if (!opts.redactMode) {
    for (const [id, bot] of Object.entries(snapshot.bots)) {
      if (isSafeKey(id) && bot && typeof bot.name === 'string') {
        botNames.set(id, scrubAll(bot.name));
      }
    }
  }

  for (const rec of windowEvents) {
    const ev = rec.event;
    if (!ev) continue;

    switch (ev.kind) {
      case 'WorkerStart':
        workerRuns += 1;
        break;
      case 'Handoff':
      case 'Question':
      case 'Reply':
      case 'StatusReport':
        collaborations += 1;
        break;
      case 'AutomationRun':
        automationsTotal += 1;
        if (ev.success) {
          automationsSucceeded += 1;
        }
        break;
      case 'ItemNeedsYou':
        needsOwnerCount += 1;
        break;
      default:
        break;
    }

    const botId = eventRelatedBotId(ev);
    if (botId && isSafeKey(botId)) {
      botCounts.set(botId, (botCounts.get(botId) ?? 0) + 1);
      if (!opts.redactMode && !botNames.has(botId)) {
        const rawName = extractEventBotName(ev);
        botNames.set(botId, rawName && rawName.trim().length > 0 ? scrubAll(rawName) : s.botGeneric);
      }
    }
  }

  const totalEvents = windowEvents.length;
  const automationSuccessRate =
    automationsTotal > 0 ? Math.round((automationsSucceeded / automationsTotal) * 100) : null;

  const totalBotsCount = Object.keys(snapshot.bots).length;
  const activeBotIds = new Set<string>();
  for (const botId of botCounts.keys()) {
    if (totalBotsCount === 0 || Object.hasOwn(snapshot.bots, botId)) {
      activeBotIds.add(botId);
    }
  }
  for (const [id, bot] of Object.entries(snapshot.bots)) {
    if (!isSafeKey(id)) continue;
    const kind = bot.status.kind;
    if (kind === 'Working' || kind === 'NeedsOwner' || kind === 'Blocked' || kind === 'WaitingAnswer') {
      activeBotIds.add(id);
    }
  }

  const topBots: OfficeReportTopBot[] = Array.from(botCounts.entries())
    .map(([botId, eventCount]) => ({
      botId,
      botName: opts.redactMode
        ? getBotRedactedAlias(botId, snapshot, opts.locale)
        : (botNames.get(botId) ?? s.botGeneric),
      eventCount,
      sharePct: totalEvents > 0 ? Math.round((eventCount / totalEvents) * 100) : 0,
    }))
    .sort(
      (a, b) =>
        b.eventCount - a.eventCount ||
        a.botName.localeCompare(b.botName) ||
        a.botId.localeCompare(b.botId)
    )
    .slice(0, 3);

  const currentHourStart = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const hourlyBuckets: OfficeReportHourlyBucket[] = [];
  for (let i = 0; i < HOURLY_BUCKET_COUNT; i++) {
    const hourStartMs = currentHourStart - (HOURLY_BUCKET_COUNT - 1 - i) * HOUR_MS;
    const hourEndMs = i === HOURLY_BUCKET_COUNT - 1 ? windowEndMs : hourStartMs + HOUR_MS;
    let count = 0;
    for (const rec of windowEvents) {
      if (rec.timestampMs >= hourStartMs && rec.timestampMs < hourEndMs) {
        count += 1;
      }
    }
    hourlyBuckets.push({
      hourLabel: formatHourBucketLabel(hourStartMs, opts.locale),
      hourStartMs,
      count,
    });
  }

  const badgeSummary = computeOfficeBadges(windowEvents, snapshot, {
    nowMs,
    redactMode: opts.redactMode,
    locale: opts.locale,
  });
  const badgeOrder: readonly OfficeBadgeId[] = ['mvp', 'delegator', 'night_owl', 'steady'];
  const badges: OfficeReportBadgeEntry[] = [];
  for (const bid of badgeOrder) {
    const winners = badgeSummary.awards
      .filter((a) => a.badgeId === bid)
      .map((a) => scrubAll(a.botName));
    if (winners.length > 0) {
      const meta = badgeDisplayMeta(bid, opts.locale);
      badges.push({
        badgeId: bid,
        emoji: meta.emoji,
        label: meta.label,
        subtitle: meta.subtitle,
        winners,
      });
    }
  }

  const mergedWeekly = mergeEventsIntoWeeklyTrend(opts.weeklyTrend ?? [], windowEvents, nowMs);
  const weeklyTrend = getLastSevenDaysTrend(mergedWeekly, nowMs);

  const topRpgBots: OfficeReportRpgBot[] = [];
  if (opts.rpgProfiles) {
    for (const [botId, prof] of Object.entries(opts.rpgProfiles)) {
      if (!isSafeKey(botId) || !prof) continue;
      if (!Object.hasOwn(snapshot.bots, botId)) continue;
      const displayName = opts.redactMode
        ? getBotRedactedAlias(botId, snapshot, opts.locale)
        : scrubAll(snapshot.bots[botId].name);
      topRpgBots.push({
        botId,
        botName: displayName,
        level: prof.level,
        title: rpgTitleForLevel(prof.level, opts.locale),
        xp: prof.xp,
        equippedProp: prof.equippedProp,
        propEmoji: propEmoji(prof.equippedProp),
      });
    }
    topRpgBots.sort(
      (a, b) => b.xp - a.xp || b.level - a.level || a.botName.localeCompare(b.botName) || a.botId.localeCompare(b.botId)
    );
    if (topRpgBots.length > 5) {
      topRpgBots.length = 5;
    }
  }

  const sortedWindowEvents = [...windowEvents].sort((a, b) => a.timestampMs - b.timestampMs);
  const workStartByBot = new Map<string, number>();
  const lastEventTsByBot = new Map<string, number>();
  const workMsByBot = new Map<string, number>();
  const completedByBot = new Map<string, number>();

  for (const rec of sortedWindowEvents) {
    const ev = rec.event;
    if (!ev) continue;
    const botId = eventRelatedBotId(ev);
    if (!botId || !isSafeKey(botId)) continue;
    const prevLastTs = lastEventTsByBot.get(botId) ?? 0;
    if (rec.timestampMs > prevLastTs) {
      lastEventTsByBot.set(botId, rec.timestampMs);
    }

    if (ev.kind === 'BotWorking' || ev.kind === 'ToolChanged') {
      if (!workStartByBot.has(botId)) {
        workStartByBot.set(botId, rec.timestampMs);
      }
    } else if (
      ev.kind === 'BotIdle' ||
      ev.kind === 'BotPaused' ||
      ev.kind === 'BotFailed' ||
      ev.kind === 'WaitingAnswer' ||
      ev.kind === 'ItemNeedsYou'
    ) {
      const started = workStartByBot.get(botId);
      if (started !== undefined) {
        workMsByBot.set(botId, (workMsByBot.get(botId) ?? 0) + Math.max(0, rec.timestampMs - started));
        workStartByBot.delete(botId);
      }
    } else if (ev.kind === 'ItemDone' || ev.kind === 'WorkerDone') {
      completedByBot.set(botId, (completedByBot.get(botId) ?? 0) + 1);
      if (!workStartByBot.has(botId) && (workMsByBot.get(botId) ?? 0) === 0) {
        workMsByBot.set(botId, 5 * 60_000);
      }
    }
  }
  const maxUnclosedNonWorkingMs = 15 * 60_000;
  for (const [botId, started] of workStartByBot.entries()) {
    const bot = Object.hasOwn(snapshot.bots, botId) ? snapshot.bots[botId] : undefined;
    if (bot?.status.kind === 'Working') {
      workMsByBot.set(botId, (workMsByBot.get(botId) ?? 0) + Math.max(0, nowMs - started));
    } else {
      const lastEvTs = lastEventTsByBot.get(botId) ?? started;
      const boundedEnd =
        lastEvTs > started ? Math.min(nowMs, lastEvTs) : nowMs;
      const conservativeElapsed = Math.min(Math.max(0, boundedEnd - started), maxUnclosedNonWorkingMs);
      workMsByBot.set(botId, (workMsByBot.get(botId) ?? 0) + conservativeElapsed);
    }
  }

  const stuckByBot = stuckAlertByBotMap(opts.stuckAlerts ?? []);
  const standupBotIds = new Set<string>(orderedSnapshotBotIds(snapshot));
  for (const botId of botCounts.keys()) {
    if (isSafeKey(botId)) standupBotIds.add(botId);
  }
  const standupBots: OfficeReportStandupBot[] = [];
  for (const botId of standupBotIds) {
    const bot = Object.hasOwn(snapshot.bots, botId) ? snapshot.bots[botId] : undefined;
    let totalWorkMs = workMsByBot.get(botId) ?? 0;
    if (totalWorkMs === 0 && bot && bot.status.kind === 'Working') {
      if (
        bot.lastActivityAt !== null &&
        Number.isFinite(bot.lastActivityAt) &&
        bot.lastActivityAt <= nowMs &&
        bot.lastActivityAt >= windowStartMs
      ) {
        totalWorkMs = Math.max(60_000, nowMs - bot.lastActivityAt);
      } else {
        totalWorkMs = 5 * 60_000;
      }
    } else if (totalWorkMs === 0 && (botCounts.get(botId) ?? 0) > 0) {
      totalWorkMs = Math.min(30, (botCounts.get(botId) ?? 0) * 2) * 60_000;
    }

    const estimatedWorkMinutes = Math.max(
      0,
      Math.min(REPORT_WINDOW_HOURS * 60, Math.round(totalWorkMs / 60_000))
    );
    const completedCount = completedByBot.get(botId) ?? 0;
    const needsYouCount = bot ? bot.needsYouCount : 0;
    const stuckMinutes = stuckByBot.get(botId)?.elapsedMinutes ?? null;
    const displayName = opts.redactMode
      ? getBotRedactedAlias(botId, snapshot, opts.locale)
      : bot
        ? scrubAll(bot.name)
        : (botNames.get(botId) ?? s.botGeneric);
    const statusText = bot ? botStatusLabel(bot.status, opts.locale) : s.unknownActor;
    const activeTask =
      !opts.redactMode && bot?.currentTaskTitle ? scrubAll(bot.currentTaskTitle) : null;

    standupBots.push({
      botId,
      botName: displayName,
      estimatedWorkMinutes,
      completedCount,
      needsYouCount,
      stuckMinutes,
      statusText,
      activeTask,
    });
  }
  standupBots.sort(
    (a, b) =>
      b.estimatedWorkMinutes - a.estimatedWorkMinutes ||
      b.completedCount - a.completedCount ||
      b.needsYouCount - a.needsYouCount ||
      a.botName.localeCompare(b.botName)
  );

  return {
    redacted: opts.redactMode,
    windowHours: REPORT_WINDOW_HOURS,
    generatedAtMs: nowMs,
    totalEvents,
    workerRuns,
    collaborations,
    automationsTotal,
    automationsSucceeded,
    automationSuccessRate,
    needsOwnerCount,
    activeBotsCount: activeBotIds.size,
    totalBotsCount,
    topBots,
    hourlyBuckets,
    weeklyTrend,
    badges,
    topRpgBots,
    standupBots,
  };
}

export function formatReportMarkdown(
  report: OfficeReport,
  opts: { redactMode: boolean; locale: UiLocale }
): string {
  const s = tStrings(opts.locale);
  const generatedHms = formatTimeHms(report.generatedAtMs, opts.locale);
  const autoText =
    report.automationSuccessRate !== null
      ? `${report.automationSuccessRate}% (${s.reportAutoCountSub(report.automationsSucceeded, report.automationsTotal)})`
      : s.reportAutoNone;

  const lines: string[] = [];
  if (opts.redactMode) {
    lines.push(`# ${s.reportTitle} [${s.reportRedactedBadge}]`);
    lines.push(`> [${s.reportRedactedBadge}] ${s.reportRedactedNotice}`);
  } else {
    lines.push(`# ${s.reportTitle}`);
  }
  lines.push(`- ${s.reportSubtitle(report.windowHours, generatedHms)}`);
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| ${s.reportKpiTotalEvents} | ${report.totalEvents} |`);
  lines.push(`| ${s.reportKpiWorkerRuns} | ${report.workerRuns} |`);
  lines.push(`| ${s.reportKpiCollaborations} | ${report.collaborations} |`);
  lines.push(`| ${s.reportKpiAutoSuccess} | ${autoText} |`);
  lines.push(
    `| ${opts.locale === 'ko' ? '활성 봇 / 결정 요청' : 'Active Bots / Needs You'} | ${report.activeBotsCount}/${report.totalBotsCount} · ${report.needsOwnerCount} |`
  );
  lines.push('');
  const needsFallbackMask = opts.redactMode && report.redacted !== true;
  lines.push(`## ${s.reportSectionTopBots}`);
  if (report.topBots.length === 0) {
    lines.push(`- ${s.reportNoBotActivity}`);
  } else {
    report.topBots.forEach((b, idx) => {
      const displayName = needsFallbackMask ? s.botGeneric : scrubAll(b.botName);
      lines.push(
        `${idx + 1}. **${displayName}** — ${s.reportBotEventCount(b.eventCount, b.sharePct)}`
      );
    });
  }
  lines.push('');
  lines.push(`## ${s.reportSectionBadges}`);
  if (!report.badges || report.badges.length === 0) {
    lines.push(`- ${s.reportNoBadges}`);
  } else {
    for (const b of report.badges) {
      const winnersText = needsFallbackMask
        ? b.winners.map(() => s.botGeneric).join(', ')
        : b.winners.map((w) => scrubAll(w)).join(', ');
      lines.push(`- ${b.emoji} **${b.label}**: ${winnersText}`);
    }
  }
  lines.push('');
  lines.push(`## ${s.reportSectionHourly}`);
  const hourlyLine = report.hourlyBuckets.map((b) => `${b.hourLabel}: ${b.count}`).join(' | ');
  lines.push(hourlyLine);

  const weekly = getLastSevenDaysTrend(report.weeklyTrend ?? [], report.generatedAtMs);
  lines.push('');
  lines.push(`## ${s.reportSectionWeekly}`);
  lines.push(
    `| ${s.reportWeeklyColumns.date} | ${s.reportWeeklyColumns.events} | ${s.reportWeeklyColumns.tasksDone} | ${s.reportWeeklyColumns.workers} | ${s.reportWeeklyColumns.collaborations} |`
  );
  lines.push('| --- | --- | --- | --- | --- |');
  for (const pt of weekly) {
    lines.push(`| ${pt.date} | ${pt.events} | ${pt.tasksDone} | ${pt.workerRuns} | ${pt.collaborations} |`);
  }

  if (report.topRpgBots && report.topRpgBots.length > 0) {
    lines.push('');
    lines.push(`## ${s.reportSectionRpg}`);
    report.topRpgBots.forEach((rb, idx) => {
      const displayName = needsFallbackMask ? s.botGeneric : scrubAll(rb.botName);
      const propTag = rb.equippedProp !== 'none' ? ` · ${rb.propEmoji} ${s.rpgPropLabels[rb.equippedProp]}` : '';
      lines.push(
        `${idx + 1}. **${displayName}** — Lv.${rb.level} (${rb.title}) · ${rb.xp} XP${propTag}`
      );
    });
  }

  return lines.join('\n');
}

function formatWorkDuration(minutes: number, locale: UiLocale): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) {
    return locale === 'ko' ? `${m}분` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (locale === 'ko') {
    return rem > 0 ? `${h}시간 ${rem}분` : `${h}시간`;
  }
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

export function formatStandupMarkdown(
  report: OfficeReport,
  opts: { redactMode: boolean; locale: UiLocale }
): string {
  const s = tStrings(opts.locale);
  const generatedHms = formatTimeHms(report.generatedAtMs, opts.locale);
  const needsFallbackMask = opts.redactMode && report.redacted !== true;
  const rows = report.standupBots ?? [];
  const totalCompleted = rows.reduce((sum, r) => sum + r.completedCount, 0);
  const totalNeedsYou = rows.reduce((sum, r) => sum + r.needsYouCount, 0);
  const totalStuck = rows.filter((r) => r.stuckMinutes !== null && r.stuckMinutes > 0).length;

  const lines: string[] = [];
  if (opts.redactMode) {
    lines.push(`# ${s.standupTitle} [${s.reportRedactedBadge}]`);
    lines.push(`> [${s.reportRedactedBadge}] ${s.reportRedactedNotice}`);
  } else {
    lines.push(`# ${s.standupTitle}`);
  }
  lines.push(`- ${s.reportSubtitle(report.windowHours, generatedHms)}`);
  lines.push(
    opts.locale === 'ko'
      ? `- 요약: 활성 봇 ${report.activeBotsCount}/${report.totalBotsCount} · 완료 ${totalCompleted}건 · 결정 대기 ${totalNeedsYou}건 · 정체 ${totalStuck}건`
      : `- Summary: Active ${report.activeBotsCount}/${report.totalBotsCount} · Completed ${totalCompleted} · Needs You ${totalNeedsYou} · Stuck ${totalStuck}`
  );
  lines.push('');

  if (rows.length === 0) {
    lines.push(`- ${s.standupNoBots}`);
    return lines.join('\n');
  }

  lines.push(
    `| ${s.standupColumns.bot} | ${s.standupColumns.estWork} | ${s.standupColumns.completed} | ${s.standupColumns.needsYou} | ${s.standupColumns.stuck} | ${s.standupColumns.status} |`
  );
  lines.push('| --- | --- | --- | --- | --- | --- |');
  rows.forEach((row, idx) => {
    const displayName = opts.redactMode
      ? needsFallbackMask
        ? s.botNumbered(idx + 1)
        : scrubAll(row.botName)
      : scrubAll(row.botName);
    const workText = formatWorkDuration(row.estimatedWorkMinutes, opts.locale);
    const stuckText =
      row.stuckMinutes !== null && row.stuckMinutes > 0 ? `⏳ ${row.stuckMinutes}m` : '—';
    const statusCell =
      !opts.redactMode && row.activeTask
        ? `${row.statusText} — ${scrubAll(row.activeTask).replace(/\|/g, '/')}`
        : row.statusText;
    lines.push(
      `| ${displayName.replace(/\|/g, '/')} | ${workText} | ${row.completedCount} | ${row.needsYouCount} | ${stuckText} | ${statusCell} |`
    );
  });

  return lines.join('\n');
}

export function buildStandupMarkdown(
  events: readonly WorldEventRecord[],
  snapshot: WorldSnapshot,
  opts: {
    nowMs?: number;
    redactMode: boolean;
    locale: UiLocale;
    weeklyTrend?: readonly DailyTrendPoint[];
    rpgProfiles?: Readonly<Record<string, BotRpgProfile>>;
    stuckAlerts?: readonly StuckAlert[];
  }
): string {
  const report = buildOfficeReport(events, snapshot, opts);
  return formatStandupMarkdown(report, { redactMode: opts.redactMode, locale: opts.locale });
}

export function renderOfficeReportModal(
  backdrop: HTMLElement,
  opts: {
    open: boolean;
    report: OfficeReport;
    redactMode: boolean;
    locale: UiLocale;
    copied: boolean;
    standupCopied?: boolean;
    onCopyMarkdown: () => void;
    onCopyStandupMarkdown?: () => void;
    onClose: () => void;
  }
): void {
  clearChildren(backdrop);
  backdrop.classList.toggle('bw-hidden', !opts.open);
  if (!opts.open) {
    return;
  }

  const s = tStrings(opts.locale);
  const { report, redactMode, copied } = opts;
  const needsFallbackMask = redactMode && report.redacted !== true;
  const generatedHms = formatTimeHms(report.generatedAtMs, opts.locale);

  const autoRateLabel =
    report.automationSuccessRate !== null ? `${report.automationSuccessRate}%` : '—';
  const autoSubLabel =
    report.automationsTotal > 0
      ? s.reportAutoCountSub(report.automationsSucceeded, report.automationsTotal)
      : s.reportAutoNone;

  const kpiGrid = el(
    'div',
    { className: 'bw-report-kpis' },
    el(
      'div',
      { className: 'bw-report-kpi' },
      el('div', { className: 'bw-report-kpi-label' }, s.reportKpiTotalEvents),
      el('div', { className: 'bw-report-kpi-value' }, String(report.totalEvents))
    ),
    el(
      'div',
      { className: 'bw-report-kpi' },
      el('div', { className: 'bw-report-kpi-label' }, s.reportKpiWorkerRuns),
      el('div', { className: 'bw-report-kpi-value' }, String(report.workerRuns))
    ),
    el(
      'div',
      { className: 'bw-report-kpi' },
      el('div', { className: 'bw-report-kpi-label' }, s.reportKpiCollaborations),
      el('div', { className: 'bw-report-kpi-value' }, String(report.collaborations))
    ),
    el(
      'div',
      { className: 'bw-report-kpi' },
      el('div', { className: 'bw-report-kpi-label' }, s.reportKpiAutoSuccess),
      el('div', { className: 'bw-report-kpi-value' }, autoRateLabel),
      el('div', { className: 'bw-report-kpi-sub' }, autoSubLabel)
    )
  );

  const maxBotEvents = Math.max(1, ...report.topBots.map((b) => b.eventCount));
  const topBotsSection = el(
    'div',
    { className: 'bw-section' },
    el('div', { className: 'bw-section-title' }, s.reportSectionTopBots),
    report.topBots.length === 0
      ? el('div', { className: 'bw-muted-note' }, s.reportNoBotActivity)
      : el(
          'div',
          { className: 'bw-report-top-bots' },
          ...report.topBots.map((bot, idx) =>
            el(
              'div',
              { className: 'bw-report-bot-row' },
              el(
                'div',
                { className: 'bw-report-bot-meta' },
                el(
                  'span',
                  { className: 'bw-report-bot-name' },
                  `${idx + 1}. ${needsFallbackMask ? s.botGeneric : scrubAll(bot.botName)}`
                ),
                el(
                  'span',
                  { className: 'bw-meta-time' },
                  s.reportBotEventCount(bot.eventCount, bot.sharePct)
                )
              ),
              el(
                'div',
                { className: 'bw-report-bar-track' },
                el('div', {
                  className: `bw-report-bar-fill ${stepClass('bw-fill-step', bot.eventCount / maxBotEvents)}`,
                })
              )
            )
          )
        )
  );

  const maxBucketCount = Math.max(1, ...report.hourlyBuckets.map((b) => b.count));
  const hourlyChart = el(
    'div',
    { className: 'bw-section' },
    el('div', { className: 'bw-section-title' }, s.reportSectionHourly),
    el(
      'div',
      { className: 'bw-report-chart' },
      ...report.hourlyBuckets.map((bucket) =>
        el(
          'div',
          {
            className: 'bw-report-col',
            title: `${bucket.hourLabel} — ${bucket.count}`,
          },
          el(
            'div',
            { className: 'bw-report-col-track' },
            el('div', {
              className: `bw-report-col-bar ${stepClass('bw-bar-step', bucket.count > 0 ? Math.max(0.08, bucket.count / maxBucketCount) : 0)}`,
            })
          ),
          el('div', { className: 'bw-report-col-label' }, bucket.hourLabel.slice(0, 2))
        )
      )
    )
  );

  const weeklyData = getLastSevenDaysTrend(report.weeklyTrend ?? [], report.generatedAtMs);
  const maxWeeklyCount = Math.max(1, ...weeklyData.map((d) => d.events));
  const weeklyChart = el(
    'div',
    { className: 'bw-section' },
    el('div', { className: 'bw-section-title' }, s.reportSectionWeekly),
    el(
      'div',
      { className: 'bw-report-weekly-chart' },
      ...weeklyData.map((pt) =>
        el(
          'div',
          {
            className: 'bw-report-col',
            title: `${pt.date} — ${s.reportWeeklyColumns.events}: ${pt.events}, ${s.reportWeeklyColumns.tasksDone}: ${pt.tasksDone}, ${s.reportWeeklyColumns.workers}: ${pt.workerRuns}, ${s.reportWeeklyColumns.collaborations}: ${pt.collaborations}`,
          },
          el('div', { className: 'bw-report-weekly-val' }, String(pt.events)),
          el(
            'div',
            { className: 'bw-report-col-track' },
            el('div', {
              className: `bw-report-col-bar bw-report-col-bar-weekly ${stepClass('bw-bar-step', pt.events > 0 ? Math.max(0.08, pt.events / maxWeeklyCount) : 0)}`,
            })
          ),
          el('div', { className: 'bw-report-col-label' }, pt.date.slice(5).replace('-', '/'))
        )
      )
    )
  );

  const badgesSection = el(
    'div',
    { className: 'bw-section' },
    el('div', { className: 'bw-section-title' }, s.reportSectionBadges),
    !report.badges || report.badges.length === 0
      ? el('div', { className: 'bw-muted-note' }, s.reportNoBadges)
      : el(
          'div',
          { className: 'bw-report-badges-grid' },
          ...report.badges.map((b) =>
            el(
              'div',
              {
                className: b.badgeId === 'mvp' ? 'bw-report-badge-card bw-report-badge-mvp' : 'bw-report-badge-card',
                title: b.subtitle,
              },
              el('div', { className: 'bw-report-badge-label' }, `${b.emoji} ${b.label}`),
              el(
                'div',
                { className: 'bw-report-badge-winner' },
                needsFallbackMask
                  ? b.winners.map(() => s.botGeneric).join(', ')
                  : b.winners.map((w) => scrubAll(w)).join(', ')
              )
            )
          )
        )
  );

  const rpgBots = report.topRpgBots ?? [];
  const rpgSection = el(
    'div',
    { className: 'bw-section' },
    el('div', { className: 'bw-section-title' }, s.reportSectionRpg),
    rpgBots.length === 0
      ? el('div', { className: 'bw-muted-note' }, s.reportNoRpgBots)
      : el(
          'div',
          { className: 'bw-report-rpg-list' },
          ...rpgBots.map((rb, idx) => {
            const displayName = needsFallbackMask ? s.botGeneric : scrubAll(rb.botName);
            const propTag =
              rb.equippedProp !== 'none'
                ? `${rb.propEmoji} ${s.rpgPropLabels[rb.equippedProp]}`
                : s.rpgPropLabels.none;
            return el(
              'div',
              { className: 'bw-report-rpg-row' },
              el(
                'span',
                { className: 'bw-report-bot-name' },
                `${idx + 1}. ${displayName}`
              ),
              el(
                'span',
                { className: 'bw-meta-time' },
                `Lv.${rb.level} ${rb.title} · ${rb.xp} XP · ${propTag}`
              )
            );
          })
        )
  );

  const standupMd = formatStandupMarkdown(report, { redactMode, locale: opts.locale });
  const standupSection = el(
    'div',
    { className: 'bw-section' },
    el(
      'div',
      { className: 'bw-section-title-row' },
      el('div', { className: 'bw-section-title' }, s.reportStandupPreviewTitle),
      opts.onCopyStandupMarkdown
        ? el(
            'button',
            {
              type: 'button',
              className: opts.standupCopied ? 'bw-btn bw-btn-active bw-btn-xs' : 'bw-btn bw-btn-xs',
              onClick: opts.onCopyStandupMarkdown,
            },
            opts.standupCopied ? s.reportCopied : s.reportCopyStandup
          )
        : null
    ),
    el('pre', { className: 'bw-standup-preview' }, standupMd)
  );

  const titleRowChildren = [
    el('span', { className: 'bw-modal-title' }, s.reportTitle),
    redactMode ? el('span', { className: 'bw-badge bw-badge-needs' }, s.reportRedactedBadge) : null,
  ];

  const dialog = el(
    'div',
    {
      className: 'bw-modal-dialog bw-report-dialog',
      role: 'dialog',
      ariaLabel: s.reportTitle,
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
        el('div', { className: 'bw-detail-title-row' }, ...titleRowChildren),
        el('div', { className: 'bw-modal-subtitle' }, s.reportSubtitle(report.windowHours, generatedHms))
      ),
      el(
        'div',
        { className: 'bw-toolbar-group bw-modal-actions' },
        opts.onCopyStandupMarkdown
          ? el(
              'button',
              {
                type: 'button',
                className: opts.standupCopied ? 'bw-btn bw-btn-active' : 'bw-btn',
                onClick: opts.onCopyStandupMarkdown,
              },
              opts.standupCopied ? s.reportCopied : s.reportCopyStandup
            )
          : null,
        el(
          'button',
          {
            type: 'button',
            className: copied ? 'bw-btn bw-btn-active' : 'bw-btn bw-btn-primary',
            onClick: opts.onCopyMarkdown,
          },
          copied ? s.reportCopied : s.reportCopyMarkdown
        ),
        el(
          'button',
          {
            type: 'button',
            className: 'bw-btn bw-btn-ghost',
            ariaLabel: s.reportClose,
            onClick: opts.onClose,
          },
          '✕'
        )
      )
    ),
    redactMode ? el('div', { className: 'bw-report-redact-note' }, s.reportRedactedNotice) : null,
    kpiGrid,
    el(
      'div',
      { className: 'bw-report-meta-line' },
      s.reportActiveBotsMeta(report.activeBotsCount, report.totalBotsCount, report.needsOwnerCount)
    ),
    badgesSection,
    rpgSection,
    topBotsSection,
    hourlyChart,
    weeklyChart,
    standupSection
  );

  backdrop.appendChild(dialog);
}
