import fs from 'node:fs';
import path from 'node:path';
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing';
import { renderBotDetail } from '../shared/bot-detail-view.ts';
import { createDemoOfficeSession } from '../shared/demo-office.ts';
import { UI_STRINGS } from '../shared/i18n.ts';
import {
  buildOfficeReport,
  buildStandupMarkdown,
  formatStandupMarkdown,
  renderOfficeReportModal,
} from '../shared/office-report.ts';
import {
  MAX_TRACKED_WATCHDOG_ENTRIES,
  STUCK_NOTIFY_COOLDOWN_MS,
  StuckWatchdogTracker,
  clampStuckThresholdMin,
  computeStuckAlerts,
} from '../shared/watchdog.ts';
import { DesktopNotificationManager } from './desktop-notify.ts';
import { applyBotItemsScoped, extractQuestionSummary } from './normalize.ts';
import {
  OrcaCliError,
  type OrcaClient,
  assertAllowedSubcommand,
  buildItemReplyArgs,
  validateItemNumber,
} from './orca-cli.ts';
import { type WorldEventRecord, type WorldSnapshot, createEmptySnapshot } from './types.ts';
import { BotWorldWorkerController, prepareSnapshotForUi } from './worker.ts';

function withFakeDom<T>(fn: () => T): T {
  const g = globalThis as unknown as Record<string, unknown>;
  const prevDoc = g.document;
  const prevNode = g.Node;
  const prevInput = g.HTMLInputElement;
  const prevImg = g.HTMLImageElement;
  const prevOpt = g.HTMLOptionElement;
  class FakeNode {
    tag: string;
    textContent = '';
    children: FakeNode[] = [];
    firstChild: FakeNode | null = null;
    constructor(tag = '') {
      this.tag = tag;
    }
    appendChild(c: FakeNode): FakeNode {
      this.children.push(c);
      this.firstChild = this.children[0] ?? null;
      return c;
    }
    removeChild(c: FakeNode): FakeNode {
      this.children = this.children.filter((x) => x !== c);
      this.firstChild = this.children[0] ?? null;
      return c;
    }
  }
  class FakeElement extends FakeNode {
    className = '';
    title = '';
    disabled = false;
    type = '';
    value = '';
    placeholder = '';
    maxLength = 500;
    attrs: Record<string, string> = {};
    listeners: Record<string, Array<(ev?: unknown) => void>> = {};
    classList = {
      toggle: () => {},
      add: () => {},
      remove: () => {},
    };
    setAttribute(k: string, v: string): void {
      this.attrs[k] = v;
    }
    addEventListener(ev: string, fn: (ev?: unknown) => void): void {
      this.listeners[ev] = this.listeners[ev] ?? [];
      this.listeners[ev].push(fn);
    }
  }
  class FakeHtmlInput extends FakeElement {}
  class FakeHtmlImage extends FakeElement {
    src = '';
    alt = '';
  }
  class FakeHtmlOption extends FakeElement {
    selected = false;
  }

  g.Node = FakeNode;
  g.HTMLInputElement = FakeHtmlInput;
  g.HTMLImageElement = FakeHtmlImage;
  g.HTMLOptionElement = FakeHtmlOption;
  g.document = {
    createElement: (tag: string) =>
      tag === 'img'
        ? new FakeHtmlImage(tag)
        : tag === 'input'
          ? new FakeHtmlInput(tag)
          : tag === 'option'
            ? new FakeHtmlOption(tag)
            : new FakeElement(tag),
    createTextNode: (text: string) => {
      const n = new FakeNode('#text');
      n.textContent = text;
      return n;
    },
  };
  try {
    return fn();
  } finally {
    g.document = prevDoc;
    g.Node = prevNode;
    g.HTMLInputElement = prevInput;
    g.HTMLImageElement = prevImg;
    g.HTMLOptionElement = prevOpt;
  }
}

function collectDomText(node: unknown): string {
  const n = node as { children?: unknown[]; textContent?: string };
  if (!n.children || n.children.length === 0) return n.textContent ?? '';
  return n.children.map(collectDomText).join(' ');
}

function makeNeedsYouSnapshot(nowMs = 1_700_100_000_000): WorldSnapshot {
  const snap = createEmptySnapshot();
  snap.capturedAt = nowMs;
  snap.initialSyncComplete = true;
  snap.runtime.connected = true;
  snap.runtime.reachable = true;
  snap.bots['bot-sec'] = {
    id: 'bot-sec',
    name: 'Security',
    agent: 'claude',
    paused: false,
    specialty: 'Auth & IAM',
    status: {
      kind: 'NeedsOwner',
      count: 1,
      prompt: 'Approve IAM scope?',
      optionsCount: 2,
    },
    currentTaskTitle: '#14 Staging IAM check',
    currentTool: null,
    lastActivityAt: nowMs - 5_000,
    homeChatId: 'chat-sec',
    needsYouCount: 1,
    activeWorkerCount: 1,
  };
  snap.bots['bot-iac'] = {
    id: 'bot-iac',
    name: 'Infra Ops',
    agent: 'codex',
    paused: false,
    specialty: 'Terraform',
    status: { kind: 'Working', tool: 'run_command' },
    currentTaskTitle: 'Apply staging VPC',
    currentTool: 'run_command',
    lastActivityAt: nowMs - 20 * 60_000,
    homeChatId: 'chat-iac',
    needsYouCount: 0,
    activeWorkerCount: 0,
  };
  snap.botOrder = ['bot-sec', 'bot-iac'];
  snap.workers['w-sec-1'] = {
    dispatchId: 'w-sec-1',
    taskId: 't-1',
    runId: 'r-1',
    parentBotId: 'bot-sec',
    parentBotName: 'Security',
    provider: 'claude',
    model: 'sonnet',
    workerState: 'ready',
    dispatchStatus: 'dispatched',
    terminalState: 'attached',
    terminalHandle: 'term_sec_1',
    worktreeId: 'wt_sec_1',
    liveness: 'Live',
    activity: 'working',
    toolName: 'read_file',
    taskTitle: 'Inspect IAM policy',
    updatedAt: nowMs - 4_000,
  };
  snap.items['item-14'] = {
    uid: 'item-14',
    number: 14,
    ownerBotId: 'bot-sec',
    ownerBotName: 'Security',
    title: 'Staging IAM policy check',
    status: 'needs_you',
    version: 1,
    lastEventId: null,
    questionPrompt: 'Should staging role restrict S3 list scope?',
    questionOptions: [
      {
        label: 'Restrict prefix',
        detail: 'Limit s3:ListBucket to staging/*',
        recommended: true,
      },
      {
        label: 'Keep full bucket',
        detail: 'Allow full staging bucket list',
      },
    ],
    optionsCount: 2,
    updatedAt: nowMs - 5_000,
  };
  return snap;
}

describe('Bot World Stage-2 Operational Command Center & Stage-1 Polish', () => {
  test('Needs You option parsing, Redact masking, buildItemReplyArgs injection blocking, and allowQuickSend RPC guard', async () => {
    // 1. extractQuestionSummary & applyBotItemsScoped parse strings & objects, cap at 6, and scrub PII/secrets
    const [promptStr, countStr, optsStr] = extractQuestionSummary({
      ask: {
        questions: [
          {
            prompt: 'Pick one for alice@example.com',
            options: ['Option 1', 'Option 2 AKIAIOSFODNN7EXAMPLE', '3', '4', '5', '6', '7'],
          },
        ],
      },
    });
    assert.equal(promptStr, 'Pick one for alice@example.com');
    assert.equal(countStr, 7);
    assert.equal(optsStr.length, 6);
    assert.ok(!optsStr[1].label.includes('AKIAIOSFODNN7EXAMPLE'));

    const snap = createEmptySnapshot();
    applyBotItemsScoped(
      snap,
      {
        ok: true,
        result: {
          botId: 'bot-sec',
          botName: 'Security',
          items: [
            {
              uid: 'u-1',
              number: 42,
              title: 'Approve deploy for alice@example.com',
              status: 'needs_you',
              version: 1,
              question: {
                ask: {
                  questions: [
                    {
                      prompt: 'Deploy with token ghp_12345678901234567890?',
                      options: [
                        {
                          label: 'Deploy canary',
                          description: 'Roll out to 10% for bob@example.com',
                          recommended: true,
                        },
                        {
                          label: 'Abort',
                          detail: 'Cancel release',
                        },
                      ],
                    },
                  ],
                },
              },
            },
          ],
        },
      },
      true
    );
    const parsedItem = snap.items['u-1'];
    assert.ok(parsedItem);
    assert.equal(parsedItem.optionsCount, 2);
    assert.equal(parsedItem.questionOptions?.length, 2);
    assert.equal(parsedItem.questionOptions?.[0].label, 'Deploy canary');
    assert.equal(parsedItem.questionOptions?.[0].recommended, true);
    assert.ok(!parsedItem.questionOptions?.[0].detail?.includes('bob@example.com'));
    assert.ok(!parsedItem.questionPrompt?.includes('ghp_12345678901234567890'));

    // 2. prepareSnapshotForUi masks questionPrompt and questionOptions in Redact Mode
    const unredactedUi = prepareSnapshotForUi(snap, false, 'en');
    assert.equal(unredactedUi.items['u-1'].questionOptions?.length, 2);
    const redactedUi = prepareSnapshotForUi(snap, true, 'en');
    assert.equal(redactedUi.items['u-1'].questionPrompt, null);
    assert.deepEqual(redactedUi.items['u-1'].questionOptions, []);

    // 3. buildItemReplyArgs stays strictly separated from read-only allowlist & blocks injection
    const args = buildItemReplyArgs('Security', 42, 'Deploy canary');
    assert.deepEqual(args, [
      'orchestration',
      'send',
      '--to',
      'bot:Security',
      '--item',
      '42',
      '--subject',
      'Bot World Decision Reply',
      '--body',
      'Deploy canary',
      '--json',
    ]);
    assert.throws(
      () => assertAllowedSubcommand(args),
      (err: unknown) => err instanceof OrcaCliError && err.code === 'disallowed_command'
    );
    for (const badNum of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000_000]) {
      assert.throws(() => validateItemNumber(badNum), OrcaCliError);
    }
    for (const badBot of ['', '-evil', 'bot;rm', 'bot\x00']) {
      assert.throws(() => buildItemReplyArgs(badBot, 1, 'ok'), OrcaCliError);
    }
    for (const badBody of ['', '   ', 'bad\x00text', 'x'.repeat(501)]) {
      assert.throws(() => buildItemReplyArgs('Security', 1, badBody), OrcaCliError);
    }

    // 4. botWorld.replyNeedsOwnerItem RPC guard, validation, cooldown, refresh
    let clockMs = 10_000;
    const cliCalls: Array<{ botName: string; itemNumber: number; answerText: string }> = [];
    let itemStillNeedsYou = true;
    let pollListCount = 0;

    const mockClient: OrcaClient = {
      isStopped: () => false,
      status: async () => ({
        ok: true,
        result: { runtime: { state: 'ready', reachable: true, runtimeId: 'rt-ops' } },
      }),
      botList: async () => ({
        ok: true,
        result: {
          bots: [{ id: 'bot-sec', name: 'Security', agent: 'claude', paused: false, specialty: 'IAM' }],
        },
      }),
      botChats: async () => ({ ok: true, result: { bot: 'Security', chats: [] } }),
      botItemList: async () => {
        pollListCount++;
        return {
          ok: true,
          result: {
            botId: 'bot-sec',
            botName: 'Security',
            items: [
              {
                uid: 'item-14',
                number: 14,
                title: 'IAM Check',
                status: itemStillNeedsYou ? 'needs_you' : 'in_progress',
                version: 1,
                question: {
                  ask: {
                    questions: [
                      {
                        prompt: 'Restrict scope?',
                        options: [{ label: 'Restrict prefix', recommended: true }],
                      },
                    ],
                  },
                },
              },
            ],
          },
        };
      },
      worktreePs: async () => ({ ok: true, result: { worktrees: [] } }),
      orchestrationInbox: async () => ({ ok: true, result: { messages: [] } }),
      orchestrationWorkerList: async () => ({ ok: true, result: { workers: [] } }),
      orchestrationRunList: async () => ({ ok: true, result: { runs: [] } }),
      automationsList: async () => ({ ok: true, result: { automations: [] } }),
      automationsRuns: async () => ({ ok: true, result: { runs: [] } }),
    };

    const host = mockHost({
      settings: {
        defaultTheme: 'startup_office',
        allowQuickSend: false,
        redactMode: false,
        pollIntervalSec: 5,
      },
    });
    let controller!: BotWorldWorkerController;
    let workerOrca!: Parameters<NonNullable<typeof import('./worker.ts').default>>[0];
    const worker = await mountWorker(
      {
        default: async (orca) => {
          workerOrca = orca;
          controller = new BotWorldWorkerController(orca, mockClient, {
            nowMs: () => clockMs,
            replyNeedsOwnerItem: async (botName, itemNumber, answerText) => {
              cliCalls.push({ botName, itemNumber, answerText });
              itemStillNeedsYou = false;
              return { ok: true, result: { sent: true } };
            },
          });
          await controller.init({ disableAutoLoop: true });
          await controller.runPollTick(true);
        },
        deactivate: async () => controller.dispose(),
      },
      { host }
    );

    try {
      // Disabled by default
      const disabledRes = await worker.request('botWorld.replyNeedsOwnerItem', {
        botId: 'bot-sec',
        itemNumber: 14,
        answerText: 'Restrict prefix',
      });
      assert.equal(disabledRes.ok, false);
      if (!disabledRes.ok) assert.equal(disabledRes.code, 'disabled');
      assert.equal(cliCalls.length, 0);

      // Opt-in enabled
      await workerOrca.settings.set('allowQuickSend', true);

      // Unknown bot & unknown item rejected
      const unkBot = await worker.request('botWorld.replyNeedsOwnerItem', {
        botId: 'missing-bot',
        itemNumber: 14,
        answerText: 'Yes',
      });
      assert.equal(unkBot.ok, false);
      if (!unkBot.ok) assert.equal(unkBot.code, 'unknown_bot');

      const unkItem = await worker.request('botWorld.replyNeedsOwnerItem', {
        botId: 'bot-sec',
        itemNumber: 999,
        answerText: 'Yes',
      });
      assert.equal(unkItem.ok, false);
      if (!unkItem.ok) assert.equal(unkItem.code, 'unknown_item');

      const pollsBefore = pollListCount;
      const okRes = await worker.request('botWorld.replyNeedsOwnerItem', {
        botId: 'bot-sec',
        itemNumber: 14,
        answerText: 'Restrict prefix',
      });
      assert.equal(okRes.ok, true);
      assert.equal(cliCalls.length, 1);
      assert.deepEqual(cliCalls[0], {
        botName: 'Security',
        itemNumber: 14,
        answerText: 'Restrict prefix',
      });
      assert.ok(pollListCount > pollsBefore, 'Successful reply triggers immediate refresh');

      // After refresh item is now in_progress, test cooldown on another needs_you item
      itemStillNeedsYou = true;
      await controller.runPollTick(true);
      const rateLimited = await worker.request('botWorld.replyNeedsOwnerItem', {
        botId: 'bot-sec',
        itemNumber: 14,
        answerText: 'Restrict prefix',
      });
      assert.equal(rateLimited.ok, false);
      if (!rateLimited.ok) assert.equal(rateLimited.code, 'rate_limited');
    } finally {
      await worker.deactivate();
    }

    // 5. Demo mode isolation & renderBotDetail action card modes
    const demo = createDemoOfficeSession(1_700_100_000_000);
    const demoRes = demo.replyNeedsOwnerItem('demo-security', 14, 'Restrict to staging prefix');
    assert.ok(demoRes);
    const demoPayload = demo.getPayload({
      themeId: 'startup_office',
      redactMode: false,
      locale: 'en',
      languageSetting: 'en',
      botAppearances: {},
    });
    assert.equal(demoPayload.snapshot.items['demo-item-14'].status, 'in_progress');
    assert.equal(demoPayload.snapshot.bots['demo-security'].status.kind, 'Working');

    withFakeDom(() => {
      const sample = makeNeedsYouSnapshot();
      const root = document.createElement('div');
      // Read-only mode
      renderBotDetail(root, {
        snapshot: sample,
        bot: sample.bots['bot-sec'],
        redactMode: false,
        botAppearances: {},
        locale: 'en',
        allowQuickSend: false,
        demoMode: false,
        onSelectCharacter: () => {},
        onFocusTerminal: () => {},
        onCopyReplyText: () => {},
      });
      const roText = collectDomText(root);
      assert.ok(roText.includes('Needs You · Quick Decision'));
      assert.ok(roText.includes('Restrict prefix'));
      assert.ok(roText.includes('Read-only mode'));
      assert.ok(roText.includes('Jump to Terminal'));

      // Redact mode hides prompt and options
      renderBotDetail(root, {
        snapshot: sample,
        bot: sample.bots['bot-sec'],
        redactMode: true,
        botAppearances: {},
        locale: 'en',
        allowQuickSend: true,
        demoMode: false,
        onSelectCharacter: () => {},
        onReplyNeedsOwnerItem: () => {},
      });
      const redText = collectDomText(root);
      assert.ok(!redText.includes('Restrict prefix'));
      assert.ok(!redText.includes('Should staging role restrict S3 list scope?'));
      assert.ok(redText.includes('hidden in Redact mode'));
    });
  });

  test('Watchdog stuck detection, 15m cooldown, Redact masking, and manifest setting', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve('orca-plugin.json'), 'utf8')) as {
      capabilities: Array<{ kind: string }>;
      contributes: {
        settings: Array<{
          key: string;
          type: string;
          minimum?: number;
          maximum?: number;
          default: unknown;
        }>;
      };
    };
    assert.equal(manifest.capabilities.length, 5);
    const stuckSetting = manifest.contributes.settings.find((s) => s.key === 'stuckThresholdMin');
    assert.ok(stuckSetting);
    assert.equal(stuckSetting.type, 'integer');
    assert.equal(stuckSetting.minimum, 0);
    assert.equal(stuckSetting.maximum, 180);
    assert.equal(stuckSetting.default, 15);
    assert.equal(clampStuckThresholdMin(0), 0);
    assert.equal(clampStuckThresholdMin(999), 180);
    assert.equal(clampStuckThresholdMin(-5), 0);

    const t0 = 1_700_200_000_000;
    const snap = makeNeedsYouSnapshot(t0);
    // threshold 0 disables watchdog
    assert.deepEqual(
      computeStuckAlerts(snap, { thresholdMin: 0, nowMs: t0, redactMode: false, locale: 'en' }),
      []
    );

    // bot-iac has lastActivityAt = t0 - 20m -> stuck 20m
    const normalAlerts = computeStuckAlerts(snap, {
      thresholdMin: 15,
      nowMs: t0,
      redactMode: false,
      locale: 'en',
    });
    assert.equal(normalAlerts.length, 1);
    assert.equal(normalAlerts[0].botId, 'bot-iac');
    assert.equal(normalAlerts[0].elapsedMinutes, 20);
    assert.equal(normalAlerts[0].lastTool, 'run_command');

    // Redact mode masks botName, lastTool, lastTaskTitle
    const redactedAlerts = computeStuckAlerts(snap, {
      thresholdMin: 15,
      nowMs: t0,
      redactMode: true,
      locale: 'en',
    });
    assert.equal(redactedAlerts.length, 1);
    assert.equal(redactedAlerts[0].botName, 'Bot #2');
    assert.equal(redactedAlerts[0].lastTool, null);
    assert.equal(redactedAlerts[0].lastTaskTitle, null);

    // Stateful tracker detects both stuck bot & active worker and resets when tool changes
    const tracker = new StuckWatchdogTracker();
    const freshSnap = makeNeedsYouSnapshot(t0);
    freshSnap.bots['bot-iac'].lastActivityAt = t0;
    assert.equal(tracker.evaluate(freshSnap, { thresholdMin: 15, nowMs: t0 }).length, 0);
    const stuckAt16m = tracker.evaluate(freshSnap, { thresholdMin: 15, nowMs: t0 + 16 * 60_000 });
    assert.equal(stuckAt16m.length, 2);
    assert.ok(stuckAt16m.some((a) => a.targetKind === 'bot' && a.botId === 'bot-iac'));
    assert.ok(stuckAt16m.some((a) => a.targetKind === 'worker' && a.workerDispatchId === 'w-sec-1'));

    freshSnap.bots['bot-iac'].currentTool = 'edit_file';
    freshSnap.bots['bot-iac'].status = { kind: 'Working', tool: 'edit_file' };
    const afterBotToolChange = tracker.evaluate(freshSnap, {
      thresholdMin: 15,
      nowMs: t0 + 16 * 60_000 + 1000,
    });
    assert.equal(afterBotToolChange.length, 1);
    assert.equal(afterBotToolChange[0].targetKind, 'worker');

    // DesktopNotificationManager enforces 15m cooldown and Redact masking
    const notifyCalls: Array<{ title: string; body: string }> = [];
    const fakeOrca = {
      host: {
        has: (m: string) => m === 'notifications.show',
        call: async (_m: string, params: { title: string; body: string }) => {
          notifyCalls.push(params);
          return { delivered: true };
        },
      },
      log: () => {},
    } as unknown as Parameters<DesktopNotificationManager['notifyStuckAlerts']>[0]['orca'];

    const mgr = new DesktopNotificationManager();
    assert.equal(STUCK_NOTIFY_COOLDOWN_MS, 15 * 60_000);

    const sent1 = await mgr.notifyStuckAlerts({
      alerts: redactedAlerts,
      snapshot: snap,
      enabled: true,
      thresholdMin: 15,
      redactMode: true,
      locale: 'en',
      nowMs: t0,
      orca: fakeOrca,
    });
    assert.equal(sent1.sent.length, 1);
    assert.ok(!notifyCalls[0].title.includes('Infra Ops'));
    assert.ok(!notifyCalls[0].body.includes('Apply staging VPC'));
    assert.ok(!notifyCalls[0].body.includes('run_command'));

    // Within 15m cooldown -> suppressed
    const sent2 = await mgr.notifyStuckAlerts({
      alerts: normalAlerts,
      snapshot: snap,
      enabled: true,
      thresholdMin: 15,
      redactMode: false,
      locale: 'en',
      nowMs: t0 + 10 * 60_000,
      orca: fakeOrca,
    });
    assert.equal(sent2.sent.length, 0);

    // After 15m cooldown -> fires again
    const sent3 = await mgr.notifyStuckAlerts({
      alerts: normalAlerts,
      snapshot: snap,
      enabled: true,
      thresholdMin: 15,
      redactMode: false,
      locale: 'en',
      nowMs: t0 + 15 * 60_000 + 1,
      orca: fakeOrca,
    });
    assert.equal(sent3.sent.length, 1);
    assert.ok(notifyCalls[1].title.includes('Infra Ops'));
  });

  test('Standup Markdown generation, Redact masking, and report modal preview/button', () => {
    const nowMs = 1_700_300_000_000;
    const snap = makeNeedsYouSnapshot(nowMs);
    const events: WorldEventRecord[] = [
      {
        timestampMs: nowMs - 45 * 60_000,
        summary: 'Working',
        redactedSummary: 'Working',
        event: { kind: 'BotWorking', botId: 'bot-iac', botName: 'Infra Ops', tool: 'run_command' },
      },
      {
        timestampMs: nowMs - 15 * 60_000,
        summary: 'Done',
        redactedSummary: 'Done',
        event: {
          kind: 'ItemDone',
          itemUid: 'done-1',
          number: 10,
          botId: 'bot-sec',
          botName: 'Security',
          title: 'Secret rotation AKIAIOSFODNN7EXAMPLE',
        },
      },
    ];
    const stuckAlerts = computeStuckAlerts(snap, {
      thresholdMin: 15,
      nowMs,
      redactMode: false,
      locale: 'en',
    });

    const mdNormal = buildStandupMarkdown(events, snap, {
      nowMs,
      redactMode: false,
      locale: 'en',
      stuckAlerts,
    });
    assert.ok(mdNormal.includes('Daily Bot Standup Summary'));
    assert.ok(mdNormal.includes('Infra Ops'));
    assert.ok(mdNormal.includes('⏳ 20m'));
    assert.ok(!mdNormal.includes('AKIAIOSFODNN7EXAMPLE'));

    const mdRedacted = buildStandupMarkdown(events, snap, {
      nowMs,
      redactMode: true,
      locale: 'ko',
      stuckAlerts: computeStuckAlerts(snap, {
        thresholdMin: 15,
        nowMs,
        redactMode: true,
        locale: 'ko',
      }),
    });
    assert.ok(mdRedacted.includes('가림 모드'));
    assert.ok(!mdRedacted.includes('Infra Ops'));
    assert.ok(!mdRedacted.includes('Security'));
    assert.ok(!mdRedacted.includes('Apply staging VPC'));
    assert.ok(!mdRedacted.includes('Staging IAM'));
    assert.ok(mdRedacted.includes('봇 #1'));
    assert.ok(mdRedacted.includes('⏳ 20m'));

    // Fallback mask if an unredacted report is formatted with redactMode: true
    const unredactedReport = buildOfficeReport(events, snap, {
      nowMs,
      redactMode: false,
      locale: 'en',
      stuckAlerts,
    });
    const fallbackMd = formatStandupMarkdown(unredactedReport, { redactMode: true, locale: 'en' });
    assert.ok(!fallbackMd.includes('Infra Ops'));
    assert.ok(!fallbackMd.includes('Apply staging VPC'));

    withFakeDom(() => {
      const backdrop = document.createElement('div');
      renderOfficeReportModal(backdrop, {
        open: true,
        report: unredactedReport,
        redactMode: false,
        locale: 'ko',
        copied: false,
        standupCopied: false,
        onCopyMarkdown: () => {},
        onCopyStandupMarkdown: () => {},
        onClose: () => {},
      });
      const modalText = collectDomText(backdrop);
      assert.ok(modalText.includes('스탠드업 요약 복사'));
      assert.ok(modalText.includes('일일 봇 스탠드업 요약'));
    });
  });

  test('Stage-1 visual polish: .bw-chip.bw-tb-fixed padding override, docsync width, and toolbar budgets', () => {
    const css = fs.readFileSync(path.resolve('shared/styles.css'), 'utf8');

    // .bw-chip.bw-tb-fixed enforces padding: 0 5px with higher specificity than .bw-chip
    const chipFixedMatch = /\.bw-status-pill\.bw-tb-fixed,\s*\.bw-chip\.bw-tb-fixed\s*\{([^}]*)\}/.exec(css);
    assert.ok(chipFixedMatch, 'Expected combined .bw-chip.bw-tb-fixed rule in styles.css');
    assert.ok(chipFixedMatch[1].includes('padding: 0 5px;'));

    const extractWidth = (className: string): number => {
      const re = new RegExp(`\\.${className}\\s*\\{[^}]*\\bwidth:\\s*(\\d+)px`);
      const m = re.exec(css);
      assert.ok(m, `Missing width for .${className}`);
      return Number(m[1]);
    };

    const docSyncW = extractWidth('bw-tb-w-docsync');
    const connPanelW = extractWidth('bw-tb-w-conn-panel');
    const titleEditorW = extractWidth('bw-tb-w-title-editor');
    assert.ok(docSyncW >= 100, `Expected bw-tb-w-docsync >= 100px, got ${docSyncW}`);
    assert.ok(connPanelW >= 96, `Expected bw-tb-w-conn-panel >= 96px, got ${connPanelW}`);
    assert.ok(titleEditorW >= 100, `Expected bw-tb-w-title-editor >= 100px, got ${titleEditorW}`);

    assert.ok(UI_STRINGS.ko.docSynced.length <= 16);

    const panelRow1Total =
      12 +
      4 +
      (extractWidth('bw-tb-w-title-panel') + connPanelW + 4) +
      (extractWidth('bw-tb-w-theme-panel') +
        extractWidth('bw-tb-w-view-panel') +
        extractWidth('bw-tb-w-demo-panel') +
        8);
    assert.ok(panelRow1Total <= 440, `Panel Row 1 width ${panelRow1Total}px must fit <= 440px`);

    const editorLeftTotal = titleEditorW + extractWidth('bw-tb-w-conn-editor') + docSyncW + 4;
    const editorRightTextTotal =
      extractWidth('bw-tb-w-theme-editor') +
      extractWidth('bw-tb-w-view') +
      extractWidth('bw-tb-w-atmo') +
      extractWidth('bw-tb-w-weather') +
      extractWidth('bw-tb-w-sound') +
      extractWidth('bw-tb-w-redact') +
      extractWidth('bw-tb-w-lang') +
      extractWidth('bw-tb-w-demo');
    const editorToolbarTotal =
      12 + 4 + editorLeftTotal + editorRightTextTotal + 10 * 26 + 20 * 2 + 3 * 1;
    assert.ok(editorToolbarTotal <= 1260, `Editor toolbar width ${editorToolbarTotal}px must fit <= 1260px`);
  });

  test('Stage-2 audit fixes: replay & offline suppression, tracker cap, standup cap, draft/lock, and UI bounds', () => {
    // 1. Offline (connected: false) suppresses stuck alerts in both pure helper and stateful tracker
    const t0 = 1_700_400_000_000;
    const offlineSnap = makeNeedsYouSnapshot(t0);
    offlineSnap.runtime.connected = false;
    assert.deepEqual(
      computeStuckAlerts(offlineSnap, { thresholdMin: 15, nowMs: t0, redactMode: false, locale: 'en' }),
      []
    );
    const offlineTracker = new StuckWatchdogTracker();
    assert.deepEqual(
      offlineTracker.evaluate(offlineSnap, { thresholdMin: 15, nowMs: t0 + 30 * 60_000 }),
      []
    );

    // 2. Replay suppression & Report Modal live stuckAlerts preservation in panel/editor entrypoints
    for (const entryPath of ['panel/main.ts', 'editor/main.ts']) {
      const src = fs.readFileSync(path.resolve(entryPath), 'utf8');
      assert.ok(
        /function activeStuckAlerts[\s\S]*?if \(replay\.isReplay\)\s*\{\s*return \[\];\s*\}/.test(src),
        `Expected activeStuckAlerts to return [] during replay in ${entryPath}`
      );
      assert.ok(
        /function renderReportModal[\s\S]*?isDemoMode\(\)[\s\S]*?: \(state\.payload\.stuckAlerts \?\? \[\]\)/.test(
          src
        ),
        `Expected renderReportModal to preserve live state.payload.stuckAlerts in ${entryPath}`
      );
      assert.ok(
        /async function handleReplyNeedsOwnerItem[\s\S]*?if \(replyingItemKey !== null\) return;/.test(src),
        `Expected concurrent click lock in handleReplyNeedsOwnerItem in ${entryPath}`
      );
    }

    // 3. StuckWatchdogTracker enforces MAX_TRACKED_WATCHDOG_ENTRIES (256) and resets cleanly when threshold === 0
    assert.equal(MAX_TRACKED_WATCHDOG_ENTRIES, 256);
    const boundedTracker = new StuckWatchdogTracker();
    const bigSnap = createEmptySnapshot();
    bigSnap.capturedAt = t0;
    bigSnap.initialSyncComplete = true;
    bigSnap.runtime.connected = true;
    for (let i = 0; i < 300; i++) {
      const id = `bot-cap-${i}`;
      bigSnap.bots[id] = {
        id,
        name: `Bot ${i}`,
        agent: 'claude',
        paused: false,
        specialty: 'Ops',
        status: { kind: 'Working', tool: 'read_file' },
        currentTaskTitle: `Task ${i}`,
        currentTool: 'read_file',
        lastActivityAt: t0 - 20 * 60_000,
        homeChatId: null,
        needsYouCount: 0,
        activeWorkerCount: 0,
      };
      bigSnap.botOrder.push(id);
    }
    const trackerInternals = boundedTracker as unknown as {
      bots: Map<string, unknown>;
      workers: Map<string, unknown>;
    };
    const cappedAlerts = boundedTracker.evaluate(bigSnap, {
      thresholdMin: 15,
      nowMs: t0,
      redactMode: false,
      locale: 'en',
    });
    assert.ok(cappedAlerts.length > 0, 'Expected stuck alerts on connected 300-bot snapshot');
    assert.equal(
      trackerInternals.bots.size,
      MAX_TRACKED_WATCHDOG_ENTRIES,
      `Expected tracked bots map to cap at ${MAX_TRACKED_WATCHDOG_ENTRIES}`
    );
    // threshold 0 disables & resets tracked maps without leaking stale alerts upon re-enable
    assert.deepEqual(
      boundedTracker.evaluate(bigSnap, { thresholdMin: 0, nowMs: t0 + 1000 }),
      []
    );
    assert.equal(trackerInternals.bots.size, 0);
    assert.equal(trackerInternals.workers.size, 0);

    // 4. Standup report prevents over-counting unclosed BotWorking spans when bot is no longer Working
    const reportSnap = createEmptySnapshot();
    reportSnap.capturedAt = t0;
    reportSnap.initialSyncComplete = true;
    reportSnap.runtime.connected = true;
    reportSnap.bots['bot-idle'] = {
      id: 'bot-idle',
      name: 'Auditor',
      agent: 'claude',
      paused: false,
      specialty: 'Audit',
      status: { kind: 'Idle' },
      currentTaskTitle: null,
      currentTool: null,
      lastActivityAt: t0 - 6 * 60 * 60_000,
      homeChatId: null,
      needsYouCount: 0,
      activeWorkerCount: 0,
    };
    reportSnap.botOrder = ['bot-idle'];
    const missedStopEvents: WorldEventRecord[] = [
      {
        timestampMs: t0 - 6 * 60 * 60_000,
        summary: 'Working',
        redactedSummary: 'Working',
        event: { kind: 'BotWorking', botId: 'bot-idle', botName: 'Auditor', tool: 'read_file' },
      },
    ];
    const report = buildOfficeReport(missedStopEvents, reportSnap, {
      nowMs: t0,
      redactMode: false,
      locale: 'en',
    });
    const idleStandup = report.standupBots.find((b) => b.botId === 'bot-idle');
    assert.ok(idleStandup);
    assert.ok(
      idleStandup.estimatedWorkMinutes <= 15,
      `Expected <= 15m conservative unclosed duration for Idle bot, got ${idleStandup.estimatedWorkMinutes}m`
    );

    // 5. renderBotDetail preserves custom input draft across snapshot re-renders & disables while another item replies
    withFakeDom(() => {
      const detailSnap = makeNeedsYouSnapshot(t0);
      detailSnap.items['item-15'] = {
        uid: 'item-15',
        number: 15,
        ownerBotId: 'bot-sec',
        ownerBotName: 'Security',
        title: 'Rotate staging token',
        status: 'needs_you',
        version: 1,
        lastEventId: null,
        questionPrompt: 'Proceed with rotation?',
        questionOptions: [{ label: 'Proceed', recommended: true }],
        optionsCount: 1,
        updatedAt: t0 - 1000,
      };
      const drafts = new Map<string, string>([['bot-sec:14', 'Use read-only staging bucket']]);
      const container = document.createElement('div');
      renderBotDetail(container, {
        snapshot: detailSnap,
        bot: detailSnap.bots['bot-sec'],
        redactMode: false,
        botAppearances: {},
        onSelectCharacter: () => {},
        locale: 'en',
        allowQuickSend: true,
        replyingItemKey: 'bot-sec:15',
        needsYouDrafts: drafts,
        onNeedsYouDraftChange: (k, v) => {
          drafts.set(k, v);
        },
        onReplyNeedsOwnerItem: () => {},
      });

      const findInputs = (node: unknown, out: HTMLInputElement[] = []): HTMLInputElement[] => {
        const n = node as { tag?: string; className?: string; children?: unknown[] };
        if (n.tag === 'input' && typeof n.className === 'string' && n.className.includes('bw-needs-custom-input')) {
          out.push(n as unknown as HTMLInputElement);
        }
        for (const ch of n.children ?? []) findInputs(ch, out);
        return out;
      };
      const inputs = findInputs(container);
      assert.equal(inputs.length, 2);
      assert.equal(inputs[0].value, 'Use read-only staging bucket');
      assert.equal(inputs[0].disabled, true);
      assert.equal(inputs[1].disabled, true);
    });

    // 6. Report modal header wrap CSS & top-clamp badge horizontal fallback exist
    const css = fs.readFileSync(path.resolve('shared/styles.css'), 'utf8');
    assert.ok(/\.bw-modal-header\s*\{[^}]*flex-wrap:\s*wrap/.test(css));
    assert.ok(/\.bw-modal-actions\s*\{[^}]*flex-wrap:\s*wrap/.test(css));
    const rendererSrc = fs.readFileSync(path.resolve('shared/stage-renderer.ts'), 'utf8');
    assert.ok(rendererSrc.includes('stuckX = lvRightEdge;'));
  });
});
