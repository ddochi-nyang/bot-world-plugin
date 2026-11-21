import { extractSessionIdFromRef } from './normalize.ts';
import { scrubAll } from './redact.ts';
import {
  type ActorRef,
  type InboxMessage,
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

export function actorDisplayName(actor: ActorRef): string {
  if (!actor || typeof actor !== 'object') return '알 수 없음';
  switch (actor.kind) {
    case 'Bot':
      return safeStr(actor.botName, '봇');
    case 'Worker':
      return safeStr(actor.label, '도우미');
    case 'BossDesk':
      return '사장님';
    case 'AutomationBoard':
      return '자동화 보드';
    case 'OfficeDoor':
      return '출입구';
    case 'Unknown': {
      const raw = safeStr(actor.raw);
      return raw.length === 0 ? '알 수 없음' : raw;
    }
    default:
      return '알 수 없음';
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
        label: scrubAll(safeStr(actor.label, '도우미')),
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

function redactActorRef(actor: ActorRef, workerLabelFor?: (dispatchId: string) => string): ActorRef {
  if (!actor || typeof actor !== 'object') {
    return { kind: 'Unknown', raw: '비공개' };
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
      const label = workerLabelFor ? workerLabelFor(dispatchId) : '도우미';
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
      return { kind: 'Unknown', raw: '비공개' };
  }
}

export function redactWorldEvent(
  event: WorldEvent,
  workerLabelFor?: (dispatchId: string) => string
): WorldEvent {
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
        from: redactActorRef(event.from, workerLabelFor),
        to: redactActorRef(event.to, workerLabelFor),
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
        provider: workerLabelFor ? workerLabelFor(dispatchId) : '도우미',
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
        actor: redactActorRef(event.actor, workerLabelFor),
        targetBotId: safeNullableStr(event.targetBotId),
        reason: '',
      };
    case 'ApprovalClosed':
      return {
        kind: 'ApprovalClosed',
        actor: redactActorRef(event.actor, workerLabelFor),
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
        message: event.message !== null && event.message !== undefined ? '오류 상세 가려짐' : null,
      };
    case 'AutomationRun':
      return {
        kind: 'AutomationRun',
        automationId: safeStr(event.automationId),
        automationName: '정기 자동화',
        botId: safeNullableStr(event.botId),
        botName:
          event.botName !== null && event.botName !== undefined
            ? scrubAll(safeStr(event.botName))
            : null,
        success: Boolean(event.success),
        noReply: Boolean(event.noReply),
        error: event.error !== null && event.error !== undefined ? '오류 상세 가려짐' : null,
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
        provider: workerLabelFor ? workerLabelFor(dispatchId) : '도우미',
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
  workerSeqHint = 1
): [string, string] {
  if (!event || typeof event !== 'object') {
    return ['기록된 사건', '기록된 사건'];
  }
  switch (event.kind) {
    case 'Handoff': {
      const fromName = scrubAll(actorDisplayName(event.from));
      const toName = scrubAll(actorDisplayName(event.to));
      const subj = truncateChars(scrubAll(safeStr(event.subject)), 28);
      const normal = subj.length === 0 ? `인계: ${fromName} → ${toName}` : `인계: ${subj}`;
      const redacted = `${fromName} → ${toName}: 업무 인계`;
      return [normal, redacted];
    }
    case 'Question': {
      const subj = truncateChars(scrubAll(safeStr(event.subject)), 26);
      return [subj.length === 0 ? '? 질문' : `? ${subj}`, '? 질문'];
    }
    case 'StatusReport': {
      const subj = truncateChars(scrubAll(safeStr(event.subject)), 26);
      return [subj.length === 0 ? '상태 보고' : `보고: ${subj}`, '상태 보고'];
    }
    case 'Reply': {
      const subj = truncateChars(scrubAll(safeStr(event.subject)), 26);
      return [subj.length === 0 ? '회신 전달' : `회신: ${subj}`, '회신 전달'];
    }
    case 'WorkerStart': {
      const cleanProv = scrubAll(safeStr(event.provider, '도우미'));
      const rawTitle = safeNullableStr(event.taskTitle);
      const t = rawTitle && rawTitle.trim().length > 0 ? rawTitle : null;
      const normal = t
        ? `도우미(${cleanProv}): ${truncateChars(scrubAll(t), 22)}`
        : `도우미 시작 (${cleanProv})`;
      return [normal, `도우미 #${workerSeqHint}`];
    }
    case 'WorkerDone': {
      const subj = truncateChars(scrubAll(safeStr(event.subject)), 24);
      return [subj.length === 0 ? '완료 보고' : `완료: ${subj}`, '완료 보고'];
    }
    case 'WorkerFailed': {
      const subj = truncateChars(scrubAll(safeStr(event.subject)), 24);
      return [subj.length === 0 ? '작업 실패' : `실패: ${subj}`, '작업 실패'];
    }
    case 'Escalation': {
      const clean = truncateChars(scrubAll(safeStr(event.reason)), 24);
      return [clean.length === 0 ? '승인/개입 필요' : `개입 필요: ${clean}`, '승인/개입 필요'];
    }
    case 'ApprovalClosed':
      return ['승인 완료 · 재개', '재개'];
    case 'ItemNeedsYou': {
      const num = safeNum(event.number);
      const cleanTitle = truncateChars(scrubAll(safeStr(event.title)), 22);
      const normal =
        cleanTitle.length === 0
          ? `결정 대기 (#${num})`
          : `결정 대기 (#${num}): ${cleanTitle}`;
      return [normal, `결정 대기 (#${num})`];
    }
    case 'BossReplied': {
      const itemNumber = safeNullableNum(event.itemNumber);
      if (itemNumber !== null) {
        return [`사장님 응답 (#${itemNumber})`, `사장님 응답 (#${itemNumber})`];
      }
      const subj = truncateChars(scrubAll(safeStr(event.subject)), 22);
      return [subj.length === 0 ? '사장님 응답' : `사장님 응답: ${subj}`, '사장님 응답'];
    }
    case 'ItemDone': {
      const num = safeNum(event.number);
      const cleanTitle = truncateChars(scrubAll(safeStr(event.title)), 22);
      const normal =
        cleanTitle.length === 0
          ? `항목 완료 (#${num})`
          : `항목 완료 (#${num}): ${cleanTitle}`;
      return [normal, `항목 완료 (#${num})`];
    }
    case 'ItemCanceled': {
      const num = safeNum(event.number);
      const cleanTitle = truncateChars(scrubAll(safeStr(event.title)), 22);
      const normal =
        cleanTitle.length === 0
          ? `항목 취소 (#${num})`
          : `항목 취소 (#${num}): ${cleanTitle}`;
      return [normal, `항목 취소 (#${num})`];
    }
    case 'BotWorking': {
      const rawTool = safeNullableStr(event.tool);
      const t = rawTool && rawTool.trim().length > 0 ? rawTool : null;
      return [t ? `작업 중 (${scrubAll(t)})` : '작업 중', '작업 중'];
    }
    case 'ToolChanged': {
      const rawTool = safeNullableStr(event.tool);
      const t = rawTool && rawTool.trim().length > 0 ? rawTool : null;
      return [t ? `도구 전환: ${scrubAll(t)}` : '작업 중', '작업 중'];
    }
    case 'BotIdle':
      return ['대기 중', '대기 중'];
    case 'WaitingAnswer':
      return ['응답 대기', '응답 대기'];
    case 'BotFailed': {
      const rawMsg = safeNullableStr(event.message);
      const m = rawMsg && rawMsg.trim().length > 0 ? rawMsg : null;
      return [m ? `오류: ${truncateChars(scrubAll(m), 24)}` : '오류 발생', '오류 발생'];
    }
    case 'AutomationRun': {
      const name = truncateChars(scrubAll(safeStr(event.automationName)), 20);
      const normal = event.success
        ? event.noReply
          ? `정기 점검 이상 없음: ${name}`
          : `정기 점검 완료: ${name}`
        : `정기 점검 실패: ${name}`;
      const redacted = event.success ? '정기 점검 완료' : '정기 점검 실패';
      return [normal, redacted];
    }
    case 'BotPaused':
      return ['일시 정지', '일시 정지'];
    case 'WorkerExited':
      return ['도우미 종료', '도우미 퇴장'];
    case 'WorkerReleased':
      return ['도우미 퇴장', '도우미 퇴장'];
    case 'BotJoined': {
      const cleanName = scrubAll(safeStr(event.botName));
      return [`새 봇 합류: ${cleanName}`, `새 봇 합류 (${cleanName})`];
    }
    default:
      return ['기록된 사건', '기록된 사건'];
  }
}

export function createEventRecord(
  event: WorldEvent,
  timestampMs: number,
  workerSeqHint = 1
): WorldEventRecord {
  const scrubbedEvent = scrubWorldEvent(event);
  const [summary, redactedSummary] = formatEventSummaries(scrubbedEvent, workerSeqHint);
  return {
    timestampMs,
    summary: scrubAll(summary),
    redactedSummary: scrubAll(redactedSummary),
    event: scrubbedEvent,
  };
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
  next: WorldSnapshot
): ActorRef {
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
        label: `도우미(${scrubAll(w.provider)})`,
      };
    }
    return {
      kind: 'Worker',
      dispatchId,
      parentBotId: resolveRunBot(runId, prev, next),
      label: '도우미',
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
        label: `도우미(${scrubAll(best.provider)})`,
      };
    }
    return {
      kind: 'Worker',
      dispatchId: handle,
      parentBotId: resolveRunBot(runId, prev, next),
      label: '도우미',
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
  suppress: boolean
): WorldEvent[] {
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

    let from = resolveHandle(msg.fromHandle, msg.runId, prev, next);
    const to = resolveHandle(msg.toHandle, msg.runId, prev, next);

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
      const botName = botObj ? scrubAll(botObj.name) : actorDisplayName(to);
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
        subject: nextW.taskTitle !== null ? scrubAll(nextW.taskTitle) : '완료 보고',
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
        subject: nextW.taskTitle !== null ? scrubAll(nextW.taskTitle) : '작업 실패',
      });
    }

    const prevBlocked = prevW ? prevW.activity === 'blocked' : false;
    const nextBlocked = nextW.activity === 'blocked';
    const workerActor: ActorRef = {
      kind: 'Worker',
      dispatchId,
      parentBotId,
      label: `도우미(${scrubAll(nextW.provider)})`,
    };
    const workerKey = `worker:${dispatchId}`;
    if (!prevBlocked && nextBlocked && !emittedEscalationKeys.has(workerKey)) {
      emittedEscalationKeys.add(workerKey);
      events.push({
        kind: 'Escalation',
        actor: workerActor,
        targetBotId: parentBotId,
        reason: nextW.taskTitle !== null ? scrubAll(nextW.taskTitle) : '승인/개입 필요',
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
        reason: nextBot.status.reason !== null ? scrubAll(nextBot.status.reason) : '승인/차단',
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
        message: error ?? '자동화 실행 전달 실패',
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
