import type { OrcaWorkerApi } from 'orca/worker';
import { tStrings } from '../shared/i18n.ts';
import { STUCK_NOTIFY_COOLDOWN_MS } from '../shared/watchdog.ts';
import { scrubAll } from './redact.ts';
import {
  type BotState,
  type StuckAlert,
  type UiLocale,
  type WorldSnapshot,
  isSafeKey,
} from './types.ts';

export const DEFAULT_DESKTOP_NOTIFY_COOLDOWN_MS = 60_000;
export { STUCK_NOTIFY_COOLDOWN_MS };
const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 240;

function truncateChars(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  if (maxChars <= 1) return chars.slice(0, maxChars).join('');
  return `${chars.slice(0, maxChars - 1).join('')}…`;
}

function resolveBotSequence(snapshot: WorldSnapshot, botId: string): number {
  const ordered =
    snapshot.botOrder.length > 0
      ? snapshot.botOrder.filter((id) => isSafeKey(id) && Object.hasOwn(snapshot.bots, id))
      : Object.keys(snapshot.bots).filter((id) => isSafeKey(id));
  const idx = ordered.indexOf(botId);
  return idx >= 0 ? idx + 1 : 1;
}

export type DesktopNotifyKind = 'NeedsOwner' | 'Error' | 'Stuck';

export type DesktopNotificationPayload = {
  botId: string;
  kind: DesktopNotifyKind;
  title: string;
  body: string;
};

export class DesktopNotificationManager {
  private readonly cooldownMs: number;
  private readonly stuckCooldownMs: number;
  private readonly lastNotifiedAt = new Map<string, number>();

  constructor(options?: { cooldownMs?: number; stuckCooldownMs?: number }) {
    const cd = options?.cooldownMs;
    this.cooldownMs =
      typeof cd === 'number' && Number.isFinite(cd) && cd >= 0
        ? Math.trunc(cd)
        : DEFAULT_DESKTOP_NOTIFY_COOLDOWN_MS;
    const scd = options?.stuckCooldownMs;
    this.stuckCooldownMs =
      typeof scd === 'number' && Number.isFinite(scd) && scd >= 0
        ? Math.trunc(scd)
        : STUCK_NOTIFY_COOLDOWN_MS;
  }

  resetCooldowns(): void {
    this.lastNotifiedAt.clear();
  }

  async evaluateAndNotify(params: {
    prevSnapshot: WorldSnapshot;
    nextSnapshot: WorldSnapshot;
    enabled: boolean;
    redactMode: boolean;
    locale: UiLocale;
    nowMs: number;
    orca: OrcaWorkerApi;
  }): Promise<{ sent: DesktopNotificationPayload[]; suppressedReason?: string }> {
    const { prevSnapshot, nextSnapshot, enabled, redactMode, locale, nowMs, orca } = params;
    if (!enabled) {
      return { sent: [], suppressedReason: 'disabled' };
    }
    if (
      !prevSnapshot.initialSyncComplete ||
      !nextSnapshot.initialSyncComplete ||
      Object.keys(prevSnapshot.bots).length === 0
    ) {
      return { sent: [], suppressedReason: 'initial_sync' };
    }
    if (!orca.host.has('notifications.show')) {
      return { sent: [], suppressedReason: 'capability_unavailable' };
    }

    const s = tStrings(locale);
    const sent: DesktopNotificationPayload[] = [];
    const botIds =
      nextSnapshot.botOrder.length > 0
        ? nextSnapshot.botOrder.filter((id) => isSafeKey(id) && Object.hasOwn(nextSnapshot.bots, id))
        : Object.keys(nextSnapshot.bots).filter((id) => isSafeKey(id));

    for (const botId of botIds) {
      const nextBot: BotState = nextSnapshot.bots[botId];
      const kind = nextBot.status.kind;
      if (kind !== 'NeedsOwner' && kind !== 'Error') {
        continue;
      }

      const prevBot = Object.hasOwn(prevSnapshot.bots, botId) ? prevSnapshot.bots[botId] : undefined;
      if (prevBot && prevBot.status.kind === kind) {
        continue;
      }

      const cdKey = `${botId}:${kind}`;
      const prevSentAt = this.lastNotifiedAt.get(cdKey);
      if (prevSentAt !== undefined && nowMs - prevSentAt < this.cooldownMs) {
        continue;
      }

      const seq = resolveBotSequence(nextSnapshot, botId);
      let rawTitle: string;
      let rawBody: string;
      if (redactMode) {
        if (kind === 'NeedsOwner') {
          rawTitle = s.notifyNeedsYouTitleRedacted;
          rawBody = s.notifyNeedsYouBodyRedacted(seq);
        } else {
          rawTitle = s.notifyErrorTitleRedacted;
          rawBody = s.notifyErrorBodyRedacted(seq);
        }
      } else {
        const cleanName = scrubAll(nextBot.name).trim() || s.botGeneric;
        if (nextBot.status.kind === 'NeedsOwner') {
          const cleanPrompt =
            nextBot.status.prompt && nextBot.status.prompt.trim().length > 0
              ? scrubAll(nextBot.status.prompt).trim()
              : null;
          rawTitle = s.notifyNeedsYouTitle(cleanName);
          rawBody = s.notifyNeedsYouBody(cleanPrompt);
        } else {
          const errMsg =
            nextBot.status.kind === 'Error' &&
            nextBot.status.message &&
            nextBot.status.message.trim().length > 0
              ? scrubAll(nextBot.status.message).trim()
              : null;
          rawTitle = s.notifyErrorTitle(cleanName);
          rawBody = s.notifyErrorBody(errMsg);
        }
      }

      const title = truncateChars(rawTitle.trim() || 'Bot World', MAX_TITLE_CHARS);
      const body = truncateChars(rawBody.trim(), MAX_BODY_CHARS);

      try {
        await orca.host.call('notifications.show', {
          title,
          body,
        });
        if (this.lastNotifiedAt.size >= 512) {
          const oldest = this.lastNotifiedAt.keys().next().value;
          if (oldest !== undefined) this.lastNotifiedAt.delete(oldest);
        }
        this.lastNotifiedAt.set(cdKey, nowMs);
        sent.push({ botId, kind, title, body });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'notification failed';
        try {
          orca.log(`bot-world notification skipped: ${scrubAll(msg)}`);
        } catch {
          // Ignore log failure
        }
      }
    }

    return { sent };
  }

  async notifyStuckAlerts(params: {
    alerts: readonly StuckAlert[];
    snapshot: WorldSnapshot;
    enabled: boolean;
    thresholdMin: number;
    redactMode: boolean;
    locale: UiLocale;
    nowMs: number;
    orca: OrcaWorkerApi;
  }): Promise<{ sent: DesktopNotificationPayload[]; suppressedReason?: string }> {
    const { alerts, snapshot, enabled, thresholdMin, redactMode, locale, nowMs, orca } = params;
    if (!enabled || thresholdMin <= 0) {
      return { sent: [], suppressedReason: 'disabled' };
    }
    if (!snapshot.initialSyncComplete || Object.keys(snapshot.bots).length === 0) {
      return { sent: [], suppressedReason: 'initial_sync' };
    }
    if (!orca.host.has('notifications.show')) {
      return { sent: [], suppressedReason: 'capability_unavailable' };
    }

    const s = tStrings(locale);
    const sent: DesktopNotificationPayload[] = [];
    const perBotBest = new Map<string, StuckAlert>();
    for (const alert of alerts) {
      if (!isSafeKey(alert.botId) || !Object.hasOwn(snapshot.bots, alert.botId)) continue;
      const prev = perBotBest.get(alert.botId);
      if (!prev || alert.elapsedMs > prev.elapsedMs) {
        perBotBest.set(alert.botId, alert);
      }
    }

    for (const [botId, alert] of perBotBest.entries()) {
      const cdKey = `${botId}:Stuck`;
      const prevSentAt = this.lastNotifiedAt.get(cdKey);
      if (prevSentAt !== undefined && nowMs - prevSentAt < this.stuckCooldownMs) {
        continue;
      }

      const seq = resolveBotSequence(snapshot, botId);
      let rawTitle: string;
      let rawBody: string;
      if (redactMode) {
        rawTitle = s.notifyStuckTitleRedacted;
        rawBody = s.notifyStuckBodyRedacted(seq, alert.elapsedMinutes);
      } else {
        const botName = scrubAll(snapshot.bots[botId].name).trim() || s.botGeneric;
        const cleanTask =
          alert.lastTaskTitle && alert.lastTaskTitle.trim().length > 0
            ? scrubAll(alert.lastTaskTitle).trim()
            : null;
        const cleanTool =
          alert.lastTool && alert.lastTool.trim().length > 0
            ? scrubAll(alert.lastTool).trim()
            : null;
        rawTitle = s.notifyStuckTitle(botName, alert.elapsedMinutes);
        rawBody = s.notifyStuckBody(cleanTask, cleanTool, alert.elapsedMinutes);
      }

      const title = truncateChars(rawTitle.trim() || 'Bot World', MAX_TITLE_CHARS);
      const body = truncateChars(rawBody.trim(), MAX_BODY_CHARS);

      try {
        await orca.host.call('notifications.show', { title, body });
        if (this.lastNotifiedAt.size >= 512) {
          const oldest = this.lastNotifiedAt.keys().next().value;
          if (oldest !== undefined) this.lastNotifiedAt.delete(oldest);
        }
        this.lastNotifiedAt.set(cdKey, nowMs);
        sent.push({ botId, kind: 'Stuck', title, body });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'notification failed';
        try {
          orca.log(`bot-world stuck notification skipped: ${scrubAll(msg)}`);
        } catch {
          // Ignore log failure
        }
      }
    }

    return { sent };
  }
}
