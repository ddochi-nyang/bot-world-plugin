import {
  applyAutomations,
  applyBotChats,
  applyBotItemsScoped,
  applyBotList,
  applyInbox,
  applyInboxBackfill,
  applyRunList,
  applyStatus,
  applyWorkerList,
  applyWorktreePs,
  pruneSnapshotState,
  rebaselineSnapshot,
} from './normalize.ts';
import { type OrcaClient, OrcaCliError } from './orca-cli.ts';
import { scrubAll } from './redact.ts';
import { type WorldSnapshot, createEmptySnapshot } from './types.ts';

const FAST_INTERVAL_MS = 2_000;
const DEFAULT_MEDIUM_INTERVAL_MS = 5_000;
const SLOW_INTERVAL_MS = 25_000;
const MAX_BACKOFF_SECS = 30;

export class PollerSession {
  snapshot: WorldSnapshot = createEmptySnapshot();
  backoffSecs = 2;
  mediumBotCursor = 0;
  slowItemCursor = 0;
  lastFastMs = 0;
  lastMediumMs = 0;
  lastSlowMs = 0;
  elapsedMs = 0;
  slowSynced = false;
  fastSynced = false;
  mediumSynced = false;
  rebaselineSuppressEmpty = false;
  mediumIntervalMs = DEFAULT_MEDIUM_INTERVAL_MS;

  setPollIntervalSec(sec: number): void {
    const clamped = Math.max(2, Math.min(60, Math.trunc(sec)));
    this.mediumIntervalMs = clamped * 1000;
  }

  prepareDue(): { runSlow: boolean; runFast: boolean; runMedium: boolean } {
    const runSlow = !this.slowSynced || this.elapsedMs - this.lastSlowMs >= SLOW_INTERVAL_MS;
    const runFast = !this.fastSynced || this.elapsedMs - this.lastFastMs >= FAST_INTERVAL_MS;
    const runMedium =
      !this.mediumSynced || this.elapsedMs - this.lastMediumMs >= this.mediumIntervalMs;
    return { runSlow, runFast, runMedium };
  }

  triggerRebaseline(): void {
    rebaselineSnapshot(this.snapshot);
    this.slowSynced = false;
    this.fastSynced = false;
    this.mediumSynced = false;
    this.rebaselineSuppressEmpty = true;
  }

  markRuntimeUnavailable(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.snapshot.runtime.connected = false;
    this.snapshot.runtime.reachable = false;
    this.snapshot.runtime.state = 'unavailable';
    this.snapshot.runtime.errorMessage = scrubAll(msg);
    this.snapshot.initialSyncComplete = false;
  }

  finishTick(
    runtimeUnavailable: boolean,
    anyChanged: boolean,
    nowMs: number = Date.now()
  ): { emitted: WorldSnapshot | null; sleepMs: number } {
    if (runtimeUnavailable) {
      this.snapshot.runtime.retryAfterSecs = this.backoffSecs;
      this.snapshot.initialSyncComplete = false;
      this.snapshot.capturedAt = nowMs;
      const sleepMs = this.backoffSecs * 1000;
      this.elapsedMs += sleepMs;
      this.backoffSecs = Math.min(MAX_BACKOFF_SECS, this.backoffSecs * 2);
      const emitted =
        this.rebaselineSuppressEmpty && !this.fastSynced ? null : structuredClone(this.snapshot);
      return { emitted, sleepMs };
    }

    this.backoffSecs = 2;
    if (this.fastSynced) {
      this.rebaselineSuppressEmpty = false;
    }
    this.snapshot.initialSyncComplete =
      this.slowSynced &&
      this.fastSynced &&
      this.mediumSynced &&
      !this.snapshot.rebaselineNeeded;

    const emitted =
      anyChanged && !(this.rebaselineSuppressEmpty && !this.fastSynced)
        ? (() => {
            this.snapshot.capturedAt = nowMs;
            pruneSnapshotState(this.snapshot, nowMs);
            return structuredClone(this.snapshot);
          })()
        : null;
    this.elapsedMs += FAST_INTERVAL_MS;
    return { emitted, sleepMs: FAST_INTERVAL_MS };
  }

  async step(
    cli: OrcaClient,
    options?: { forceFull?: boolean; nowMs?: number }
  ): Promise<{ snapshot: WorldSnapshot | null; sleepMs: number }> {
    const due = this.prepareDue();
    let runSlow = options?.forceFull ? true : due.runSlow;
    let runFast = options?.forceFull ? true : due.runFast;
    let runMedium = options?.forceFull ? true : due.runMedium;
    let anyChanged = false;
    let runtimeUnavailable = false;

    if (runSlow) {
      this.lastSlowMs = this.elapsedMs;
      try {
        const rebaselined = await pollSlowTier(cli, this.snapshot, this.slowItemCursor);
        anyChanged = true;
        this.slowItemCursor = (this.slowItemCursor + 1) >>> 0;
        if (rebaselined || this.snapshot.rebaselineNeeded) {
          if (this.snapshot.rebaselineNeeded) {
            this.triggerRebaseline();
            try {
              await pollSlowTier(cli, this.snapshot, this.slowItemCursor);
              this.slowSynced = true;
            } catch (err) {
              if (err instanceof OrcaCliError && err.code === 'stopped') throw err;
              runtimeUnavailable = true;
              this.markRuntimeUnavailable(err);
            }
          } else {
            this.slowSynced = true;
            this.fastSynced = false;
            this.mediumSynced = false;
            this.rebaselineSuppressEmpty = true;
          }
          runFast = true;
          runMedium = true;
        } else {
          this.slowSynced = true;
        }
      } catch (err) {
        if (err instanceof OrcaCliError && err.code === 'stopped') throw err;
        runtimeUnavailable = true;
        this.markRuntimeUnavailable(err);
      }
    }

    if (!runtimeUnavailable && runFast) {
      this.lastFastMs = this.elapsedMs;
      try {
        await pollFastTier(cli, this.snapshot);
        anyChanged = true;
        if (this.snapshot.rebaselineNeeded) {
          this.triggerRebaseline();
          runMedium = true;
          try {
            await pollSlowTier(cli, this.snapshot, this.slowItemCursor);
            this.slowSynced = true;
            await pollFastTier(cli, this.snapshot);
            this.fastSynced = true;
          } catch (err) {
            if (err instanceof OrcaCliError && err.code === 'stopped') throw err;
            runtimeUnavailable = true;
            this.markRuntimeUnavailable(err);
          }
        } else {
          this.fastSynced = true;
        }
      } catch (err) {
        if (err instanceof OrcaCliError && err.code === 'stopped') throw err;
        runtimeUnavailable = true;
        this.markRuntimeUnavailable(err);
      }
    }

    if (!runtimeUnavailable && runMedium) {
      this.lastMediumMs = this.elapsedMs;
      const fetchAll = !this.mediumSynced;
      try {
        await pollMediumTier(cli, this.snapshot, this.mediumBotCursor, fetchAll);
        anyChanged = true;
        this.mediumBotCursor = (this.mediumBotCursor + 1) >>> 0;
        if (this.snapshot.rebaselineNeeded) {
          this.triggerRebaseline();
        } else if (this.slowSynced) {
          this.mediumSynced = true;
        }
      } catch (err) {
        if (err instanceof OrcaCliError && err.code === 'stopped') throw err;
        if (
          err instanceof OrcaCliError &&
          (err.code === 'runtime_unavailable' || err.code === 'binary_not_found')
        ) {
          runtimeUnavailable = true;
          this.markRuntimeUnavailable(err);
        }
      }
    }

    const { emitted, sleepMs } = this.finishTick(
      runtimeUnavailable,
      anyChanged,
      options?.nowMs ?? Date.now()
    );
    return { snapshot: emitted, sleepMs };
  }
}

async function pollSlowTier(
  cli: OrcaClient,
  snapshot: WorldSnapshot,
  botCursor: number
): Promise<boolean> {
  if (cli.isStopped()) throw new OrcaCliError('stopped', 'Poller stopped');
  const status = await cli.status();
  applyStatus(snapshot, status);
  if (!snapshot.runtime.reachable) {
    throw new OrcaCliError(
      'runtime_unavailable',
      snapshot.runtime.errorMessage ?? 'Orca runtime unreachable'
    );
  }

  let rebaselined = false;
  if (snapshot.rebaselineNeeded) {
    rebaselineSnapshot(snapshot);
    rebaselined = true;
  }

  if (cli.isStopped()) throw new OrcaCliError('stopped', 'Poller stopped');
  try {
    const bots = await cli.botList();
    applyBotList(snapshot, bots);
  } catch (err) {
    if (err instanceof OrcaCliError && err.code === 'stopped') throw err;
  }

  if (cli.isStopped()) throw new OrcaCliError('stopped', 'Poller stopped');
  try {
    const runs = await cli.orchestrationRunList();
    applyRunList(snapshot, runs);
  } catch (err) {
    if (err instanceof OrcaCliError && err.code === 'stopped') throw err;
  }

  if (cli.isStopped()) throw new OrcaCliError('stopped', 'Poller stopped');
  let autoList = null;
  let autoRuns = null;
  try {
    autoList = await cli.automationsList();
  } catch (err) {
    if (err instanceof OrcaCliError && err.code === 'stopped') throw err;
  }
  if (cli.isStopped()) throw new OrcaCliError('stopped', 'Poller stopped');
  try {
    autoRuns = await cli.automationsRuns();
  } catch (err) {
    if (err instanceof OrcaCliError && err.code === 'stopped') throw err;
  }
  applyAutomations(snapshot, autoList, autoRuns);

  if (cli.isStopped()) throw new OrcaCliError('stopped', 'Poller stopped');
  if (snapshot.botOrder.length > 0) {
    const idx = botCursor % snapshot.botOrder.length;
    const botId = snapshot.botOrder[idx];
    const bot = botId && Object.hasOwn(snapshot.bots, botId) ? snapshot.bots[botId] : undefined;
    if (bot) {
      try {
        const items = await cli.botItemList(bot.name, true);
        applyBotItemsScoped(snapshot, items, true);
      } catch (err) {
        if (err instanceof OrcaCliError && err.code === 'stopped') throw err;
      }
    }
  }

  return rebaselined;
}

async function pollFastTier(cli: OrcaClient, snapshot: WorldSnapshot): Promise<void> {
  if (cli.isStopped()) throw new OrcaCliError('stopped', 'Poller stopped');
  const inbox = await cli.orchestrationInbox(30);
  applyInbox(snapshot, inbox);
  if (snapshot.inboxCursor.needsBackfill) {
    if (cli.isStopped()) throw new OrcaCliError('stopped', 'Poller stopped');
    try {
      const fullInbox = await cli.orchestrationInbox(100);
      applyInboxBackfill(snapshot, fullInbox);
    } catch (err) {
      if (err instanceof OrcaCliError && err.code === 'stopped') throw err;
    }
  }

  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    if (cli.isStopped()) throw new OrcaCliError('stopped', 'Poller stopped');
    let workers: Awaited<ReturnType<OrcaClient['orchestrationWorkerList']>>;
    try {
      workers = await cli.orchestrationWorkerList(100, cursor);
    } catch (err) {
      if (cursor !== null && err instanceof OrcaCliError && err.code === 'invalid_argument') {
        break;
      }
      throw err;
    }
    applyWorkerList(snapshot, workers);
    const res =
      workers.result && typeof workers.result === 'object' && !Array.isArray(workers.result)
        ? (workers.result as Record<string, unknown>)
        : null;
    const pageObj =
      res?.page && typeof res.page === 'object' && !Array.isArray(res.page)
        ? (res.page as Record<string, unknown>)
        : null;
    const nextRaw = pageObj?.hasMore === true && typeof pageObj.nextCursor === 'string'
      ? pageObj.nextCursor.trim()
      : '';
    if (nextRaw.length === 0 || nextRaw.startsWith('-')) break;
    cursor = nextRaw;
  }

  if (cli.isStopped()) throw new OrcaCliError('stopped', 'Poller stopped');
  const worktrees = await cli.worktreePs('24h');
  applyWorktreePs(snapshot, worktrees);
  snapshot.runtime.connected = true;
  snapshot.runtime.reachable = true;
  snapshot.runtime.retryAfterSecs = null;
}

async function pollMediumTier(
  cli: OrcaClient,
  snapshot: WorldSnapshot,
  botCursor: number,
  allOnBoot: boolean
): Promise<void> {
  if (snapshot.botOrder.length === 0) return;

  const targets: Array<{ id: string; name: string }> = [];
  if (allOnBoot) {
    for (const id of snapshot.botOrder) {
      const bot = Object.hasOwn(snapshot.bots, id) ? snapshot.bots[id] : undefined;
      if (bot) targets.push({ id: bot.id, name: bot.name });
    }
  } else {
    const len = snapshot.botOrder.length;
    const count = Math.min(2, len);
    for (let offset = 0; offset < count; offset++) {
      const idx = (botCursor * 2 + offset) % len;
      const id = snapshot.botOrder[idx];
      const bot = id && Object.hasOwn(snapshot.bots, id) ? snapshot.bots[id] : undefined;
      if (bot) targets.push({ id: bot.id, name: bot.name });
    }
  }

  for (const { id: botId, name: botName } of targets) {
    if (cli.isStopped()) throw new OrcaCliError('stopped', 'Poller stopped');
    try {
      const items = await cli.botItemList(botName, false);
      const res =
        items.result && typeof items.result === 'object' && !Array.isArray(items.result)
          ? (items.result as Record<string, unknown>)
          : null;
      const rawItems = Array.isArray(res?.items) ? res.items : [];
      const returnedUids = new Set(
        rawItems
          .map((it) =>
            it && typeof it === 'object' && !Array.isArray(it)
              ? (it as Record<string, unknown>).uid
              : undefined
          )
          .filter((u): u is string => typeof u === 'string')
      );
      const hadDisappearedOpen =
        !allOnBoot &&
        Object.values(snapshot.items).some(
          (it) =>
            (it.ownerBotId === botId || it.ownerBotName === botName) &&
            it.status !== 'done' &&
            it.status !== 'canceled' &&
            it.status !== 'closed' &&
            !returnedUids.has(it.uid)
        );
      if (hadDisappearedOpen) {
        try {
          const allItems = await cli.botItemList(botName, true);
          applyBotItemsScoped(snapshot, allItems, true);
        } catch {
          applyBotItemsScoped(snapshot, items, false);
        }
      } else {
        applyBotItemsScoped(snapshot, items, false);
      }
    } catch (err) {
      if (
        allOnBoot ||
        (err instanceof OrcaCliError &&
          (err.code === 'stopped' || err.code === 'runtime_unavailable'))
      ) {
        throw err;
      }
    }

    if (cli.isStopped()) throw new OrcaCliError('stopped', 'Poller stopped');
    try {
      const chats = await cli.botChats(botName);
      applyBotChats(snapshot, chats);
    } catch (err) {
      if (
        allOnBoot ||
        (err instanceof OrcaCliError &&
          (err.code === 'stopped' || err.code === 'runtime_unavailable'))
      ) {
        throw err;
      }
    }
  }
}
