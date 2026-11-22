import {
  type ActorRef,
  type WorldEventRecord,
  type WorldSnapshot,
  isSafeKey,
  isWorkerActive,
  isWorkerVisibleOnStage,
} from '../src/types.ts';

export type NetworkNodeRef =
  | { kind: 'bot'; botId: string }
  | { kind: 'worker'; dispatchId: string }
  | { kind: 'automation_hub' };

export type CollabEdgeKind = 'bot_bot' | 'bot_worker' | 'automation_bot';

export type CollabEdge = {
  id: string;
  from: NetworkNodeRef;
  to: NetworkNodeRef;
  kind: CollabEdgeKind;
  weight: number;
  active: boolean;
};

const HOUR_MS = 3600_000;
const DEFAULT_WINDOW_HOURS = 24;

function resolveBotIdByName(snapshot: WorldSnapshot, name: string | null | undefined): string | null {
  if (!name) return null;
  for (const [id, bot] of Object.entries(snapshot.bots)) {
    if (isSafeKey(id) && bot.name === name) return id;
  }
  return null;
}

function resolveActorToNode(
  actor: ActorRef,
  snapshot: WorldSnapshot,
  visibleWorkerIds: ReadonlySet<string>
): NetworkNodeRef | null {
  if (!actor || typeof actor !== 'object') return null;
  if (actor.kind === 'Bot') {
    if (isSafeKey(actor.botId) && Object.hasOwn(snapshot.bots, actor.botId)) {
      return { kind: 'bot', botId: actor.botId };
    }
    const byName = resolveBotIdByName(snapshot, actor.botName);
    return byName ? { kind: 'bot', botId: byName } : null;
  }
  if (actor.kind === 'Worker') {
    if (isSafeKey(actor.dispatchId) && visibleWorkerIds.has(actor.dispatchId)) {
      return { kind: 'worker', dispatchId: actor.dispatchId };
    }
    if (actor.parentBotId && isSafeKey(actor.parentBotId) && Object.hasOwn(snapshot.bots, actor.parentBotId)) {
      return { kind: 'bot', botId: actor.parentBotId };
    }
    return null;
  }
  if (actor.kind === 'AutomationBoard') {
    return { kind: 'automation_hub' };
  }
  return null;
}

export function buildCollabNetwork(
  events: readonly WorldEventRecord[],
  snapshot: WorldSnapshot,
  opts?: { nowMs?: number; windowHours?: number }
): CollabEdge[] {
  const windowHours = opts?.windowHours ?? DEFAULT_WINDOW_HOURS;
  const nowMs =
    typeof opts?.nowMs === 'number' && Number.isFinite(opts.nowMs) && opts.nowMs > 0
      ? opts.nowMs
      : snapshot.capturedAt > 0
        ? snapshot.capturedAt
        : Date.now();
  const windowStartMs = nowMs - windowHours * HOUR_MS;
  const windowEndMs = nowMs + 60_000;

  const edgeMap = new Map<string, CollabEdge>();
  const visibleWorkers = new Map<string, { parentBotId: string; active: boolean }>();
  const visibleWorkerIds = new Set<string>();

  for (const worker of Object.values(snapshot.workers)) {
    if (!isWorkerVisibleOnStage(worker) || !isSafeKey(worker.dispatchId)) continue;
    const parentId =
      worker.parentBotId && isSafeKey(worker.parentBotId) && Object.hasOwn(snapshot.bots, worker.parentBotId)
        ? worker.parentBotId
        : resolveBotIdByName(snapshot, worker.parentBotName);
    if (!parentId) continue;
    visibleWorkerIds.add(worker.dispatchId);
    visibleWorkers.set(worker.dispatchId, {
      parentBotId: parentId,
      active: isWorkerActive(worker),
    });
  }

  const upsertEdge = (
    id: string,
    from: NetworkNodeRef,
    to: NetworkNodeRef,
    kind: CollabEdgeKind,
    deltaWeight: number,
    active: boolean
  ): void => {
    const existing = edgeMap.get(id);
    if (existing) {
      existing.weight += deltaWeight;
      existing.active = existing.active || active;
    } else {
      edgeMap.set(id, {
        id,
        from,
        to,
        kind,
        weight: deltaWeight,
        active,
      });
    }
  };

  // Seed live bot <-> worker delegation links so offices with active sub-workers always show links
  for (const [dispatchId, info] of visibleWorkers.entries()) {
    upsertEdge(
      `bot_worker:${info.parentBotId}::${dispatchId}`,
      { kind: 'bot', botId: info.parentBotId },
      { kind: 'worker', dispatchId },
      'bot_worker',
      1,
      info.active
    );
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

    switch (ev.kind) {
      case 'Handoff':
      case 'Question':
      case 'StatusReport':
      case 'Reply': {
        const a = resolveActorToNode(ev.from, snapshot, visibleWorkerIds);
        const b = resolveActorToNode(ev.to, snapshot, visibleWorkerIds);
        if (!a || !b) break;
        if (a.kind === 'bot' && b.kind === 'bot') {
          if (a.botId === b.botId) break;
          const [first, second] = a.botId < b.botId ? [a.botId, b.botId] : [b.botId, a.botId];
          upsertEdge(
            `bot_bot:${first}::${second}`,
            { kind: 'bot', botId: first },
            { kind: 'bot', botId: second },
            'bot_bot',
            1,
            true
          );
        } else if (
          (a.kind === 'bot' && b.kind === 'worker') ||
          (a.kind === 'worker' && b.kind === 'bot')
        ) {
          const botNode = a.kind === 'bot' ? a : (b as { kind: 'bot'; botId: string });
          const workerNode = a.kind === 'worker' ? a : (b as { kind: 'worker'; dispatchId: string });
          const info = visibleWorkers.get(workerNode.dispatchId);
          if (info && info.parentBotId === botNode.botId) {
            upsertEdge(
              `bot_worker:${botNode.botId}::${workerNode.dispatchId}`,
              botNode,
              workerNode,
              'bot_worker',
              1,
              info.active
            );
          }
        }
        break;
      }
      case 'WorkerStart':
      case 'WorkerDone':
      case 'WorkerFailed': {
        if (!isSafeKey(ev.dispatchId)) break;
        const info = visibleWorkers.get(ev.dispatchId);
        if (info) {
          upsertEdge(
            `bot_worker:${info.parentBotId}::${ev.dispatchId}`,
            { kind: 'bot', botId: info.parentBotId },
            { kind: 'worker', dispatchId: ev.dispatchId },
            'bot_worker',
            1,
            info.active
          );
        }
        break;
      }
      case 'AutomationRun': {
        const botId =
          ev.botId && isSafeKey(ev.botId) && Object.hasOwn(snapshot.bots, ev.botId)
            ? ev.botId
            : resolveBotIdByName(snapshot, ev.botName);
        if (botId) {
          upsertEdge(
            `automation_bot:${botId}`,
            { kind: 'automation_hub' },
            { kind: 'bot', botId },
            'automation_bot',
            1,
            ev.success
          );
        }
        break;
      }
      default:
        break;
    }
  }

  return Array.from(edgeMap.values()).sort(
    (a, b) => b.weight - a.weight || a.id.localeCompare(b.id)
  );
}
