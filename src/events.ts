import { localizeBotErrorMessage, tStrings } from '../shared/i18n.ts';
import { extractSessionIdFromRef } from './normalize.ts';
import { scrubAll } from './redact.ts';
import {
  type ActorRef,
  type InboxMessage,
  type UiLocale,
  type WorldEvent,
  type WorldEventRecord,
  type WorldSnapshot,
  isSafeKey,
  isWorkerActive,
  isWorkerVisibleOnStage,
  safeJsonParse,
} from './types.ts';

function safeOwn<V>(record: Record<string, V>, key: string): V | undefined {
  if (!isSafeKey(key)) return undefined;
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function safeStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function safeNullableStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function safeNum(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function safeNullableNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function isValidWorkerSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

export function extractWorkerSeq(
  record: Pick<WorldEventRecord, 'event' | 'redactedSummary' | 'workerSeq'>
): number | undefined {
  if (isValidWorkerSeq(record.workerSeq)) {
    return record.workerSeq;
  }
  if (record.event && record.event.kind === 'WorkerStart') {
    const summaryMatch = /#(\d+)\b/.exec(safeStr(record.redactedSummary));
    if (summaryMatch && summaryMatch[1]) {
      const parsed = Number(summaryMatch[1]);
      if (isValidWorkerSeq(parsed)) return parsed;
    }
    const providerMatch = /^(?:Worker|도우미)\s*#(\d+)(?:\s*\(.*\))?$/.exec(
      safeStr(record.event.provider).trim()
    );
    if (providerMatch && providerMatch[1]) {
      const parsed = Number(providerMatch[1]);
      if (isValidWorkerSeq(parsed)) return parsed;
    }
  }
  return undefined;
}

export function localizeWorkerLabel(rawLabel: string, locale: UiLocale): string {
  const s = tStrings(locale);
  const trimmed = rawLabel.trim();
  if (trimmed.length === 0 || trimmed === '도우미' || trimmed === 'Worker') {
    return s.workerGeneric;
  }
  const numberedWithProv = /^(?:도우미|Worker)\s*#(\d+)\s*\((.+)\)$/.exec(trimmed);
  if (numberedWithProv && numberedWithProv[1] && numberedWithProv[2]) {
    const seq = Number(numberedWithProv[1]);
    const numbered =
      Number.isSafeInteger(seq) && seq >= 1
        ? s.workerNumbered(seq)
        : `${s.workerGeneric} #${numberedWithProv[1]}`;
    return `${numbered} (${numberedWithProv[2].trim()})`;
  }
  const numberedMatch = /^(?:도우미|Worker)\s*#(\d+)$/.exec(trimmed);
  if (numberedMatch && numberedMatch[1]) {
    const seq = Number(numberedMatch[1]);
    return Number.isSafeInteger(seq) && seq >= 1
      ? s.workerNumbered(seq)
      : `${s.workerGeneric} #${numberedMatch[1]}`;
  }
  const match = /^(?:도우미|Worker)\s*\((.+)\)$/.exec(trimmed);
  if (match && match[1]) {
    return s.workerWithProvider(match[1].trim());
  }
  return rawLabel;
}

export function actorDisplayName(actor: ActorRef, locale: UiLocale = 'en'): string {
  const s = tStrings(locale);
  if (!actor || typeof actor !== 'object') return s.unknownActor;
  switch (actor.kind) {
    case 'Bot':
      return safeStr(actor.botName, s.botGeneric);
    case 'Worker':
      return localizeWorkerLabel(safeStr(actor.label, s.workerGeneric), locale);
    case 'BossDesk':
      return s.ownerActor;
    case 'AutomationBoard':
      return s.landmarks.automationBoard;
    case 'OfficeDoor':
      return s.landmarks.officeDoor;
    case 'Unknown': {
      const raw = safeStr(actor.raw);
      const trimmed = raw.trim();
      if (trimmed.length === 0) return s.unknownActor;
      if (trimmed === '비공개' || trimmed === 'Private') {
        return s.privateLabel;
      }
      return raw;
    }
    default:
      return s.unknownActor;
  }
}

export function actorBotId(actor: ActorRef): string | null {
  return actor && typeof actor === 'object' && actor.kind === 'Bot' ? safeStr(actor.botId) || null : null;
}

export function actorParentOrSelfBotId(actor: ActorRef): string | null {
  if (!actor || typeof actor !== 'object') return null;
  if (actor.kind === 'Bot') return safeStr(actor.botId) || null;
  if (actor.kind === 'Worker') return safeNullableStr(actor.parentBotId);
  return null;
}

export function actorKey(actor: ActorRef): string | null {
  if (!actor || typeof actor !== 'object') return null;
  if (actor.kind === 'Bot') return `bot:${safeStr(actor.botId)}`;
  if (actor.kind === 'Worker') return `worker:${safeStr(actor.dispatchId)}`;
  return null;
}

export function eventRelatedBotId(event: WorldEvent): string | null {
  if (!event || typeof event !== 'object') return null;
  switch (event.kind) {
    case 'Handoff':
    case 'Question':
    case 'StatusReport':
    case 'Reply':
      return actorParentOrSelfBotId(event.from) ?? actorParentOrSelfBotId(event.to);
    case 'WorkerStart':
    case 'WorkerDone':
    case 'WorkerFailed':
    case 'WorkerExited':
    case 'WorkerReleased':
      return safeNullableStr(event.parentBotId);
    case 'Escalation':
      return safeNullableStr(event.targetBotId) ?? actorParentOrSelfBotId(event.actor);
    case 'ApprovalClosed':
      return safeNullableStr(event.parentBotId) ?? actorParentOrSelfBotId(event.actor);
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
      return safeStr(event.botId) || null;
    case 'AutomationRun':
      return safeNullableStr(event.botId);
    default:
      return null;
  }
}

function scrubActor(actor: ActorRef): ActorRef {
  if (!actor || typeof actor !== 'object') {
    return { kind: 'Unknown', raw: '' };
  }
  switch (actor.kind) {
    case 'Bot':
      return {
        kind: 'Bot',
        botId: safeStr(actor.botId),
        botName: scrubAll(safeStr(actor.botName)),
      };
    case 'Worker':
      return {
        kind: 'Worker',
        dispatchId: safeStr(actor.dispatchId),
        parentBotId: safeNullableStr(actor.parentBotId),
        label: scrubAll(safeStr(actor.label)),
      };
    case 'BossDesk':
      return { kind: 'BossDesk' };
    case 'AutomationBoard':
      return { kind: 'AutomationBoard' };
    case 'OfficeDoor':
      return { kind: 'OfficeDoor' };
    case 'Unknown':
      return { kind: 'Unknown', raw: scrubAll(safeStr(actor.raw)) };
    default:
      return { kind: 'Unknown', raw: '' };
  }
}

function redactActorRef(
  actor: ActorRef,
  workerLabelFor?: (dispatchId: string) => string,
  locale: UiLocale = 'en'
): ActorRef {
  const s = tStrings(locale);
  if (!actor || typeof actor !== 'object') {
    return { kind: 'Unknown', raw: s.privateLabel };
  }
  switch (actor.kind) {
    case 'Bot':
      return {
        kind: 'Bot',
        botId: safeStr(actor.botId),
        botName: scrubAll(safeStr(actor.botName)),
      };
    case 'Worker': {
      const dispatchId = safeStr(actor.dispatchId);
      const label = workerLabelFor ? workerLabelFor(dispatchId) : s.workerGeneric;
      return {
        kind: 'Worker',
        dispatchId,
        parentBotId: safeNullableStr(actor.parentBotId),
        label,
      };
    }
    case 'BossDesk':
      return { kind: 'BossDesk' };
    case 'AutomationBoard':
      return { kind: 'AutomationBoard' };
    case 'OfficeDoor':
      return { kind: 'OfficeDoor' };
    case 'Unknown':
    default:
      return { kind: 'Unknown', raw: s.privateLabel };
  }
}

export function redactWorldEvent(
  event: WorldEvent,
  workerLabelFor?: (dispatchId: string) => string,
  locale: UiLocale = 'en'
): WorldEvent {
  const s = tStrings(locale);
  if (!event || typeof event !== 'object') {
    return { kind: 'BotIdle', botId: '', botName: '' };
  }
  switch (event.kind) {
    case 'Handoff':
    case 'Question':
    case 'StatusReport':
    case 'Reply':
      return {
        kind: event.kind,
        messageId: safeStr(event.messageId),
        from: redactActorRef(event.from, workerLabelFor, locale),
        to: redactActorRef(event.to, workerLabelFor, locale),
        subject: '',
      };
    case 'WorkerStart': {
      const dispatchId = safeStr(event.dispatchId);
      return {
        kind: 'WorkerStart',
        dispatchId,
        parentBotId: safeNullableStr(event.parentBotId),
        parentBotName:
          event.parentBotName !== null && event.parentBotName !== undefined
            ? scrubAll(safeStr(event.parentBotName))
            : null,
        provider: workerLabelFor ? workerLabelFor(dispatchId) : s.workerGeneric,
        taskTitle: null,
      };
    }
    case 'WorkerDone':
    case 'WorkerFailed':
      return {
        kind: event.kind,
        dispatchId: safeStr(event.dispatchId),
        parentBotId: safeNullableStr(event.parentBotId),
        parentBotName:
          event.parentBotName !== null && event.parentBotName !== undefined
            ? scrubAll(safeStr(event.parentBotName))
            : null,
        subject: '',
      };
    case 'Escalation':
      return {
        kind: 'Escalation',
        actor: redactActorRef(event.actor, workerLabelFor, locale),
        targetBotId: safeNullableStr(event.targetBotId),
        reason: '',
      };
    case 'ApprovalClosed':
      return {
        kind: 'ApprovalClosed',
        actor: redactActorRef(event.actor, workerLabelFor, locale),
        parentBotId: safeNullableStr(event.parentBotId),
      };
    case 'ItemNeedsYou': {
      const num = safeNum(event.number);
      return {
        kind: 'ItemNeedsYou',
        itemUid: safeStr(event.itemUid),
        number: num,
        botId: safeStr(event.botId),
        botName: scrubAll(safeStr(event.botName)),
        title: `#${num}`,
        optionsCount: safeNum(event.optionsCount),
      };
    }
    case 'BossReplied':
      return {
        kind: 'BossReplied',
        botId: safeStr(event.botId),
        botName: scrubAll(safeStr(event.botName)),
        itemNumber: safeNullableNum(event.itemNumber),
        subject: '',
      };
    case 'ItemDone':
    case 'ItemCanceled': {
      const num = safeNum(event.number);
      return {
        kind: event.kind,
        itemUid: safeStr(event.itemUid),
        number: num,
        botId: safeStr(event.botId),
        botName: scrubAll(safeStr(event.botName)),
        title: `#${num}`,
      };
    }
    case 'BotWorking':
    case 'ToolChanged':
      return {
        kind: event.kind,
        botId: safeStr(event.botId),
        botName: scrubAll(safeStr(event.botName)),
        tool: null,
      };
    case 'BotIdle':
    case 'WaitingAnswer':
    case 'BotPaused':
      return {
        kind: event.kind,
        botId: safeStr(event.botId),
        botName: scrubAll(safeStr(event.botName)),
      };
    case 'BotFailed':
      return {
        kind: 'BotFailed',
        botId: safeStr(event.botId),
        botName: scrubAll(safeStr(event.botName)),
        message: event.message !== null && event.message !== undefined ? s.errorHiddenLabel : null,
      };
    case 'AutomationRun':
      return {
        kind: 'AutomationRun',
        automationId: safeStr(event.automationId),
        automationName: s.automationGeneric,
        botId: safeNullableStr(event.botId),
        botName:
          event.botName !== null && event.botName !== undefined
            ? scrubAll(safeStr(event.botName))
            : null,
        success: Boolean(event.success),
        noReply: Boolean(event.noReply),
        error: event.error !== null && event.error !== undefined ? s.errorHiddenLabel : null,
      };
    case 'WorkerExited':
    case 'WorkerReleased': {
      const dispatchId = safeStr(event.dispatchId);
      return {
        kind: event.kind,
        dispatchId,
        parentBotId: safeNullableStr(event.parentBotId),
        parentBotName:
          event.parentBotName !== null && event.parentBotName !== undefined
            ? scrubAll(safeStr(event.parentBotName))
            : null,
        provider: workerLabelFor ? workerLabelFor(dispatchId) : s.workerGeneric,
      };
    }
    case 'BotJoined':
      return {
        kind: 'BotJoined',
        botId: safeStr(event.botId),
        botName: scrubAll(safeStr(event.botName)),
        specialty: '',
      };
    default:
      return { kind: 'BotIdle', botId: '', botName: '' };
  }
}

export function scrubWorldEvent(event: WorldEvent): WorldEvent {
  if (!event || typeof event !== 'object') {
    return { kind: 'BotIdle', botId: '', botName: '' };
  }
  switch (event.kind) {
    case 'Handoff':
    case 'Question':
    case 'StatusReport':
    case 'Reply':
      return {
        kind: event.kind,
        messageId: safeStr(event.messageId),
        from: scrubActor(event.from),
        to: scrubActor(event.to),
        subject: scrubAll(safeStr(event.subject)),
      };
    case 'WorkerStart':
      return {
        kind: 'WorkerStart',
        dispatchId: safeStr(event.dispatchId),
        parentBotId: safeNullableStr(event.parentBotId),
        parentBotName:
          event.parentBotName !== null && event.parentBotName !== undefined
            ? scrubAll(safeStr(event.parentBotName))
            : null,
        provider: scrubAll(safeStr(event.provider)),
        taskTitle:
          event.taskTitle !== null && event.taskTitle !== undefined
            ? scrubAll(safeStr(event.taskTitle))
            : null,
      };
    case 'WorkerDone':
    case 'WorkerFailed':
      return {
        kind: event.kind,
        dispatchId: safeStr(event.dispatchId),
        parentBotId: safeNullableStr(event.parentBotId),
        parentBotName:
          event.parentBotName !== null && event.parentBotName !== undefined
            ? scrubAll(safeStr(event.parentBotName))
            : null,
        subject: scrubAll(safeStr(event.subject)),
      };
    case 'Escalation':
      return {
        kind: 'Escalation',
        actor: scrubActor(event.actor),
        targetBotId: safeNullableStr(event.targetBotId),
        reason: scrubAll(safeStr(event.reason)),
      };
    case 'ApprovalClosed':
      return {
        kind: 'ApprovalClosed',
        actor: scrubActor(event.actor),
        parentBotId: safeNullableStr(event.parentBotId),
      };
    case 'ItemNeedsYou':
      return {
        kind: 'ItemNeedsYou',
        itemUid: safeStr(event.itemUid),
        number: safeNum(event.number),
        botId: safeStr(event.botId),
        botName: scrubAll(safeStr(event.botName)),
        title: scrubAll(safeStr(event.title)),
        optionsCount: safeNum(event.optionsCount),
      };
    case 'BossReplied':
      return {
        kind: 'BossReplied',
        botId: safeStr(event.botId),
        botName: scrubAll(safeStr(event.botName)),
        itemNumber: safeNullableNum(event.itemNumber),
        subject: scrubAll(safeStr(event.subject)),
      };
    case 'ItemDone':
    case 'ItemCanceled':
      return {
        kind: event.kind,
        itemUid: safeStr(event.itemUid),
        number: safeNum(event.number),
        botId: safeStr(event.botId),
        botName: scrubAll(safeStr(event.botName)),
        title: scrubAll(safeStr(event.title)),
      };
    case 'BotWorking':
    case 'ToolChanged':
      return {
        kind: event.kind,
        botId: safeStr(event.botId),
        botName: scrubAll(safeStr(event.botName)),
        tool:
          event.tool !== null && event.tool !== undefined ? scrubAll(safeStr(event.tool)) : null,
      };
    case 'BotIdle':
    case 'WaitingAnswer':
    case 'BotPaused':
      return {
        kind: event.kind,
        botId: safeStr(event.botId),
        botName: scrubAll(safeStr(event.botName)),
      };
    case 'BotFailed':
      return {
        kind: 'BotFailed',
        botId: safeStr(event.botId),
        botName: scrubAll(safeStr(event.botName)),
        message:
          event.message !== null && event.message !== undefined
            ? scrubAll(safeStr(event.message))
            : null,
      };
    case 'AutomationRun':
      return {
        kind: 'AutomationRun',
        automationId: safeStr(event.automationId),
        automationName: scrubAll(safeStr(event.automationName)),
        botId: safeNullableStr(event.botId),
        botName:
          event.botName !== null && event.botName !== undefined
            ? scrubAll(safeStr(event.botName))
            : null,
        success: Boolean(event.success),
        noReply: Boolean(event.noReply),
        error:
          event.error !== null && event.error !== undefined ? scrubAll(safeStr(event.error)) : null,
      };
    case 'WorkerExited':
    case 'WorkerReleased':
      return {
        kind: event.kind,
        dispatchId: safeStr(event.dispatchId),
        parentBotId: safeNullableStr(event.parentBotId),
        parentBotName:
          event.parentBotName !== null && event.parentBotName !== undefined
            ? scrubAll(safeStr(event.parentBotName))
            : null,
        provider: scrubAll(safeStr(event.provider)),
      };
    case 'BotJoined':
      return {
        kind: 'BotJoined',
        botId: safeStr(event.botId),
        botName: scrubAll(safeStr(event.botName)),
        specialty: scrubAll(safeStr(event.specialty)),
      };
    default:
      return { kind: 'BotIdle', botId: '', botName: '' };
  }
}

function truncateChars(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, maxChars).join('')}…`;
}

export function formatEventSummaries(
  event: WorldEvent,
  workerSeqHint = 1,
  locale: UiLocale = 'en'
): [string, string] {
  const s = tStrings(locale);
  const isKo = locale === 'ko';
  if (!event || typeof event !== 'object') {
    return [s.recordedEventFallback, s.recordedEventFallback];
  }
  switch (event.kind) {
    case 'Handoff': {
      const fromName = scrubAll(actorDisplayName(event.from, locale));
      const toName = scrubAll(actorDisplayName(event.to, locale));
      const subj = truncateChars(scrubAll(safeStr(event.subject)), 28);
      if (isKo) {
        const normal = subj.length === 0 ? `인계: ${fromName} → ${toName}` : `인계: ${subj}`;
        const redacted = `${fromName} → ${toName}: 업무 인계`;
        return [normal, redacted];
      }
      const normal = subj.length === 0 ? `Handoff: ${fromName} → ${toName}` : `Handoff: ${subj}`;
      const redacted = `${fromName} → ${toName}: Task handoff`;
      return [normal, redacted];
    }
    case 'Question': {
      const subj = truncateChars(scrubAll(safeStr(event.subject)), 26);
      if (isKo) {
        return [subj.length === 0 ? '? 질문' : `? ${subj}`, '? 질문'];
      }
      return [subj.length === 0 ? '? Question' : `? ${subj}`, '? Question'];
    }
    case 'StatusReport': {
      const subj = truncateChars(scrubAll(safeStr(event.subject)), 26);
      if (isKo) {
        return [subj.length === 0 ? '상태 보고' : `보고: ${subj}`, '상태 보고'];
      }
      return [subj.length === 0 ? 'Status report' : `Report: ${subj}`, 'Status report'];
    }
    case 'Reply': {
      const subj = truncateChars(scrubAll(safeStr(event.subject)), 26);
      if (isKo) {
        return [subj.length === 0 ? '회신 전달' : `회신: ${subj}`, '회신 전달'];
      }
      return [subj.length === 0 ? 'Reply sent' : `Reply: ${subj}`, 'Reply sent'];
    }
    case 'WorkerStart': {
      const cleanProv = localizeWorkerLabel(
        scrubAll(safeStr(event.provider, s.workerGeneric)),
        locale
      );
      const rawTitle = safeNullableStr(event.taskTitle);
      const t = rawTitle && rawTitle.trim().length > 0 ? rawTitle : null;
      const normal = isKo
        ? t
          ? `도우미(${cleanProv}): ${truncateChars(scrubAll(t), 22)}`
          : `도우미 시작 (${cleanProv})`
        : t
          ? `Worker(${cleanProv}): ${truncateChars(scrubAll(t), 22)}`
          : `Worker started (${cleanProv})`;
      return [normal, s.workerNumbered(workerSeqHint)];
    }
    case 'WorkerDone': {
      const rawSubj = safeStr(event.subject);
      const subj =
        rawSubj === '완료 보고' || rawSubj === 'Completed'
          ? ''
          : truncateChars(scrubAll(rawSubj), 24);
      if (isKo) {
        return [subj.length === 0 ? '완료 보고' : `완료: ${subj}`, '완료 보고'];
      }
      return [subj.length === 0 ? 'Completed' : `Done: ${subj}`, 'Completed'];
    }
    case 'WorkerFailed': {
      const rawSubj = safeStr(event.subject);
      const subj =
        rawSubj === '작업 실패' || rawSubj === 'Task failed'
          ? ''
          : truncateChars(scrubAll(rawSubj), 24);
      if (isKo) {
        return [subj.length === 0 ? '작업 실패' : `실패: ${subj}`, '작업 실패'];
      }
      return [subj.length === 0 ? 'Task failed' : `Failed: ${subj}`, 'Task failed'];
    }
    case 'Escalation': {
      const rawReason = safeStr(event.reason);
      const clean =
        rawReason === '승인/개입 필요' || rawReason === '승인/차단' || rawReason === 'Needs approval'
          ? ''
          : truncateChars(scrubAll(rawReason), 24);
      if (isKo) {
        return [clean.length === 0 ? '승인/개입 필요' : `개입 필요: ${clean}`, '승인/개입 필요'];
      }
      return [clean.length === 0 ? 'Needs approval' : `Needs help: ${clean}`, 'Needs approval'];
    }
    case 'ApprovalClosed':
      return isKo ? ['승인 완료 · 재개', '재개'] : ['Approved · Resumed', 'Resumed'];
    case 'ItemNeedsYou': {
      const num = safeNum(event.number);
      const cleanTitle = truncateChars(scrubAll(safeStr(event.title)), 22);
      if (isKo) {
        const normal =
          cleanTitle.length === 0
            ? `결정 대기 (#${num})`
            : `결정 대기 (#${num}): ${cleanTitle}`;
        return [normal, `결정 대기 (#${num})`];
      }
      const normal =
        cleanTitle.length === 0
          ? `Needs you (#${num})`
          : `Needs you (#${num}): ${cleanTitle}`;
      return [normal, `Needs you (#${num})`];
    }
    case 'BossReplied': {
      const itemNumber = safeNullableNum(event.itemNumber);
      if (itemNumber !== null) {
        return isKo
          ? [`사장님 응답 (#${itemNumber})`, `사장님 응답 (#${itemNumber})`]
          : [`Owner replied (#${itemNumber})`, `Owner replied (#${itemNumber})`];
      }
      const subj = truncateChars(scrubAll(safeStr(event.subject)), 22);
      if (isKo) {
        return [subj.length === 0 ? '사장님 응답' : `사장님 응답: ${subj}`, '사장님 응답'];
      }
      return [subj.length === 0 ? 'Owner replied' : `Owner replied: ${subj}`, 'Owner replied'];
    }
    case 'ItemDone': {
      const num = safeNum(event.number);
      const cleanTitle = truncateChars(scrubAll(safeStr(event.title)), 22);
      if (isKo) {
        const normal =
          cleanTitle.length === 0
            ? `항목 완료 (#${num})`
            : `항목 완료 (#${num}): ${cleanTitle}`;
        return [normal, `항목 완료 (#${num})`];
      }
      const normal =
        cleanTitle.length === 0
          ? `Item done (#${num})`
          : `Item done (#${num}): ${cleanTitle}`;
      return [normal, `Item done (#${num})`];
    }
    case 'ItemCanceled': {
      const num = safeNum(event.number);
      const cleanTitle = truncateChars(scrubAll(safeStr(event.title)), 22);
      if (isKo) {
        const normal =
          cleanTitle.length === 0
            ? `항목 취소 (#${num})`
            : `항목 취소 (#${num}): ${cleanTitle}`;
        return [normal, `항목 취소 (#${num})`];
      }
      const normal =
        cleanTitle.length === 0
          ? `Item canceled (#${num})`
          : `Item canceled (#${num}): ${cleanTitle}`;
      return [normal, `Item canceled (#${num})`];
    }
    case 'BotWorking': {
      const rawTool = safeNullableStr(event.tool);
      const t = rawTool && rawTool.trim().length > 0 ? rawTool : null;
      if (isKo) {
        return [t ? `작업 중 (${scrubAll(t)})` : '작업 중', '작업 중'];
      }
      return [t ? `Working (${scrubAll(t)})` : 'Working', 'Working'];
    }
    case 'ToolChanged': {
      const rawTool = safeNullableStr(event.tool);
      const t = rawTool && rawTool.trim().length > 0 ? rawTool : null;
      if (isKo) {
        return [t ? `도구 전환: ${scrubAll(t)}` : '작업 중', '작업 중'];
      }
      return [t ? `Tool: ${scrubAll(t)}` : 'Working', 'Working'];
    }
    case 'BotIdle':
      return isKo ? ['대기 중', '대기 중'] : ['Idle', 'Idle'];
    case 'WaitingAnswer':
      return isKo ? ['응답 대기', '응답 대기'] : ['Waiting for reply', 'Waiting for reply'];
    case 'BotFailed': {
      const rawMsg = safeNullableStr(event.message);
      const trimmed = rawMsg && rawMsg.trim().length > 0 ? rawMsg.trim() : null;
      const m = trimmed ? localizeBotErrorMessage(trimmed, locale) : null;
      if (isKo) {
        return [m ? `오류: ${truncateChars(scrubAll(m), 24)}` : '오류 발생', '오류 발생'];
      }
      return [m ? `Error: ${truncateChars(scrubAll(m), 24)}` : 'Error occurred', 'Error occurred'];
    }
    case 'AutomationRun': {
      const name = truncateChars(scrubAll(safeStr(event.automationName)), 20);
      if (isKo) {
        const normal = event.success
          ? event.noReply
            ? `정기 점검 이상 없음: ${name}`
            : `정기 점검 완료: ${name}`
          : `정기 점검 실패: ${name}`;
        const redacted = event.success ? '정기 점검 완료' : '정기 점검 실패';
        return [normal, redacted];
      }
      const normal = event.success
        ? event.noReply
          ? `Check OK: ${name}`
          : `Check done: ${name}`
        : `Check failed: ${name}`;
      const redacted = event.success ? 'Automation done' : 'Automation failed';
      return [normal, redacted];
    }
    case 'BotPaused':
      return isKo ? ['일시 정지', '일시 정지'] : ['Paused', 'Paused'];
    case 'WorkerExited':
      return isKo ? ['도우미 종료', '도우미 퇴장'] : ['Worker exited', 'Worker left'];
    case 'WorkerReleased':
      return isKo ? ['도우미 퇴장', '도우미 퇴장'] : ['Worker left', 'Worker left'];
    case 'BotJoined': {
      const cleanName = scrubAll(safeStr(event.botName));
      return isKo
        ? [`새 봇 합류: ${cleanName}`, `새 봇 합류 (${cleanName})`]
        : [`Bot joined: ${cleanName}`, `Bot joined (${cleanName})`];
    }
    default:
      return [s.recordedEventFallback, s.recordedEventFallback];
  }
}

export function eventTitle(event: WorldEvent, locale: UiLocale = 'en'): string {
  return formatEventSummaries(event, 1, locale)[0];
}

export function summarizeEvent(
  event: WorldEvent,
  redactMode: boolean,
  locale: UiLocale = 'en',
  workerSeqHint = 1
): string {
  const [normal, redacted] = formatEventSummaries(event, workerSeqHint, locale);
  return redactMode ? redacted : normal;
}

export function createEventRecord(
  event: WorldEvent,
  timestampMs: number,
  workerSeqHint = 1,
  locale: UiLocale = 'en'
): WorldEventRecord {
  const scrubbedEvent = scrubWorldEvent(event);
  const validSeq = isValidWorkerSeq(workerSeqHint) ? workerSeqHint : 1;
  const [summary, redactedSummary] = formatEventSummaries(scrubbedEvent, validSeq, locale);
  const record: WorldEventRecord = {
    timestampMs,
    summary: scrubAll(summary),
    redactedSummary: scrubAll(redactedSummary),
    event: scrubbedEvent,
  };
  if (scrubbedEvent.kind === 'WorkerStart') {
    record.workerSeq = validSeq;
  }
  return record;
}

function isNewInboxMessage(prev: WorldSnapshot, msg: InboxMessage): boolean {
  if (
    prev.inboxCursor.seenIds.includes(msg.id) ||
    prev.recentMessages.some((pm) => pm.id === msg.id)
  ) {
    return false;
  }
  return (
    prev.inboxCursor.lastSequence === 0 ||
    msg.sequence >= prev.inboxCursor.lastSequence ||
    prev.inboxCursor.needsBackfill
  );
}

function isApprovalClosedMessage(msg: InboxMessage): boolean {
  const subj = msg.subject.toLowerCase();
  const body = msg.body.toLowerCase();
  return (
    subj.includes('worker approval closed') ||
    body.includes('worker approval closed') ||
    msg.msgType === 'approval_closed'
  );
}

function isReplyStatusMessage(
  msg: InboxMessage,
  payloadJson: Record<string, unknown> | null
): boolean {
  if (msg.subject.startsWith('Re:') || msg.subject.startsWith('re:')) return true;
  if (msg.toHandle.startsWith('dispatch:') || msg.toHandle.startsWith('term_')) return true;
  if (payloadJson && (payloadJson.requestId !== undefined || payloadJson.botAnswer !== undefined)) {
    return true;
  }
  return false;
}

function extractItemNumberFromSubject(subject: string): number | null {
  const marker = 'item ';
  const idx = subject.indexOf(marker);
  if (idx < 0) return null;
  const rest = subject.slice(idx + marker.length);
  const m = /^[0-9]+/.exec(rest);
  if (!m) return null;
  const num = Number(m[0]);
  return Number.isSafeInteger(num) ? num : null;
}

export function resolveRunBot(
  runId: string | null,
  prev: WorldSnapshot,
  next: WorldSnapshot
): string | null {
  if (!runId) return null;
  const rid = runId.trim();
  if (rid.length === 0 || rid === 'run_unbound') return null;
  const indexed = safeOwn(next.runBotIndex, rid) ?? safeOwn(prev.runBotIndex, rid);
  if (indexed) return indexed;

  for (const w of [...Object.values(next.workers), ...Object.values(prev.workers)]) {
    if (w.runId === rid) {
      if (w.parentBotId) return w.parentBotId;
      if (w.parentBotName) {
        const bot = [...Object.values(next.bots), ...Object.values(prev.bots)].find(
          (b) => b.name === w.parentBotName
        );
        if (bot) return bot.id;
      }
    }
  }
  return null;
}

export function resolveHandle(
  handle: string,
  runId: string | null,
  prev: WorldSnapshot,
  next: WorldSnapshot,
  locale: UiLocale = 'en'
): ActorRef {
  const s = tStrings(locale);
  if (handle === 'orca:items') {
    return { kind: 'BossDesk' };
  }

  const sessionId = extractSessionIdFromRef(handle);
  if (sessionId) {
    const botId = safeOwn(next.chatIndex, sessionId) ?? safeOwn(prev.chatIndex, sessionId);
    if (botId) {
      const bot = safeOwn(next.bots, botId) ?? safeOwn(prev.bots, botId);
      if (bot) {
        return { kind: 'Bot', botId: bot.id, botName: scrubAll(bot.name) };
      }
    }
    const directBot = safeOwn(next.bots, sessionId) ?? safeOwn(prev.bots, sessionId);
    if (directBot) {
      return { kind: 'Bot', botId: directBot.id, botName: scrubAll(directBot.name) };
    }
  }

  if (handle.startsWith('dispatch:')) {
    const dispatchId = handle.slice('dispatch:'.length);
    const w = safeOwn(next.workers, dispatchId) ?? safeOwn(prev.workers, dispatchId);
    if (w) {
      return {
        kind: 'Worker',
        dispatchId: w.dispatchId,
        parentBotId: w.parentBotId ?? resolveRunBot(w.runId ?? runId, prev, next),
        label: s.workerWithProvider(scrubAll(w.provider)),
      };
    }
    return {
      kind: 'Worker',
      dispatchId,
      parentBotId: resolveRunBot(runId, prev, next),
      label: s.workerGeneric,
    };
  }

  if (handle.startsWith('term_')) {
    const candidates = [
      ...Object.values(next.workers).map((w) => ({ w, fromNext: true })),
      ...Object.values(prev.workers)
        .filter((w) => !safeOwn(next.workers, w.dispatchId))
        .map((w) => ({ w, fromNext: false })),
    ].filter((c) => c.w.terminalHandle === handle);

    candidates.sort((a, b) => {
      const activeDiff = Number(isWorkerActive(b.w)) - Number(isWorkerActive(a.w));
      if (activeDiff !== 0) return activeDiff;
      const visDiff = Number(isWorkerVisibleOnStage(b.w)) - Number(isWorkerVisibleOnStage(a.w));
      if (visDiff !== 0) return visDiff;
      const tsDiff = (b.w.updatedAt ?? -Infinity) - (a.w.updatedAt ?? -Infinity);
      if (tsDiff !== 0) return tsDiff;
      return Number(b.fromNext) - Number(a.fromNext);
    });

    const best = candidates[0]?.w;
    if (best) {
      return {
        kind: 'Worker',
        dispatchId: best.dispatchId,
        parentBotId: best.parentBotId ?? resolveRunBot(best.runId ?? runId, prev, next),
        label: s.workerWithProvider(scrubAll(best.provider)),
      };
    }
    return {
      kind: 'Worker',
      dispatchId: handle,
      parentBotId: resolveRunBot(runId, prev, next),
      label: s.workerGeneric,
    };
  }

  if (handle.startsWith('run:')) {
    const rid = handle.slice('run:'.length);
    if (rid !== 'run_unbound') {
      const botId = resolveRunBot(rid, prev, next);
      if (botId) {
        const bot = safeOwn(next.bots, botId) ?? safeOwn(prev.bots, botId);
        if (bot) {
          return { kind: 'Bot', botId: bot.id, botName: scrubAll(bot.name) };
        }
      }
    }
  }

  const byKey =
    safeOwn(next.bots, handle) ??
    safeOwn(prev.bots, handle) ??
    [...Object.values(next.bots), ...Object.values(prev.bots)].find((b) => b.name === handle);
  if (byKey) {
    return { kind: 'Bot', botId: byKey.id, botName: scrubAll(byKey.name) };
  }

  if (runId && runId !== 'run_unbound') {
    const botId = resolveRunBot(runId, prev, next);
    if (botId) {
      const bot = safeOwn(next.bots, botId) ?? safeOwn(prev.bots, botId);
      if (bot) {
        return { kind: 'Bot', botId: bot.id, botName: scrubAll(bot.name) };
      }
    }
  }

  return { kind: 'Unknown', raw: scrubAll(handle) };
}

export function diffSnapshots(
  prev: WorldSnapshot,
  next: WorldSnapshot,
  suppress: boolean,
  locale: UiLocale = 'en'
): WorldEvent[] {
  const s = tStrings(locale);
  const runtimeChanged =
    prev.runtime.runtimeId !== null &&
    next.runtime.runtimeId !== null &&
    prev.runtime.runtimeId !== next.runtime.runtimeId;
  if (suppress || next.rebaselineNeeded || runtimeChanged) {
    return [];
  }

  const events: WorldEvent[] = [];
  const emittedWorkerDone = new Set<string>();
  const emittedWorkerFailed = new Set<string>();
  const emittedEscalationKeys = new Set<string>();
  const emittedApprovalKeys = new Set<string>();
  const emittedBossRepliedBots = new Set<string>();
  const emittedItemClosedBots = new Set<string>();
  const emittedBotFailed = new Set<string>();

  // 18) BotJoined
  for (const [botId, bot] of Object.entries(next.bots)) {
    if (!safeOwn(prev.bots, botId)) {
      events.push({
        kind: 'BotJoined',
        botId,
        botName: scrubAll(bot.name),
        specialty: scrubAll(bot.specialty),
      });
    }
  }

  // 1~4, 6~9, 11) Inbox events
  for (const msg of next.recentMessages) {
    if (!isNewInboxMessage(prev, msg)) continue;

    let payloadJson: Record<string, unknown> | null = null;
    if (msg.payload) {
      try {
        const parsed = safeJsonParse<unknown>(msg.payload, 128 * 1024);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          payloadJson = parsed as Record<string, unknown>;
        }
      } catch {
        payloadJson = null;
      }
    }

    let from = resolveHandle(msg.fromHandle, msg.runId, prev, next, locale);
    const to = resolveHandle(msg.toHandle, msg.runId, prev, next, locale);

    if (from.kind === 'Worker' && from.parentBotId === null) {
      from = {
        ...from,
        parentBotId: actorBotId(to) ?? resolveRunBot(msg.runId, prev, next),
      };
    }

    const subject = scrubAll(msg.subject);

    if (isApprovalClosedMessage(msg)) {
      const targetActor =
        to.kind === 'Worker' &&
        (from.kind === 'BossDesk' || from.kind === 'Bot' || from.kind === 'Unknown')
          ? to
          : from.kind === 'Worker' || from.kind === 'Bot'
            ? from
            : to.kind !== 'Unknown'
              ? to
              : from;

      const parentBotId =
        actorParentOrSelfBotId(targetActor) ??
        actorParentOrSelfBotId(to) ??
        resolveRunBot(msg.runId, prev, next);

      const key = actorKey(targetActor);
      if (key) emittedApprovalKeys.add(key);
      events.push({
        kind: 'ApprovalClosed',
        actor: targetActor,
        parentBotId,
      });
      continue;
    }

    if (msg.fromHandle === 'orca:items') {
      const botId = actorBotId(to) ?? msg.toHandle;
      const botObj = safeOwn(next.bots, botId) ?? safeOwn(prev.bots, botId);
      const botName = botObj ? scrubAll(botObj.name) : actorDisplayName(to, locale);
      let itemNumber: number | null = null;
      if (payloadJson && Array.isArray(payloadJson.botItems) && payloadJson.botItems.length > 0) {
        const first = payloadJson.botItems[0];
        if (first && typeof first === 'object' && typeof (first as Record<string, unknown>).number === 'number') {
          itemNumber = (first as Record<string, unknown>).number as number;
        }
      }
      if (itemNumber === null) {
        itemNumber = extractItemNumberFromSubject(subject);
      }
      emittedBossRepliedBots.add(botId);
      events.push({
        kind: 'BossReplied',
        botId,
        botName,
        itemNumber,
        subject,
      });
      continue;
    }

    switch (msg.msgType) {
      case 'handoff':
        events.push({ kind: 'Handoff', messageId: msg.id, from, to, subject });
        break;
      case 'question':
        events.push({ kind: 'Question', messageId: msg.id, from, to, subject });
        break;
      case 'worker_done': {
        const dispatchId =
          (payloadJson && typeof payloadJson.dispatchId === 'string'
            ? payloadJson.dispatchId
            : null) ??
          (from.kind === 'Worker' ? from.dispatchId : null) ??
          scrubAll(msg.fromHandle);

        const parentBotId =
          (from.kind === 'Worker' ? from.parentBotId : null) ??
          actorBotId(to) ??
          resolveRunBot(msg.runId, prev, next);

        const parentBotObj = parentBotId
          ? (safeOwn(next.bots, parentBotId) ?? safeOwn(prev.bots, parentBotId))
          : undefined;
        const parentBotName = parentBotObj ? scrubAll(parentBotObj.name) : null;
        const outcome =
          payloadJson && typeof payloadJson.outcome === 'string' ? payloadJson.outcome : null;

        if (outcome === 'failed') {
          emittedWorkerFailed.add(dispatchId);
          events.push({ kind: 'WorkerFailed', dispatchId, parentBotId, parentBotName, subject });
        } else {
          emittedWorkerDone.add(dispatchId);
          events.push({ kind: 'WorkerDone', dispatchId, parentBotId, parentBotName, subject });
        }
        break;
      }
      case 'escalation': {
        const targetBotId =
          actorBotId(to) ?? actorParentOrSelfBotId(from) ?? resolveRunBot(msg.runId, prev, next);
        const key = actorKey(from);
        if (key) emittedEscalationKeys.add(key);
        events.push({ kind: 'Escalation', actor: from, targetBotId, reason: subject });
        break;
      }
      case 'status': {
        if (isReplyStatusMessage(msg, payloadJson)) {
          events.push({ kind: 'Reply', messageId: msg.id, from, to, subject });
        } else {
          events.push({ kind: 'StatusReport', messageId: msg.id, from, to, subject });
        }
        break;
      }
      default:
        break;
    }
  }

  // 5~9, 15, 17) Worker transitions
  for (const [dispatchId, nextW] of Object.entries(next.workers)) {
    const prevW = safeOwn(prev.workers, dispatchId);
    const parentBotId =
      nextW.parentBotId ?? (nextW.runId ? resolveRunBot(nextW.runId, prev, next) : null);
    const parentBotObj = parentBotId
      ? (safeOwn(next.bots, parentBotId) ?? safeOwn(prev.bots, parentBotId))
      : undefined;
    const parentBotName =
      nextW.parentBotName ?? (parentBotObj ? scrubAll(parentBotObj.name) : null);

    const wasActive = prevW ? isWorkerActive(prevW) : false;
    if (isWorkerActive(nextW) && !wasActive) {
      events.push({
        kind: 'WorkerStart',
        dispatchId,
        parentBotId,
        parentBotName,
        provider: scrubAll(nextW.provider),
        taskTitle: nextW.taskTitle !== null ? scrubAll(nextW.taskTitle) : null,
      });
    }

    if (
      nextW.workerState === 'succeeded' &&
      prevW &&
      prevW.workerState !== 'succeeded' &&
      !emittedWorkerDone.has(dispatchId)
    ) {
      emittedWorkerDone.add(dispatchId);
      events.push({
        kind: 'WorkerDone',
        dispatchId,
        parentBotId,
        parentBotName,
        subject: nextW.taskTitle !== null ? scrubAll(nextW.taskTitle) : '',
      });
    } else if (
      (nextW.workerState === 'failed' || nextW.dispatchStatus === 'dispatch_failed') &&
      (!prevW || (prevW.workerState !== 'failed' && prevW.dispatchStatus !== 'dispatch_failed')) &&
      !emittedWorkerFailed.has(dispatchId)
    ) {
      emittedWorkerFailed.add(dispatchId);
      events.push({
        kind: 'WorkerFailed',
        dispatchId,
        parentBotId,
        parentBotName,
        subject: nextW.taskTitle !== null ? scrubAll(nextW.taskTitle) : '',
      });
    }

    const prevBlocked = prevW ? prevW.activity === 'blocked' : false;
    const nextBlocked = nextW.activity === 'blocked';
    const workerActor: ActorRef = {
      kind: 'Worker',
      dispatchId,
      parentBotId,
      label: s.workerWithProvider(scrubAll(nextW.provider)),
    };
    const workerKey = `worker:${dispatchId}`;
    if (!prevBlocked && nextBlocked && !emittedEscalationKeys.has(workerKey)) {
      emittedEscalationKeys.add(workerKey);
      events.push({
        kind: 'Escalation',
        actor: workerActor,
        targetBotId: parentBotId,
        reason: nextW.taskTitle !== null ? scrubAll(nextW.taskTitle) : '',
      });
    } else if (prevBlocked && !nextBlocked && !emittedApprovalKeys.has(workerKey)) {
      emittedApprovalKeys.add(workerKey);
      events.push({
        kind: 'ApprovalClosed',
        actor: workerActor,
        parentBotId,
      });
    }

    if (
      nextW.terminalState === 'released' &&
      prevW &&
      prevW.terminalState !== 'released'
    ) {
      events.push({
        kind: 'WorkerReleased',
        dispatchId,
        parentBotId,
        parentBotName,
        provider: scrubAll(nextW.provider),
      });
    } else if (nextW.liveness === 'Exited' && prevW && prevW.liveness !== 'Exited') {
      events.push({
        kind: 'WorkerExited',
        dispatchId,
        parentBotId,
        parentBotName,
        provider: scrubAll(nextW.provider),
      });
    }
  }

  // 10~12) Bot Item transitions
  for (const [uid, nextItem] of Object.entries(next.items)) {
    const prevItem = safeOwn(prev.items, uid);
    const prevStatus = prevItem?.status ?? null;
    const botId = nextItem.ownerBotId;
    const botObj = safeOwn(next.bots, botId);
    const botName = botObj ? scrubAll(botObj.name) : scrubAll(nextItem.ownerBotName);
    const title = scrubAll(nextItem.title);

    if (nextItem.status === 'needs_you' && prevStatus !== 'needs_you') {
      events.push({
        kind: 'ItemNeedsYou',
        itemUid: uid,
        number: nextItem.number,
        botId,
        botName,
        title,
        optionsCount: nextItem.optionsCount,
      });
    } else if (nextItem.status === 'done' && prevStatus !== null && prevStatus !== 'done') {
      emittedItemClosedBots.add(botId);
      events.push({ kind: 'ItemDone', itemUid: uid, number: nextItem.number, botId, botName, title });
    } else if (nextItem.status === 'canceled' && prevStatus !== null && prevStatus !== 'canceled') {
      emittedItemClosedBots.add(botId);
      events.push({
        kind: 'ItemCanceled',
        itemUid: uid,
        number: nextItem.number,
        botId,
        botName,
        title,
      });
    } else if (
      prevStatus === 'needs_you' &&
      nextItem.status !== 'needs_you' &&
      !emittedBossRepliedBots.has(botId)
    ) {
      emittedBossRepliedBots.add(botId);
      events.push({
        kind: 'BossReplied',
        botId,
        botName,
        itemNumber: nextItem.number,
        subject: title,
      });
    }
  }

  // 8, 9, 13, 14, 15, 17a) Bot status transitions
  for (const [botId, nextBot] of Object.entries(next.bots)) {
    const prevBot = safeOwn(prev.bots, botId);
    if (!prevBot) continue;
    const botName = scrubAll(nextBot.name);
    const botActor: ActorRef = { kind: 'Bot', botId, botName };
    const botKey = `bot:${botId}`;

    if (prevBot.status.kind !== 'Paused' && nextBot.status.kind === 'Paused') {
      events.push({ kind: 'BotPaused', botId, botName });
    }

    if (
      nextBot.status.kind === 'Blocked' &&
      prevBot.status.kind !== 'Blocked' &&
      !emittedEscalationKeys.has(botKey)
    ) {
      emittedEscalationKeys.add(botKey);
      events.push({
        kind: 'Escalation',
        actor: botActor,
        targetBotId: botId,
        reason: nextBot.status.reason !== null ? scrubAll(nextBot.status.reason) : '',
      });
    } else if (
      prevBot.status.kind === 'Blocked' &&
      nextBot.status.kind !== 'Blocked' &&
      !emittedApprovalKeys.has(botKey)
    ) {
      emittedApprovalKeys.add(botKey);
      events.push({
        kind: 'ApprovalClosed',
        actor: botActor,
        parentBotId: botId,
      });
    }

    if (nextBot.status.kind === 'Error' && prevBot.status.kind !== 'Error') {
      emittedBotFailed.add(botId);
      events.push({
        kind: 'BotFailed',
        botId,
        botName,
        message: nextBot.status.message !== null ? scrubAll(nextBot.status.message) : null,
      });
    }

    if (
      prevBot.status.kind === 'NeedsOwner' &&
      nextBot.status.kind !== 'NeedsOwner' &&
      !emittedBossRepliedBots.has(botId) &&
      !emittedItemClosedBots.has(botId)
    ) {
      emittedBossRepliedBots.add(botId);
      events.push({
        kind: 'BossReplied',
        botId,
        botName,
        itemNumber: null,
        subject: nextBot.currentTaskTitle !== null ? scrubAll(nextBot.currentTaskTitle) : '',
      });
    }

    if (prevBot.status.kind === 'Working' && nextBot.status.kind === 'Working') {
      if (prevBot.status.tool !== nextBot.status.tool) {
        events.push({
          kind: 'ToolChanged',
          botId,
          botName,
          tool: nextBot.status.tool !== null ? scrubAll(nextBot.status.tool) : null,
        });
      }
    } else if (nextBot.status.kind === 'Working') {
      events.push({
        kind: 'BotWorking',
        botId,
        botName,
        tool: nextBot.status.tool !== null ? scrubAll(nextBot.status.tool) : null,
      });
    } else if (nextBot.status.kind === 'WaitingAnswer' && prevBot.status.kind !== 'WaitingAnswer') {
      events.push({ kind: 'WaitingAnswer', botId, botName });
    } else if (
      (prevBot.status.kind === 'Working' || prevBot.status.kind === 'WaitingAnswer') &&
      nextBot.status.kind === 'Idle'
    ) {
      events.push({ kind: 'BotIdle', botId, botName });
    }
  }

  // 16) AutomationRun
  for (const [autoId, nextAuto] of Object.entries(next.automations)) {
    const prevAuto = safeOwn(prev.automations, autoId);
    const runIdChanged = nextAuto.lastRunId !== null && nextAuto.lastRunId !== (prevAuto?.lastRunId ?? null);
    const runAtChanged = nextAuto.lastRunAt !== null && nextAuto.lastRunAt !== (prevAuto?.lastRunAt ?? null);
    const statusChanged =
      nextAuto.lastRunStatus !== null && nextAuto.lastRunStatus !== (prevAuto?.lastRunStatus ?? null);

    if (!(runIdChanged || runAtChanged || statusChanged)) continue;
    const status = nextAuto.lastRunStatus;
    if (status !== 'completed' && status !== 'dispatch_failed' && status !== 'failed') continue;

    const success = status === 'completed';
    const botObj = nextAuto.botId
      ? (safeOwn(next.bots, nextAuto.botId) ?? safeOwn(prev.bots, nextAuto.botId))
      : undefined;
    const botName = botObj ? scrubAll(botObj.name) : null;
    const error = nextAuto.lastError !== null ? scrubAll(nextAuto.lastError) : null;

    if (status === 'dispatch_failed' && nextAuto.botId && botName && !emittedBotFailed.has(nextAuto.botId)) {
      emittedBotFailed.add(nextAuto.botId);
      events.push({
        kind: 'BotFailed',
        botId: nextAuto.botId,
        botName,
        message: error ?? s.automationDispatchFailedLabel,
      });
    }

    events.push({
      kind: 'AutomationRun',
      automationId: autoId,
      automationName: scrubAll(nextAuto.name),
      botId: nextAuto.botId,
      botName,
      success,
      noReply: nextAuto.lastRunNoReply,
      error,
    });
  }

  return events;
}
