import { assert, describe, test } from 'orca/testing';
import { diffSnapshots, formatEventSummaries, scrubWorldEvent } from './events.ts';
import {
  applyAutomations,
  applyBotChats,
  applyBotItemsScoped,
  applyBotList,
  applyInbox,
  applyStatus,
  applyWorkerList,
  applyWorktreePs,
  pruneSnapshotState,
} from './normalize.ts';
import {
  MAX_EVENTS,
  MAX_KEYFRAMES,
  SAFE_IPC_PAYLOAD_BYTES,
  TimelineBuffer,
  formatKstHms,
} from './timeline.ts';
import { type WorldEvent, createEmptySnapshot } from './types.ts';
import { getThemeConfig } from '../shared/assets-catalog.ts';
import { ReplayController } from '../shared/motion.ts';

function buildBaseSnapshot() {
  const snap = createEmptySnapshot();
  applyStatus(snap, {
    ok: true,
    result: { runtime: { state: 'ready', reachable: true, runtimeId: 'rt-1', appVersion: '1.4.267' } },
  });
  applyBotList(snap, {
    ok: true,
    result: {
      bots: [
        { id: 'b1', name: 'Ops Lead', agent: 'claude', paused: false, specialty: '조율' },
        { id: 'b2', name: '보안', agent: 'claude', paused: false, specialty: '보안' },
      ],
    },
  });
  applyBotChats(snap, {
    ok: true,
    result: {
      bot: 'Ops Lead',
      chats: [{ id: 'c1', title: 'Home', home: true, lastActivityAt: 1000 }],
    },
  });
  applyBotChats(snap, {
    ok: true,
    result: {
      bot: '보안',
      chats: [{ id: 'c2', title: '보안 점검', home: true, lastActivityAt: 1000 }],
    },
  });
  snap.initialSyncComplete = true;
  return snap;
}

describe('Normalization, 18-kind event diffing, and 24h replay timeline', () => {
  test('filters raw inbox headers and prioritizes in_progress item titles', () => {
    const snap = buildBaseSnapshot();
    applyBotItemsScoped(
      snap,
      {
        ok: true,
        result: {
          botId: 'b1',
          botName: 'Ops Lead',
          items: [
            {
              uid: 'it1',
              number: 12,
              title: '정상 진행 작업',
              status: 'in_progress',
              version: 1,
            },
          ],
        },
      },
      true
    );
    applyBotChats(snap, {
      ok: true,
      result: {
        bot: 'Ops Lead',
        chats: [
          { id: 'c-raw', title: '──── From: 보안', home: false, lastActivityAt: 999999 },
          { id: 'c1', title: 'Home', home: true, lastActivityAt: 5000 },
        ],
      },
    });
    assert.equal(snap.bots['b1'].currentTaskTitle, '정상 진행 작업');
  });

  test('detects all core event transitions across snapshots', () => {
    const prev = buildBaseSnapshot();
    const next = structuredClone(prev);

    // BotJoined
    applyBotList(next, {
      ok: true,
      result: {
        bots: [
          { id: 'b1', name: 'Ops Lead', agent: 'claude', paused: false, specialty: '조율' },
          { id: 'b2', name: '보안', agent: 'claude', paused: false, specialty: '보안' },
          { id: 'b3', name: 'IaC', agent: 'claude', paused: true, specialty: '테라폼' },
        ],
      },
    });

    // WorkerStart & BotWorking
    applyWorkerList(next, {
      ok: true,
      result: {
        workers: [
          {
            dispatchId: 'd1',
            runId: 'r1',
            workerState: 'ready',
            dispatchStatus: 'dispatched',
            terminalState: 'attached',
            agentTerminalHandle: 'term_1',
            projection: {
              provider: { id: 'claude', model: 'sonnet' },
              liveness: { verdict: 'live', observedAt: 2000 },
              stage: { activity: 'working' },
            },
          },
        ],
      },
    });
    applyWorktreePs(next, {
      ok: true,
      result: {
        worktrees: [
          {
            worktreeId: 'wt-1',
            bot: 'Ops Lead',
            botHome: true,
            agents: [
              {
                address: 'orca_session_id:c1',
                paneKey: 'structured-agent-session-c1',
                state: 'working',
                toolName: 'read_file',
                taskTitle: '작업 A',
              },
              {
                address: 'term_1',
                parentPaneKey: 'structured-agent-session-c1',
                state: 'working',
                taskTitle: '하위 분석',
              },
            ],
          },
        ],
      },
    });

    // ItemNeedsYou & AutomationRun & Inbox Handoff
    applyBotItemsScoped(
      next,
      {
        ok: true,
        result: {
          botId: 'b2',
          botName: '보안',
          items: [
            {
              uid: 'it-ny',
              number: 7,
              title: '권한 승인',
              status: 'needs_you',
              version: 1,
              question: { ask: { questions: [{ prompt: '진행할까요?', options: ['예', '아니오'] }] } },
            },
          ],
        },
      },
      true
    );
    applyAutomations(
      next,
      {
        ok: true,
        result: {
          automations: [{ id: 'a1', name: '일일 점검', enabled: true, bot: { botId: 'b2' } }],
        },
      },
      {
        ok: true,
        result: {
          runs: [
            {
              id: 'ar1',
              automationId: 'a1',
              status: 'completed',
              startedAt: 3000,
              outputSnapshot: { content: 'NO_REPLY' },
            },
          ],
        },
      }
    );
    applyInbox(next, {
      ok: true,
      result: {
        messages: [
          {
            id: 'msg1',
            sequence: 1,
            type: 'handoff',
            from_handle: 'orca_session_id:c1',
            to_handle: 'orca_session_id:c2',
            subject: '보안 검토 요청',
            body: '확인 바랍니다',
          },
        ],
      },
    });

    const events = diffSnapshots(prev, next, false);
    const kinds = new Set(events.map((e) => e.kind));
    assert.ok(kinds.has('BotJoined'));
    assert.ok(kinds.has('WorkerStart'));
    assert.ok(kinds.has('BotWorking'));
    assert.ok(kinds.has('ItemNeedsYou'));
    assert.ok(kinds.has('AutomationRun'));
    assert.ok(kinds.has('Handoff'));

    // Runtime change suppresses diff
    const nextRt = structuredClone(next);
    nextRt.runtime.runtimeId = 'rt-2';
    assert.deepEqual(diffSnapshots(next, nextRt, false), []);
  });

  test('enforces 24h ring buffer caps, IPC size safety, and replay interpolation', () => {
    const buf = new TimelineBuffer();
    const baseMs = 1_700_000_000_000;
    const snap = buildBaseSnapshot();

    for (let i = 0; i < MAX_KEYFRAMES + 30; i++) {
      buf.recordKeyframe(snap, baseMs + i * 1000);
    }
    assert.equal(buf.keyframes.length, MAX_KEYFRAMES);

    for (let i = 0; i < MAX_EVENTS + 40; i++) {
      buf.pushEvent({ kind: 'BotWorking', botId: 'b1', botName: 'Ops Lead', tool: 'read_file' }, baseMs + i * 100);
    }
    assert.equal(buf.eventLog.length, MAX_EVENTS);

    const exported = buf.exportBounded();
    const bytes = new TextEncoder().encode(JSON.stringify(exported)).byteLength;
    assert.ok(bytes <= SAFE_IPC_PAYLOAD_BYTES, `Payload bytes ${bytes} exceeded safe cap`);

    const interp = buf.interpolateAt(baseMs + 35_500);
    assert.ok(interp !== null);
    assert.ok(interp!.alpha >= 0 && interp!.alpha <= 1);

    const replay = new ReplayController();
    const theme = getThemeConfig('startup_office');
    replay.seekFraction(0.5, buf.keyframes, buf.eventLog, snap, theme);
    assert.equal(replay.isReplay, true);
    replay.togglePlay(buf.keyframes, buf.eventLog, snap, theme);
    assert.equal(replay.isPlaying, true);
    replay.step(0.1, buf.keyframes, buf.eventLog, snap, theme);
    replay.returnToLive();
    assert.equal(replay.isReplay, false);

    assert.equal(formatKstHms(0), '--:--:--');
  });

  test('hydrate skips corrupted events/keyframes safely, exportBounded shrinks to budget, and pruneSnapshotState caps growth', () => {
    const now = 1_700_000_000_000;
    const corrupted = {
      events: [
        null,
        { timestampMs: 'bad', event: { kind: 'BotIdle', botId: 'b1', botName: 'x' } },
        { timestampMs: now - 1000, event: { kind: 'UnknownFutureKind', foo: 'bar' } },
        { timestampMs: now - 1000, event: { kind: 'Handoff', messageId: 'm1', from: null, to: null } },
        {
          timestampMs: now - 500,
          summary: '작업 중',
          redactedSummary: '작업 중',
          event: { kind: 'BotWorking', botId: 'b1', botName: 'Ops Lead', tool: 'read_file' },
        },
      ],
      keyframes: [
        null,
        { timestampMs: now - 1000, snapshot: null },
        { timestampMs: now - 1000, snapshot: { bots: null, workers: {}, botOrder: [], runtime: {} } },
        { timestampMs: now - 1000, snapshot: { bots: {}, workers: [], botOrder: [], runtime: {} } },
        { timestampMs: now - 1000, snapshot: { bots: {}, workers: {}, botOrder: 'bad', runtime: {} } },
        {
          timestampMs: now - 500,
          snapshot: buildBaseSnapshot(),
        },
      ],
    };

    const hydrated = TimelineBuffer.hydrate(corrupted, now);
    assert.equal(hydrated.eventLog.length, 1);
    assert.equal(hydrated.eventLog[0].event.kind, 'BotWorking');
    assert.equal(hydrated.keyframes.length, 1);

    // Unknown event fallback never throws
    const unknownEv = { kind: 'TotallyUnknownEvent' } as unknown as WorldEvent;
    const scrubbed = scrubWorldEvent(unknownEv);
    assert.equal(scrubbed.kind, 'BotIdle');
    const [sum, redSum] = formatEventSummaries(unknownEv);
    assert.equal(sum, 'Recorded event');
    assert.equal(redSum, 'Recorded event');
    const [sumKo, redSumKo] = formatEventSummaries(unknownEv, 1, 'ko');
    assert.equal(sumKo, '기록된 사건');
    assert.equal(redSumKo, '기록된 사건');

    // exportBounded respects strict small budgetBytes (even below 8 keyframes / 20 events)
    const bigBuf = new TimelineBuffer();
    const snap = buildBaseSnapshot();
    for (let i = 0; i < 30; i++) {
      bigBuf.recordKeyframe(snap, now - 30_000 + i * 1000);
      bigBuf.pushEvent(
        { kind: 'BotWorking', botId: 'b1', botName: 'Ops Lead', tool: 'read_file' },
        now - 30_000 + i * 1000
      );
    }
    const tiny = bigBuf.exportBounded(undefined, 1024);
    const tinyBytes = new TextEncoder().encode(JSON.stringify(tiny)).byteLength;
    assert.ok(tinyBytes <= 1024, `Expected <= 1024 bytes, got ${tinyBytes}`);

    // pruneSnapshotState caps terminated workers & closed items
    const bloatSnap = buildBaseSnapshot();
    for (let i = 0; i < 60; i++) {
      bloatSnap.workers[`w-${i}`] = {
        dispatchId: `w-${i}`,
        taskId: null,
        runId: null,
        parentBotId: 'b1',
        parentBotName: 'Ops Lead',
        provider: 'claude',
        model: null,
        workerState: 'succeeded',
        dispatchStatus: 'completed',
        terminalState: 'released',
        terminalHandle: null,
        worktreeId: null,
        liveness: 'Exited',
        activity: 'done',
        toolName: null,
        taskTitle: null,
        updatedAt: now - i * 1000,
      };
    }
    pruneSnapshotState(bloatSnap, now);
    assert.ok(Object.keys(bloatSnap.workers).length <= 32);
  });
});
