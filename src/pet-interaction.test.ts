import { assert, describe, hostError, mockHost, mountWorker, test } from 'orca/testing';
import { renderBotDetail } from '../shared/bot-detail-view.ts';
import { createDemoOfficeSession } from '../shared/demo-office.ts';
import { getThemeConfig } from '../shared/assets-catalog.ts';
import { MotionDirector } from '../shared/motion.ts';
import {
  MAX_PET_PARTICLES,
  MAX_PET_TOYS,
  PetTerrariumRenderer,
  PocketPetEngine,
  formatPetToolLabel,
} from '../shared/pet-terrarium.ts';
import { mapKeyToShortcutAction, renderShortcutsModal, shouldIgnoreShortcutEvent } from '../shared/shortcuts.ts';
import {
  OrcaCliError,
  assertAllowedSubcommand,
  buildQuickSendArgs,
  sendQuickBotMessage,
  validateQuickMessageBody,
} from './orca-cli.ts';
import type { OrcaClient } from './orca-cli.ts';
import {
  createEmptySnapshot,
  isValidPetToyKind,
  isValidViewMode,
  type WorldSnapshot,
} from './types.ts';
import { BotWorldWorkerController } from './worker.ts';

function makePetSnapshot(nowMs = 1_700_060_000_000): WorldSnapshot {
  const snap = createEmptySnapshot();
  snap.capturedAt = nowMs;
  snap.runtime.connected = true;
  snap.runtime.reachable = true;
  snap.bots['bot-idle'] = {
    id: 'bot-idle',
    name: 'Doc Alpaca',
    agent: 'claude',
    paused: false,
    specialty: 'Documentation',
    status: { kind: 'Idle' },
    currentTaskTitle: null,
    currentTool: null,
    lastActivityAt: nowMs - 10_000,
    homeChatId: 'chat-idle',
    needsYouCount: 0,
    activeWorkerCount: 0,
  };
  snap.bots['bot-work'] = {
    id: 'bot-work',
    name: 'Ops Lead',
    agent: 'claude',
    paused: false,
    specialty: 'Triage',
    status: { kind: 'Working', tool: 'read_file' },
    currentTaskTitle: 'Check PR queue',
    currentTool: 'read_file',
    lastActivityAt: nowMs - 2_000,
    homeChatId: 'chat-work',
    needsYouCount: 0,
    activeWorkerCount: 1,
  };
  snap.bots['bot-needs'] = {
    id: 'bot-needs',
    name: 'Security',
    agent: 'claude',
    paused: false,
    specialty: 'Auth Review',
    status: { kind: 'NeedsOwner', count: 1, prompt: 'Approve IAM policy?', optionsCount: 2 },
    currentTaskTitle: 'Review IAM diff',
    currentTool: null,
    lastActivityAt: nowMs - 5_000,
    homeChatId: 'chat-needs',
    needsYouCount: 1,
    activeWorkerCount: 0,
  };
  snap.bots['bot-err'] = {
    id: 'bot-err',
    name: 'Cost Guard',
    agent: 'gemini',
    paused: false,
    specialty: 'Spend',
    status: { kind: 'Error', message: 'Timeout' },
    currentTaskTitle: 'Daily check',
    currentTool: null,
    lastActivityAt: nowMs - 8_000,
    homeChatId: 'chat-err',
    needsYouCount: 0,
    activeWorkerCount: 0,
  };
  snap.bots['bot-wait'] = {
    id: 'bot-wait',
    name: 'Cloud Ops',
    agent: 'codex',
    paused: false,
    specialty: 'Deploy',
    status: { kind: 'WaitingAnswer' },
    currentTaskTitle: 'Wait for review',
    currentTool: null,
    lastActivityAt: nowMs - 9_000,
    homeChatId: 'chat-wait',
    needsYouCount: 0,
    activeWorkerCount: 0,
  };
  snap.botOrder = ['bot-idle', 'bot-work', 'bot-needs', 'bot-err', 'bot-wait'];
  snap.workers['w-live-1'] = {
    dispatchId: 'w-live-1',
    taskId: 't-1',
    runId: 'r-1',
    parentBotId: 'bot-work',
    parentBotName: 'Ops Lead',
    provider: 'codex',
    model: 'gpt-5',
    workerState: 'ready',
    dispatchStatus: 'dispatched',
    terminalState: 'attached',
    terminalHandle: 'term_worker_99',
    worktreeId: 'wt_worker_99',
    liveness: 'Live',
    activity: 'working',
    toolName: 'run_command',
    taskTitle: 'Run tests',
    updatedAt: nowMs - 1_000,
  };
  return snap;
}

function createWorkerMockClient(snap: WorldSnapshot): OrcaClient {
  return {
    isStopped: () => false,
    status: async () => ({
      ok: true,
      result: { runtime: { state: 'ready', reachable: true, runtimeId: 'rt-pet' } },
    }),
    botList: async () => ({
      ok: true,
      result: {
        bots: Object.values(snap.bots).map((b) => ({
          id: b.id,
          name: b.name,
          agent: b.agent,
          paused: b.paused,
          specialty: b.specialty,
        })),
      },
    }),
    botChats: async () => ({ ok: true, result: { chats: [] } }),
    botItemList: async () => ({ ok: true, result: { items: [] } }),
    worktreePs: async () => ({ ok: true, result: { worktrees: [] } }),
    orchestrationInbox: async () => ({ ok: true, result: { messages: [] } }),
    orchestrationWorkerList: async () => ({ ok: true, result: { workers: [] } }),
    orchestrationRunList: async () => ({ ok: true, result: { runs: [] } }),
    automationsList: async () => ({ ok: true, result: { automations: [] } }),
    automationsRuns: async () => ({ ok: true, result: { runs: [] } }),
  };
}

describe('Bot World v0.7.0 — Pocket Pet & Interaction', () => {
  test('PocketPetEngine syncs statuses, reacts to petting & toys within bounded caps, clamps dt, and masks in Redact Mode', () => {
    const engine = new PocketPetEngine(640, 280);
    const snap = makePetSnapshot();
    engine.syncSnapshot(snap, { botAppearances: {}, redactMode: true, locale: 'ko' });

    assert.equal(engine.pets.length, 5);
    const byId = new Map(engine.pets.map((p) => [p.botId, p]));
    assert.equal(byId.get('bot-idle')?.aiState, 'wandering');
    assert.equal(byId.get('bot-work')?.aiState, 'typing');
    assert.equal(byId.get('bot-needs')?.aiState, 'knocking');
    assert.equal(byId.get('bot-err')?.aiState, 'flustered');
    assert.equal(byId.get('bot-wait')?.aiState, 'thinking');

    // Redact Mode aliases follow Bot #N / 봇 #N strictly without leaking names
    assert.equal(byId.get('bot-idle')?.redactedAlias, '봇 #1');
    assert.equal(byId.get('bot-needs')?.redactedAlias, '봇 #3');

    // Step with huge dt -> clamped cleanly to MAX_PET_DT_SECS (0.25) and negative/NaN ignored
    engine.step(-5, { locale: 'ko' });
    assert.equal(engine.elapsedSecs, 0);
    engine.step(Number.NaN, { locale: 'ko' });
    assert.equal(engine.elapsedSecs, 0);
    engine.step(10, { locale: 'ko' });
    assert.ok(engine.elapsedSecs <= 0.2501);

    // NeedsOwner pet moves to front glass edge & emits knock ripples
    for (let i = 0; i < 10; i++) {
      engine.step(0.2, { locale: 'ko' });
    }
    assert.equal(byId.get('bot-needs')?.depthOffset, 1);
    assert.ok(engine.ripples.length > 0);

    // Petting spawns hearts and generic bilingual reaction without leaking bot name
    assert.equal(engine.interactWithPet('bot-idle', 'ko'), true);
    assert.ok((byId.get('bot-idle')?.vy ?? 0) < 0);
    assert.ok(byId.get('bot-idle')?.reactionText !== null);
    assert.ok(!String(byId.get('bot-idle')?.reactionText).includes('Doc Alpaca'));

    // Particle cap <= MAX_PET_PARTICLES (36) even after many headpats
    for (let i = 0; i < 20; i++) {
      engine.interactWithPet('bot-idle', 'en');
    }
    assert.ok(engine.particles.length <= MAX_PET_PARTICLES);

    // Toy cap <= MAX_PET_TOYS (8)
    for (let i = 0; i < 14; i++) {
      engine.dropToy(i % 3 === 0 ? 'coffee' : i % 3 === 1 ? 'ball' : 'treat');
    }
    assert.equal(engine.toys.length, MAX_PET_TOYS);

    // Idle pet chases & consumes a treat dropped nearby
    engine.toys = [];
    const idlePet = byId.get('bot-idle')!;
    engine.dropToy('treat', idlePet.x + 28);
    for (let i = 0; i < 12; i++) {
      engine.step(0.1, { locale: 'en' });
    }
    assert.equal(engine.toys.length, 0);
    assert.equal(idlePet.reactionText, 'Yum!');

    // Completion event triggers celebration
    engine.onEvents([{ kind: 'ItemDone', itemUid: 'i1', number: 1, botId: 'bot-work', botName: 'Ops Lead', title: 'Done' }], 'en');
    assert.equal(byId.get('bot-work')?.aiState, 'celebrating');
  });

  test('buildQuickSendArgs & sendQuickBotMessage validate strictly while assertAllowedSubcommand remains read-only', async () => {
    // Read-only allowlist MUST still reject orchestration send
    assert.throws(
      () => assertAllowedSubcommand(['orchestration', 'send', '--to', 'bot:Ops Lead', '--body', 'hi']),
      (err: unknown) => err instanceof OrcaCliError && err.code === 'disallowed_command'
    );

    const args = buildQuickSendArgs('Ops Lead', 'Check PR\r\nPlease\tverify');
    assert.deepEqual(args, [
      'orchestration',
      'send',
      '--to',
      'bot:Ops Lead',
      '--subject',
      'Bot World Quick Message',
      '--body',
      'Check PR\nPlease verify',
      '--json',
    ]);

    // Reject empty, >500 chars, control chars, NUL, and bad bot names
    assert.throws(() => validateQuickMessageBody('   '), (e: unknown) => e instanceof OrcaCliError);
    assert.throws(() => validateQuickMessageBody('a'.repeat(501)), (e: unknown) => e instanceof OrcaCliError);
    assert.throws(() => validateQuickMessageBody('hello\x00world'), (e: unknown) => e instanceof OrcaCliError);
    assert.throws(() => validateQuickMessageBody('hello\x1bworld'), (e: unknown) => e instanceof OrcaCliError);
    assert.throws(() => buildQuickSendArgs('-evil', 'hello'), (e: unknown) => e instanceof OrcaCliError);
    assert.throws(() => buildQuickSendArgs('bot;rm', 'hello'), (e: unknown) => e instanceof OrcaCliError);

    let capturedArgs: readonly string[] = [];
    const envelope = await sendQuickBotMessage('Ops Lead', 'Run tests', {
      runner: async (_bin, a) => {
        capturedArgs = a;
        return { stdout: JSON.stringify({ ok: true, result: { id: 'msg-1' } }), stderr: '', exitCode: 0 };
      },
    });
    assert.equal(envelope.ok, true);
    assert.deepEqual(capturedArgs, [
      'orchestration',
      'send',
      '--to',
      'bot:Ops Lead',
      '--subject',
      'Bot World Quick Message',
      '--body',
      'Run tests',
      '--json',
    ]);
  });

  test('Worker RPCs enforce allowQuickSend opt-in, unknown bot refusal, 2s cooldown, viewMode validation, and graceful teleport', async () => {
    const snap = makePetSnapshot();
    const client = createWorkerMockClient(snap);
    let clockMs = 10_000;
    const sentCalls: Array<{ botName: string; message: string }> = [];

    const host = mockHost({
      settings: {
        defaultTheme: 'startup_office',
        redactMode: false,
        pollIntervalSec: 5,
        allowQuickSend: false,
        viewMode: 'office',
      },
      results: {
        'terminal.focus': { focused: true },
        'workspace.open': { opened: true },
      },
    });

    let controller!: BotWorldWorkerController;
    let workerOrca!: Parameters<NonNullable<typeof import('./worker.ts').default>>[0];
    const worker = await mountWorker(
      {
        default: async (orca) => {
          workerOrca = orca;
          controller = new BotWorldWorkerController(orca, client, {
            nowMs: () => clockMs,
            quickSend: async (botName, message) => {
              sentCalls.push({ botName, message });
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
      // 1. viewMode RPC & validation
      const initial = await worker.request('botWorld.getState');
      assert.equal(initial.viewMode, 'office');
      assert.equal(initial.allowQuickSend, false);

      const vmRes = await worker.request('botWorld.setViewMode', { viewMode: 'pet' });
      assert.equal(vmRes.viewMode, 'pet');
      await assert.rejects(
        () => worker.request('botWorld.setViewMode', { viewMode: 'invalid' as 'office' }),
        (err: unknown) => (err as { code?: string })?.code === 'invalid_params'
      );

      // 2. Quick Send refused when allowQuickSend === false
      const disabledRes = await worker.request('botWorld.sendQuickMessage', {
        botId: 'bot-work',
        message: 'Hello!',
      });
      assert.equal(disabledRes.ok, false);
      if (!disabledRes.ok) assert.equal(disabledRes.code, 'disabled');
      assert.equal(sentCalls.length, 0);

      // 3. Enable allowQuickSend via settings -> unknown bot & invalid message still refused
      await workerOrca.settings.set('allowQuickSend', true);
      await new Promise((r) => setTimeout(r, 20));

      const unknownRes = await worker.request('botWorld.sendQuickMessage', {
        botId: 'non-existent-bot',
        message: 'Hello!',
      });
      assert.equal(unknownRes.ok, false);
      if (!unknownRes.ok) assert.equal(unknownRes.code, 'unknown_bot');

      const badMsgRes = await worker.request('botWorld.sendQuickMessage', {
        botId: 'bot-work',
        message: 'x'.repeat(501),
      });
      assert.equal(badMsgRes.ok, false);
      if (!badMsgRes.ok) assert.equal(badMsgRes.code, 'invalid_params');

      // 4. Valid opt-in send succeeds, then 2s cooldown blocks immediate repeat, succeeds after 2s
      const okRes = await worker.request('botWorld.sendQuickMessage', {
        botId: 'bot-work',
        message: 'Status check',
      });
      assert.deepEqual(okRes, { ok: true, botId: 'bot-work', botName: 'Ops Lead' });
      assert.deepEqual(sentCalls, [{ botName: 'Ops Lead', message: 'Status check' }]);

      clockMs += 500;
      const rateRes = await worker.request('botWorld.sendQuickMessage', {
        botId: 'bot-work',
        message: 'Again!',
      });
      assert.equal(rateRes.ok, false);
      if (!rateRes.ok) assert.equal(rateRes.code, 'rate_limited');
      assert.equal(sentCalls.length, 1);

      clockMs += 1_600;
      const afterCooldown = await worker.request('botWorld.sendQuickMessage', {
        botId: 'bot-work',
        message: 'After cooldown',
      });
      assert.equal(afterCooldown.ok, true);
      assert.equal(sentCalls.length, 2);

      // 5. Teleport RPCs succeed and reject invalid IDs
      const termOk = await worker.request('botWorld.focusTerminal', { terminalId: 'term_worker_99' });
      assert.deepEqual(termOk, { ok: true, focused: true });

      const wsOk = await worker.request('botWorld.openWorkspace', { workspaceId: 'wt_worker_99' });
      assert.deepEqual(wsOk, { ok: true, opened: true });

      await assert.rejects(
        () => worker.request('botWorld.focusTerminal', { terminalId: 'bad\nctrl' }),
        (err: unknown) => (err as { code?: string })?.code === 'invalid_params'
      );
      await assert.rejects(
        () => worker.request('botWorld.openWorkspace', { workspaceId: '   ' }),
        (err: unknown) => (err as { code?: string })?.code === 'invalid_params'
      );

      // Host refusal handled gracefully without crashing
      host.respond('terminal.focus', () => {
        throw hostError('capability_denied', 'Missing workspace:write');
      });
      const refusedTerm = await worker.request('botWorld.focusTerminal', { terminalId: 'term_worker_99' });
      assert.equal(refusedTerm.ok, false);
      assert.equal(refusedTerm.focused, false);
    } finally {
      await worker.deactivate();
    }
  });

  test('G shortcut, type guards, Demo Quick Send, MotionDirector courier, and detail teleport buttons work', () => {
    assert.equal(isValidViewMode('office'), true);
    assert.equal(isValidViewMode('pet'), true);
    assert.equal(isValidViewMode('terrarium'), false);
    assert.equal(isValidPetToyKind('coffee'), true);
    assert.equal(isValidPetToyKind('ball'), true);
    assert.equal(isValidPetToyKind('treat'), true);
    assert.equal(isValidPetToyKind('laser'), false);

    assert.equal(mapKeyToShortcutAction('g', { isEditor: true, modalOpen: false }), 'toggleViewMode');
    assert.equal(mapKeyToShortcutAction('G', { isEditor: false, modalOpen: false }), 'toggleViewMode');
    assert.equal(mapKeyToShortcutAction('g', { isEditor: true, modalOpen: true }), null);
    assert.equal(
      shouldIgnoreShortcutEvent({ key: 'g', target: { tagName: 'INPUT' } as unknown as EventTarget }),
      true
    );

    // Demo Quick Send & MotionDirector paper plane
    const demo = createDemoOfficeSession(1_700_070_000_000);
    const sent = demo.sendQuickMessage('demo-cost-guard', 'Check daily spend');
    assert.ok(sent !== null);
    const payload = demo.getPayload({
      themeId: 'startup_office',
      redactMode: false,
      locale: 'en',
      languageSetting: 'en',
      botAppearances: {},
    });
    assert.equal(payload.snapshot.bots['demo-cost-guard'].status.kind, 'Working');

    const motion = new MotionDirector();
    const theme = getThemeConfig('startup_office', 'en');
    const launched = motion.launchQuickMessageCourier(
      'demo-cost-guard',
      payload.snapshot,
      theme,
      'Check daily spend',
      false
    );
    assert.equal(launched, true);
    assert.equal(motion.couriers.length, 1);
    assert.equal(motion.couriers[0].kind, 'paper_plane');

    const replyEv = demo.receiveQuickMessageReply('demo-cost-guard', 'ko');
    assert.ok(replyEv !== null && replyEv.kind === 'Reply');

    // Minimal DOM check for Shortcuts Help G row and renderBotDetail Teleport buttons
    const g = globalThis as unknown as Record<string, unknown>;
    const prevDoc = g.document;
    const prevNode = g.Node;
    const prevInput = g.HTMLInputElement;
    const prevImg = g.HTMLImageElement;
    try {
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
        attrs: Record<string, string> = {};
        listeners: Record<string, Array<() => void>> = {};
        classList = { toggle: () => {} };
        setAttribute(k: string, v: string): void {
          this.attrs[k] = v;
        }
        addEventListener(ev: string, fn: () => void): void {
          this.listeners[ev] = this.listeners[ev] ?? [];
          this.listeners[ev].push(fn);
        }
      }
      class FakeHtmlInput extends FakeElement {
        type = '';
        value = '';
        placeholder = '';
      }
      class FakeHtmlImage extends FakeElement {
        src = '';
        alt = '';
      }

      g.Node = FakeNode;
      g.HTMLInputElement = FakeHtmlInput;
      g.HTMLImageElement = FakeHtmlImage;
      g.document = {
        createElement: (tag: string) =>
          tag === 'img'
            ? new FakeHtmlImage(tag)
            : tag === 'input'
              ? new FakeHtmlInput(tag)
              : new FakeElement(tag),
        createTextNode: (text: string) => {
          const n = new FakeNode('#text');
          n.textContent = text;
          return n;
        },
      };

      const collectText = (n: FakeNode): string => {
        if (n.children.length === 0) return n.textContent;
        return n.children.map(collectText).join(' ');
      };
      const collectButtons = (n: FakeNode): FakeElement[] => {
        const out: FakeElement[] = n instanceof FakeElement && n.tag === 'button' ? [n] : [];
        for (const c of n.children) out.push(...collectButtons(c));
        return out;
      };

      const modalRoot = new FakeElement('div');
      renderShortcutsModal(modalRoot as unknown as HTMLElement, {
        open: true,
        locale: 'en',
        isEditor: true,
        onClose: () => {},
      });
      assert.ok(collectText(modalRoot).includes('Toggle Office / Pocket Pet view'));

      const detailRoot = new FakeElement('div');
      const snap = makePetSnapshot();
      let focusedTerm = '';
      let openedWs = '';
      renderBotDetail(detailRoot as unknown as HTMLElement, {
        snapshot: snap,
        bot: snap.bots['bot-work'],
        redactMode: false,
        botAppearances: {},
        locale: 'en',
        onSelectCharacter: () => {},
        onFocusTerminal: (id) => {
          focusedTerm = id;
        },
        onOpenWorkspace: (id) => {
          openedWs = id;
        },
      });
      const btns = collectButtons(detailRoot);
      const termBtn = btns.find((b) => collectText(b).includes('↗ Terminal'));
      const wsBtn = btns.find((b) => collectText(b).includes('↗ Workspace'));
      const jumpBtn = btns.find((b) => collectText(b).includes('↗ Jump to Active Terminal'));
      assert.ok(termBtn !== undefined);
      assert.ok(wsBtn !== undefined);
      assert.ok(jumpBtn !== undefined);
      termBtn.listeners['click']?.[0]?.();
      wsBtn.listeners['click']?.[0]?.();
      assert.equal(focusedTerm, 'term_worker_99');
      assert.equal(openedWs, 'wt_worker_99');
    } finally {
      g.document = prevDoc;
      g.Node = prevNode;
      g.HTMLInputElement = prevInput;
      g.HTMLImageElement = prevImg;
    }
  });

  test('PetTerrariumRenderer truncates long tool names on narrow width, avoids pill overlap, and renders all 4 theme backdrops', () => {
    assert.equal(formatPetToolLabel('read_file', true), 'read_file');
    assert.equal(formatPetToolLabel('run_command', true), 'run_command');
    assert.equal(formatPetToolLabel('search_documents', true), 'search_docu…');
    assert.equal(formatPetToolLabel('search_documents', true).length, 12);
    assert.equal(formatPetToolLabel('search_documents', false), 'search_documents');

    const g = globalThis as unknown as Record<string, unknown>;
    const prevWin = g.window;
    const prevImg = g.Image;
    const prevRaf = g.requestAnimationFrame;
    const prevCaf = g.cancelAnimationFrame;
    try {
      let canvasCssW = 440;
      let canvasCssH = 245;
      const drawnTexts: Array<{ text: string; x: number; y: number }> = [];
      const fakeCtx = {
        save: () => {},
        restore: () => {},
        setTransform: () => {},
        clearRect: () => {},
        fillRect: () => {},
        strokeRect: () => {},
        drawImage: () => {},
        translate: () => {},
        scale: () => {},
        createLinearGradient: () => ({ addColorStop: () => {} }),
        createRadialGradient: () => ({ addColorStop: () => {} }),
        beginPath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        arc: () => {},
        ellipse: () => {},
        quadraticCurveTo: () => {},
        closePath: () => {},
        fill: () => {},
        stroke: () => {},
        measureText: (t: string) => ({ width: t.length * 6 }),
        fillText: (text: string, x: number, y: number) => {
          drawnTexts.push({ text, x, y });
        },
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        lineCap: 'butt',
        font: '',
        textAlign: 'left',
        textBaseline: 'middle',
        globalAlpha: 1,
        filter: 'none',
      };
      const fakeCanvas = {
        width: 440,
        height: 245,
        style: { cursor: 'default' },
        getContext: () => fakeCtx,
        getBoundingClientRect: () => ({
          left: 0,
          top: 0,
          width: canvasCssW,
          height: canvasCssH,
          right: canvasCssW,
          bottom: canvasCssH,
        }),
        addEventListener: () => {},
        removeEventListener: () => {},
      } as unknown as HTMLCanvasElement;

      g.window = { devicePixelRatio: 1 };
      g.requestAnimationFrame = () => 1;
      g.cancelAnimationFrame = () => {};
      g.Image = class FakeImage {
        complete = false;
        naturalWidth = 0;
        src = '';
        onload: (() => void) | null = null;
      };

      const renderer = new PetTerrariumRenderer(fakeCanvas, { onSelectAndPet: () => {} });
      const snap = makePetSnapshot();
      snap.bots['bot-idle'].status = { kind: 'Working', tool: 'search_documents' };

      const themes = ['startup_office', 'corporate_office', 'cozy_cafe', 'cyber_ops'] as const;
      for (const themeId of themes) {
        drawnTexts.length = 0;
        canvasCssW = 440;
        canvasCssH = 245;
        renderer.update({
          snapshot: snap,
          themeId,
          atmosphereMode: 'night',
          weatherMode: 'auto',
          displayTimestampMs: snap.capturedAt,
          selectedBotId: 'bot-work',
          redactMode: false,
          botAppearances: {},
          locale: 'en',
        });
        renderer.setActive(true);
        // Place two working pets right next to each other -> second badge shifts up to avoid horizontal collision
        renderer.engine.pets[0].x = 120;
        renderer.engine.pets[1].x = 126;
        drawnTexts.length = 0;
        renderer.renderNow();

        assert.ok(drawnTexts.some((t) => t.text === '▶ search_docu…'));
        const badge1 = drawnTexts.find((t) => t.text === '▶ search_docu…');
        const badge2 = drawnTexts.find((t) => t.text === '▶ read_file');
        assert.ok(badge1 && badge2 && Math.abs(badge1.y - badge2.y) >= 16);

        // Wide editor width keeps full tool label
        canvasCssW = 960;
        canvasCssH = 420;
        drawnTexts.length = 0;
        renderer.renderNow();
        assert.ok(drawnTexts.some((t) => t.text === '▶ search_documents'));
      }
      renderer.dispose();
    } finally {
      g.window = prevWin;
      g.Image = prevImg;
      g.requestAnimationFrame = prevRaf;
      g.cancelAnimationFrame = prevCaf;
    }
  });
});
