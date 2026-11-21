import { assert, describe, mockHost, mountWorker, test } from 'orca/testing';
import type { OrcaClient } from './orca-cli.ts';
import { type WorldSnapshot, createEmptySnapshot } from './types.ts';
import * as main from './worker.ts';
import { BotWorldWorkerController, MAX_IPC_PAYLOAD_BYTES } from './worker.ts';

function createMockClient(): { client: OrcaClient; setWorkingTitle: (t: string) => void } {
  let workingTitle = '시크릿 점검 ' + 'AKIA' + 'IOSFODNN7EXAMPLE';
  let seq = 1;
  const client: OrcaClient = {
    isStopped: () => false,
    status: async () => ({
      ok: true,
      result: {
        runtime: {
          state: 'ready',
          reachable: true,
          runtimeId: 'rt-test',
          appVersion: '1.4.267',
        },
      },
    }),
    botList: async () => ({
      ok: true,
      result: {
        bots: [
          {
            id: 'bot-sec',
            name: '보안',
            agent: 'claude',
            paused: false,
            specialty: '인증·보안',
          },
        ],
      },
    }),
    botChats: async () => ({
      ok: true,
      result: {
        bot: '보안',
        chats: [{ id: 'chat-1', title: 'Home', home: true, lastActivityAt: 1000 }],
      },
    }),
    botItemList: async () => ({
      ok: true,
      result: {
        botId: 'bot-sec',
        botName: '보안',
        items: [
          {
            uid: 'item-1',
            number: 3,
            title: workingTitle,
            status: 'in_progress',
            version: 1,
          },
        ],
      },
    }),
    worktreePs: async () => ({
      ok: true,
      result: {
        worktrees: [
          {
            worktreeId: 'wt-1',
            bot: '보안',
            botHome: true,
            agents: [
              {
                address: 'orca_session_id:chat-1',
                paneKey: 'structured-agent-session-chat-1',
                state: 'working',
                toolName: 'run_command',
                taskTitle: workingTitle,
              },
            ],
          },
        ],
      },
    }),
    orchestrationInbox: async () => ({
      ok: true,
      result: {
        messages: [
          {
            id: `m-${seq}`,
            sequence: seq++,
            type: 'status',
            from_handle: 'orca_session_id:chat-1',
            to_handle: 'orca:items',
            subject: '진행 보고 alice@example.com',
            body: 'Bearer ' + 'eyJhbGci' + 'OiJIUzI1NiIsInR5cCI6IkpXVCJ9',
          },
        ],
      },
    }),
    orchestrationWorkerList: async () => ({
      ok: true,
      result: { workers: [] },
    }),
    orchestrationRunList: async () => ({
      ok: true,
      result: { runs: [] },
    }),
    automationsList: async () => ({
      ok: true,
      result: { automations: [] },
    }),
    automationsRuns: async () => ({
      ok: true,
      result: { runs: [] },
    }),
  };

  return {
    client,
    setWorkingTitle: (t: string) => {
      workingTitle = t;
    },
  };
}

describe('BotWorld worker lifecycle & panel requests', () => {
  test('activates via mountWorker, validates inputs, updates storage & statusBar, and scrubs secrets', async () => {
    const host = mockHost({
      settings: { defaultTheme: 'startup_office', redactMode: false, pollIntervalSec: 5 },
    });
    const worker = await mountWorker(main, { host });

    const initial = await worker.request('botWorld.getState');
    assert.equal(initial.activeTheme, 'startup_office');
    assert.equal(initial.redactMode, false);

    // Valid theme change
    const themeRes = await worker.request('botWorld.setTheme', { themeId: 'corporate_office' });
    assert.equal(themeRes.themeId, 'corporate_office');

    // Invalid theme rejected with invalid_params
    await assert.rejects(
      () => worker.request('botWorld.setTheme', { themeId: '../../etc/passwd' }),
      (err: unknown) => (err as { code?: string })?.code === 'invalid_params'
    );

    // Valid redact mode change
    const redactRes = await worker.request('botWorld.setRedactMode', { redactMode: true });
    assert.equal(redactRes.redactMode, true);

    // Valid appearance change
    const appRes = await worker.request('botWorld.setBotAppearance', {
      botId: 'bot-sec',
      characterId: 'cve',
    });
    assert.deepEqual(appRes.botAppearances, { 'bot-sec': 'cve' });

    // Reject worker_helper or __proto__ in appearance change
    await assert.rejects(
      () =>
        worker.request('botWorld.setBotAppearance', {
          botId: 'bot-sec',
          characterId: 'worker_helper',
        }),
      (err: unknown) => (err as { code?: string })?.code === 'invalid_params'
    );
    await assert.rejects(
      () =>
        worker.request('botWorld.setBotAppearance', {
          botId: '__proto__',
          characterId: 'cve',
        }),
      (err: unknown) => (err as { code?: string })?.code === 'invalid_params'
    );

    const saved = host.data().storage['botWorld.prefs'] as {
      activeTheme: string;
      redactMode: boolean;
      botAppearances: Record<string, string>;
    };
    assert.equal(saved.activeTheme, 'corporate_office');
    assert.equal(saved.redactMode, true);
    assert.equal(saved.botAppearances['bot-sec'], 'cve');

    assert.ok(worker.posts.some((p) => p.event === 'botWorld.stateUpdated'));
    assert.deepEqual(worker.refusals, []);
    await worker.deactivate();
  });

  test('controller polls mock CLI, scrubs secrets before storage & UI, and respects redactMode', async () => {
    const host = mockHost({
      settings: { defaultTheme: 'startup_office', redactMode: false, pollIntervalSec: 5 },
    });
    const { client } = createMockClient();
    let controller: BotWorldWorkerController | null = null;

    const worker = await mountWorker(
      {
        default: async (orca) => {
          controller = new BotWorldWorkerController(orca, client);
          await controller.init({ disableAutoLoop: true });
          await controller.runPollTick(true);
        },
        deactivate: async () => {
          controller?.dispose();
        },
      },
      { host }
    );

    const state = await worker.request('botWorld.getState');
    const bot = state.snapshot.bots['bot-sec'];
    assert.ok(bot !== undefined);
    assert.ok(!JSON.stringify(state).includes('AKIA' + 'IOSFODNN7EXAMPLE'));
    assert.ok(!JSON.stringify(state).includes('alice@example.com'));
    assert.ok(!JSON.stringify(state).includes('eyJhbGci' + 'Oi'));
    assert.ok(bot.currentTaskTitle?.includes('[REDACTED_TOKEN]'));

    // Storage must also have zero raw secrets
    const serializedStorage = JSON.stringify(host.data().storage);
    assert.ok(!serializedStorage.includes('AKIA' + 'IOSFODNN7EXAMPLE'));
    assert.ok(!serializedStorage.includes('alice@example.com'));

    // Toggle redact mode ON -> hides task, tool, and message subjects/bodies
    await worker.request('botWorld.setRedactMode', { redactMode: true });
    const redacted = await worker.request('botWorld.getState');
    assert.equal(redacted.redactMode, true);
    assert.equal(redacted.snapshot.bots['bot-sec'].currentTool, null);
    assert.equal(redacted.snapshot.bots['bot-sec'].currentTaskTitle, '보안 · 작업 중');
    assert.equal(redacted.snapshot.recentMessages[0].subject, '');

    // StatusBar calls occurred without leaking bot name when redacted
    const statusCalls = host.callsOf('statusBar.update') as Array<{ text: string; tooltip: string }>;
    const lastStatus = statusCalls[statusCalls.length - 1];
    assert.ok(lastStatus.text.includes('가림'));
    assert.ok(!lastStatus.text.includes('보안'));
    assert.ok(!lastStatus.tooltip.includes('보안'));

    await worker.deactivate();
  });

  test('F-01/F-02/F-03/F-06/F-07 regression: settings override, ev.event redaction, <=220 KiB payload, serialized polling, and non-blocking init', async () => {
    const host = mockHost({
      settings: { defaultTheme: 'startup_office', redactMode: false, pollIntervalSec: 5 },
    });
    let inFlight = 0;
    let maxInFlight = 0;
    let seq = 1;
    let taskLabel = '초기 작업 secret@example.com';

    const client: OrcaClient = {
      isStopped: () => false,
      status: async () => {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return {
          ok: true,
          result: { runtime: { state: 'ready', reachable: true, runtimeId: 'rt-reg' } },
        };
      },
      botList: async () => ({
        ok: true,
        result: {
          bots: [{ id: 'b1', name: '보안', agent: 'claude', paused: false, specialty: '비밀 감사' }],
        },
      }),
      botChats: async () => ({
        ok: true,
        result: { bot: '보안', chats: [{ id: 'c1', title: 'Home', home: true, lastActivityAt: 1000 }] },
      }),
      botItemList: async () => ({
        ok: true,
        result: {
          botId: 'b1',
          botName: '보안',
          items: [{ uid: 'i1', number: 5, title: taskLabel, status: 'in_progress', version: 1 }],
        },
      }),
      worktreePs: async () => ({
        ok: true,
        result: {
          worktrees: [
            {
              worktreeId: 'wt-1',
              bot: '보안',
              botHome: true,
              agents: [
                {
                  address: 'orca_session_id:c1',
                  paneKey: 'structured-agent-session-c1',
                  state: 'working',
                  toolName: 'run_command',
                  taskTitle: taskLabel,
                },
              ],
            },
          ],
        },
      }),
      orchestrationInbox: async () => ({
        ok: true,
        result: {
          messages: [
            {
              id: `msg-${seq}`,
              sequence: seq++,
              type: 'handoff',
              from_handle: 'external:user@secret.com',
              to_handle: 'orca_session_id:c1',
              subject: '민감 제목 CONFIDENTIAL_PROJ',
              body: 'A'.repeat(20_000),
            },
          ],
        },
      }),
      orchestrationWorkerList: async () => ({
        ok: true,
        result: {
          workers: [
            {
              dispatchId: 'w-1',
              runId: 'r-1',
              workerState: 'ready',
              dispatchStatus: 'dispatched',
              terminalState: 'attached',
              agentTerminalHandle: 'term_w1',
              projection: {
                provider: { id: 'claude', model: 'claude-sonnet-secret' },
                liveness: { verdict: 'live', observedAt: 1000 },
                stage: { activity: 'working' },
              },
            },
          ],
        },
      }),
      orchestrationRunList: async () => ({ ok: true, result: { runs: [] } }),
      automationsList: async () => ({ ok: true, result: { automations: [] } }),
      automationsRuns: async () => ({ ok: true, result: { runs: [] } }),
    };

    let controller!: BotWorldWorkerController;
    let workerOrca!: Parameters<NonNullable<typeof main.default>>[0];
    const worker = await mountWorker(
      {
        default: async (orca) => {
          workerOrca = orca;
          controller = new BotWorldWorkerController(orca, client);
          const t0 = performance.now();
          await controller.init(); // F-07: must return immediately without awaiting slow CLI poll
          const elapsed = performance.now() - t0;
          assert.ok(elapsed < 100, `Expected non-blocking init(), took ${elapsed}ms`);
        },
        deactivate: async () => {
          controller.dispose();
        },
      },
      { host }
    );

    try {
      // Wait for async first poll to complete and emit stateUpdated
      await new Promise((r) => setTimeout(r, 80));
      assert.ok(worker.posts.some((p) => p.event === 'botWorld.stateUpdated'));

      // Second tick generates events (Handoff, ToolChanged, etc.)
      taskLabel = '변경된 민감 작업 SECRET_TASK_99';
      await Promise.all([controller.runPollTick(true), controller.runPollTick(true)]);
      assert.equal(maxInFlight, 1, 'F-06: concurrent runPollTick must be serialized');

      // F-01: UI override -> Orca settings explicit change overrides UI override
      await worker.request('botWorld.setRedactMode', { redactMode: false });
      await workerOrca.settings.set('defaultTheme', 'corporate_office');
      await workerOrca.settings.set('redactMode', true);
      await new Promise((r) => setTimeout(r, 25));
      const afterSettings = await worker.request('botWorld.getState');
      assert.equal(afterSettings.redactMode, true);
      assert.equal(afterSettings.activeTheme, 'corporate_office');

      // F-02: redactMode masks ev.event fields and metadata
      const payloadJson = JSON.stringify(afterSettings);
      assert.ok(!payloadJson.includes('CONFIDENTIAL_PROJ'));
      assert.ok(!payloadJson.includes('SECRET_TASK_99'));
      assert.ok(!payloadJson.includes('claude-sonnet-secret'));
      assert.ok(!payloadJson.includes('user@secret.com'));
      assert.equal(afterSettings.snapshot.bots['b1'].agent, '비공개');
      assert.equal(afterSettings.snapshot.workers['w-1'].provider, '도우미 #1');
      assert.equal(afterSettings.snapshot.workers['w-1'].model, null);

      // botAppearances 256 cap
      for (let i = 0; i < 256; i++) {
        await worker.request('botWorld.setBotAppearance', {
          botId: `cap-bot-${i}`,
          characterId: 'ddochi',
        });
      }
      await assert.rejects(
        () =>
          worker.request('botWorld.setBotAppearance', {
            botId: 'cap-bot-overflow',
            characterId: 'ddochi',
          }),
        (err: unknown) => (err as { code?: string })?.code === 'invalid_params'
      );

      // F-03: total serialized payload strictly <= 220 KiB even with huge timeline & messages
      const rawAccess = controller as unknown as {
        session: { snapshot: WorldSnapshot };
      };
      for (let i = 0; i < 40; i++) {
        rawAccess.session.snapshot.recentMessages.push({
          id: `huge-${i}`,
          sequence: 100 + i,
          msgType: 'status',
          fromHandle: 'b1',
          toHandle: 'orca:items',
          runId: null,
          subject: 'S'.repeat(400),
          body: 'B'.repeat(15_000),
          createdAt: null,
          threadId: null,
          payload: 'P'.repeat(15_000),
        });
      }
      const boundedPayload = controller.buildStatePayload();
      const bytes = new TextEncoder().encode(JSON.stringify(boundedPayload)).byteLength;
      assert.ok(bytes <= MAX_IPC_PAYLOAD_BYTES, `Payload ${bytes} exceeded ${MAX_IPC_PAYLOAD_BYTES}`);

      // F-06: scheduled poll recovers even if persistTimeline throws, and idle ticks skip storage writes
      let throwOnce = true;
      let timelineWriteCount = 0;
      const freshHost = mockHost({
        settings: { defaultTheme: 'startup_office', redactMode: false, pollIntervalSec: 5 },
      });
      const staticClient: OrcaClient = {
        ...client,
        orchestrationInbox: async () => ({
          ok: true,
          result: { messages: [] },
        }),
      };
      let recoveryCtrl!: BotWorldWorkerController;
      const recoveryWorker = await mountWorker(
        {
          default: async (orca) => {
            const wrappedOrca = {
              ...orca,
              storage: {
                ...orca.storage,
                set: async (key: string, val: Parameters<typeof orca.storage.set>[1]) => {
                  if (key === 'botWorld.timeline') {
                    timelineWriteCount++;
                    if (throwOnce) {
                      throwOnce = false;
                      throw new Error('simulated disk error');
                    }
                  }
                  return orca.storage.set(key, val);
                },
              },
            } as typeof orca;
            recoveryCtrl = new BotWorldWorkerController(wrappedOrca, staticClient);
            await recoveryCtrl.init({ disableAutoLoop: true });
          },
          deactivate: async () => {
            recoveryCtrl.dispose();
          },
        },
        { host: freshHost }
      );
      try {
        // First poll records initial keyframe -> persistTimeline throws -> pollTimer must still be scheduled
        const internal = recoveryCtrl as unknown as {
          executeScheduledPoll: () => Promise<void>;
          pollTimer: ReturnType<typeof setTimeout> | null;
        };
        await internal.executeScheduledPoll();
        assert.ok(internal.pollTimer !== null, 'F-06: pollTimer must be rescheduled after exception');
        assert.equal(timelineWriteCount, 1);

        // Next idle poll without new events or 30s keyframe skips persistTimeline write
        await recoveryCtrl.runPollTick(false);
        assert.equal(timelineWriteCount, 1);
      } finally {
        await recoveryWorker.deactivate();
      }
    } finally {
      await worker.deactivate();
    }
  });
});
