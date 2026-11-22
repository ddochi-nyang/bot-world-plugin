import { assert, describe, mockHost, mountWorker, test } from 'orca/testing';
import { encodeBotWorldContent, mergeBotWorldDocuments } from '../editor/doc-sync.ts';
import { getThemeConfig } from '../shared/assets-catalog.ts';
import { createDemoOfficeSession } from '../shared/demo-office.ts';
import { MAX_COURIERS, MotionDirector } from '../shared/motion.ts';
import {
  mapKeyToShortcutAction,
  nextAtmosphereMode,
  shouldIgnoreShortcutEvent,
} from '../shared/shortcuts.ts';
import { resolveAtmospherePhase } from '../shared/stage-renderer.ts';
import type { OrcaClient } from './orca-cli.ts';
import {
  DEFAULT_BOTWORLD_DOCUMENT,
  createEmptySnapshot,
  validateBotWorldDocument,
} from './types.ts';
import { BotWorldWorkerController } from './worker.ts';

function createMinimalClient(): OrcaClient {
  return {
    isStopped: () => false,
    status: async () => ({
      ok: true,
      result: { runtime: { state: 'ready', reachable: true, runtimeId: 'rt-atmo' } },
    }),
    botList: async () => ({
      ok: true,
      result: {
        bots: [{ id: 'b1', name: 'Ops Lead', agent: 'claude', paused: false, specialty: 'Triage' }],
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

function makeBotSnapshot() {
  const snap = createEmptySnapshot();
  snap.bots['b1'] = {
    id: 'b1',
    name: 'Ops Lead',
    agent: 'claude',
    paused: false,
    specialty: 'Triage',
    status: { kind: 'Working', tool: 'read_file' },
    currentTaskTitle: 'Review PR',
    currentTool: 'read_file',
    lastActivityAt: 1000,
    homeChatId: 'c1',
    needsYouCount: 0,
    activeWorkerCount: 1,
  };
  snap.bots['b2'] = {
    id: 'b2',
    name: 'Security',
    agent: 'claude',
    paused: false,
    specialty: 'Auth',
    status: { kind: 'Idle' },
    currentTaskTitle: null,
    currentTool: null,
    lastActivityAt: 1000,
    homeChatId: 'c2',
    needsYouCount: 0,
    activeWorkerCount: 0,
  };
  snap.botOrder = ['b1', 'b2'];
  return snap;
}

describe('Bot World v0.2.0: Atmosphere, Couriers/Worker Motion, Shortcuts, and Refinements', () => {
  test('resolveAtmospherePhase maps auto hours (day/sunset/night) and respects explicit overrides', () => {
    const atHour = (h: number) => new Date(2026, 10, 22, h, 30, 0).getTime();

    for (const h of [7, 9, 12, 16]) {
      assert.equal(resolveAtmospherePhase('auto', atHour(h)), 'day', `hour ${h} should be day`);
    }
    for (const h of [17, 18, 19]) {
      assert.equal(resolveAtmospherePhase('auto', atHour(h)), 'sunset', `hour ${h} should be sunset`);
    }
    for (const h of [20, 22, 23, 0, 3, 6]) {
      assert.equal(resolveAtmospherePhase('auto', atHour(h)), 'night', `hour ${h} should be night`);
    }

    assert.equal(resolveAtmospherePhase('day', atHour(23)), 'day');
    assert.equal(resolveAtmospherePhase('sunset', atHour(10)), 'sunset');
    assert.equal(resolveAtmospherePhase('night', atHour(12)), 'night');
  });

  test('MotionDirector spawns curved FlyingCouriers, caps at MAX_COURIERS, sparks on arrival, and clears transients', () => {
    const motion = new MotionDirector();
    const snap = makeBotSnapshot();
    const theme = getThemeConfig('startup_office', 'en');

    motion.enqueueEvents(
      [
        {
          kind: 'Handoff',
          messageId: 'm1',
          from: { kind: 'Bot', botId: 'b1', botName: 'Ops Lead' },
          to: { kind: 'Bot', botId: 'b2', botName: 'Security' },
          subject: 'Check IAM',
        },
        {
          kind: 'Question',
          messageId: 'm2',
          from: { kind: 'Bot', botId: 'b2', botName: 'Security' },
          to: { kind: 'BossDesk' },
          subject: 'Confirm policy?',
        },
        {
          kind: 'Reply',
          messageId: 'm3',
          from: { kind: 'BossDesk' },
          to: { kind: 'Bot', botId: 'b2', botName: 'Security' },
          subject: 'Approved',
        },
        {
          kind: 'StatusReport',
          messageId: 'm4',
          from: { kind: 'Bot', botId: 'b1', botName: 'Ops Lead' },
          to: { kind: 'BossDesk' },
          subject: 'Done',
        },
      ],
      snap,
      theme,
      'en'
    );

    assert.equal(motion.couriers.length, 4);
    assert.equal(motion.couriers[0].kind, 'paper_plane');
    assert.equal(motion.couriers[1].kind, 'envelope');
    assert.equal(motion.couriers[2].kind, 'paper_plane');
    assert.equal(motion.couriers[3].kind, 'envelope');
    assert.ok(motion.hasActiveAnimations());

    // Step midway -> couriers advance smoothly
    motion.step(0.5, snap, theme);
    assert.equal(motion.couriers.length, 4);
    assert.ok(motion.couriers[0].elapsed > 0);

    // Step past duration -> couriers expire and emit arrival Sparkle particles
    for (let i = 0; i < 6; i++) {
      motion.step(0.2, snap, theme);
    }
    assert.equal(motion.couriers.length, 0);
    assert.ok(motion.particles.some((p) => p.kind === 'Sparkle'));

    // Burst cap enforces MAX_COURIERS = 6
    const burst = Array.from({ length: 12 }, (_, idx) => ({
      kind: 'Reply' as const,
      messageId: `burst-${idx}`,
      from: { kind: 'Bot' as const, botId: 'b1', botName: 'Ops Lead' },
      to: { kind: 'Bot' as const, botId: 'b2', botName: 'Security' },
      subject: `Msg ${idx}`,
    }));
    motion.enqueueEvents(burst, snap, theme, 'en');
    assert.equal(motion.couriers.length, MAX_COURIERS);

    motion.clearTransients();
    assert.equal(motion.couriers.length, 0);
    assert.equal(motion.hasActiveAnimations(), false);
  });

  test('MotionDirector handles WorkerStart entrance and WorkerDone / WorkerExited / WorkerReleased departure walks', () => {
    const motion = new MotionDirector();
    const snap = makeBotSnapshot();
    const theme = getThemeConfig('startup_office', 'en');

    // WorkerStart enters from officeDoor
    motion.enqueueEvents(
      [
        {
          kind: 'WorkerStart',
          dispatchId: 'w-enter',
          parentBotId: 'b1',
          parentBotName: 'Ops Lead',
          provider: 'claude',
          taskTitle: 'Audit',
        },
      ],
      snap,
      theme,
      'en'
    );
    const enterMotions = motion.activeWorkerMotions();
    assert.equal(enterMotions.length, 1);
    assert.equal(enterMotions[0].meta.kind, 'Entering');
    assert.equal(enterMotions[0].pose.footX, theme.officeDoor.x);
    assert.equal(enterMotions[0].pose.footY, theme.officeDoor.y);

    // Stepping produces trail sparkles and settles walk
    for (let i = 0; i < 15; i++) {
      motion.step(0.2, snap, theme);
    }
    assert.equal(motion.activeWorkerMotions().length, 0);
    assert.ok(motion.particles.some((p) => p.kind === 'Sparkle'));

    // WorkerDone (not visible in snapshot) -> delivers to parent then departs toward officeDoor
    motion.clearTransients();
    motion.enqueueEvents(
      [
        {
          kind: 'WorkerDone',
          dispatchId: 'w-done',
          parentBotId: 'b1',
          parentBotName: 'Ops Lead',
          subject: 'Finished',
        },
      ],
      snap,
      theme,
      'en'
    );
    const doneMotions = motion.activeWorkerMotions();
    assert.equal(doneMotions.length, 1);
    assert.equal(doneMotions[0].meta.kind, 'Leaving');
    for (let i = 0; i < 16; i++) {
      motion.step(0.2, snap, theme);
    }
    assert.equal(motion.activeWorkerMotions().length, 0);

    // WorkerExited -> spawns departure walk toward officeDoor
    motion.clearTransients();
    motion.enqueueEvents(
      [
        {
          kind: 'WorkerExited',
          dispatchId: 'w-exit',
          parentBotId: 'b1',
          parentBotName: 'Ops Lead',
          provider: 'codex',
        },
      ],
      snap,
      theme,
      'en'
    );
    const exitMotions = motion.activeWorkerMotions();
    assert.equal(exitMotions.length, 1);
    assert.equal(exitMotions[0].meta.kind, 'Leaving');
  });

  test('.botworld document validation/merge/encode and worker botWorld.setAtmosphereMode RPC persist & reject invalid values', async () => {
    // Document parsing backward-compatibility and invalid atmosphereMode fallback
    const legacyParsed = validateBotWorldDocument(
      JSON.stringify({
        version: 1,
        themeId: 'corporate_office',
        redactMode: false,
        selectedBotId: null,
        botAppearances: {},
      })
    );
    assert.equal(legacyParsed.valid, true);
    assert.equal(legacyParsed.data.atmosphereMode, 'auto');

    const invalidAtmoParsed = validateBotWorldDocument(
      JSON.stringify({
        version: 1,
        themeId: 'startup_office',
        atmosphereMode: 'midnight_evil',
        redactMode: false,
        selectedBotId: null,
        botAppearances: {},
      })
    );
    assert.equal(invalidAtmoParsed.valid, true);
    assert.equal(invalidAtmoParsed.data.atmosphereMode, 'auto');

    const merged = mergeBotWorldDocuments(
      DEFAULT_BOTWORLD_DOCUMENT,
      { ...DEFAULT_BOTWORLD_DOCUMENT, atmosphereMode: 'sunset' },
      { ...DEFAULT_BOTWORLD_DOCUMENT, atmosphereMode: 'invalid' as unknown as 'auto' }
    );
    assert.equal(merged.atmosphereMode, 'sunset');

    const encoded = encodeBotWorldContent({
      ...DEFAULT_BOTWORLD_DOCUMENT,
      atmosphereMode: 'bad' as unknown as 'auto',
    });
    assert.ok(encoded.text.includes('"atmosphereMode": "auto"'));

    // Worker RPC & settings sync
    const host = mockHost({
      settings: {
        defaultTheme: 'startup_office',
        atmosphereMode: 'auto',
        redactMode: false,
        pollIntervalSec: 5,
        language: 'auto',
      },
    });
    let controller!: BotWorldWorkerController;
    let workerOrca!: Parameters<NonNullable<typeof import('./worker.ts').default>>[0];
    const worker = await mountWorker(
      {
        default: async (orca) => {
          workerOrca = orca;
          controller = new BotWorldWorkerController(orca, createMinimalClient());
          await controller.init({ disableAutoLoop: true });
        },
        deactivate: async () => {
          controller.dispose();
        },
      },
      { host }
    );

    try {
      const initial = await worker.request('botWorld.getState');
      assert.equal(initial.atmosphereMode, 'auto');

      const setRes = await worker.request('botWorld.setAtmosphereMode', {
        atmosphereMode: 'night',
      });
      assert.equal(setRes.atmosphereMode, 'night');

      const afterSet = await worker.request('botWorld.getState');
      assert.equal(afterSet.atmosphereMode, 'night');
      const savedPrefs = host.data().storage['botWorld.prefs'] as { atmosphereMode?: string };
      assert.equal(savedPrefs.atmosphereMode, 'night');

      await assert.rejects(
        () =>
          worker.request('botWorld.setAtmosphereMode', {
            atmosphereMode: 'dawn' as unknown as 'auto',
          }),
        (err: unknown) => (err as { code?: string })?.code === 'invalid_params'
      );

      // Explicit settings change overrides UI override
      await workerOrca.settings.set('atmosphereMode', 'sunset');
      await new Promise((r) => setTimeout(r, 25));
      const afterSettingChange = await worker.request('botWorld.getState');
      assert.equal(afterSettingChange.atmosphereMode, 'sunset');
    } finally {
      await worker.deactivate();
    }
  });

  test('shouldIgnoreShortcutEvent, mapKeyToShortcutAction, and nextAtmosphereMode behave safely', () => {
    assert.equal(shouldIgnoreShortcutEvent({ target: { tagName: 'INPUT' } as unknown as EventTarget }), true);
    assert.equal(
      shouldIgnoreShortcutEvent({ target: { tagName: 'TEXTAREA' } as unknown as EventTarget }),
      true
    );
    assert.equal(
      shouldIgnoreShortcutEvent({ target: { tagName: 'SELECT' } as unknown as EventTarget }),
      true
    );
    assert.equal(
      shouldIgnoreShortcutEvent({
        target: { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget,
      }),
      true
    );
    assert.equal(shouldIgnoreShortcutEvent({ ctrlKey: true, target: null }), true);
    assert.equal(shouldIgnoreShortcutEvent({ metaKey: true, target: null }), true);
    assert.equal(shouldIgnoreShortcutEvent({ altKey: true, target: null }), true);

    assert.equal(
      shouldIgnoreShortcutEvent({ target: { tagName: 'DIV', isContentEditable: false } as unknown as EventTarget }),
      false
    );
    assert.equal(shouldIgnoreShortcutEvent({ target: null }), false);

    assert.equal(mapKeyToShortcutAction('t'), 'toggleTheme');
    assert.equal(mapKeyToShortcutAction('R'), 'toggleRedact');
    assert.equal(mapKeyToShortcutAction('l'), 'toggleLanguage');
    assert.equal(mapKeyToShortcutAction('A'), 'cycleAtmosphere');
    assert.equal(mapKeyToShortcutAction('d'), 'toggleDemo');
    assert.equal(mapKeyToShortcutAction('?', { isEditor: false }), 'toggleHelp');
    assert.equal(mapKeyToShortcutAction('Escape'), 'closeOrClearSelection');
    assert.equal(mapKeyToShortcutAction(' ', { isEditor: true }), 'toggleReplayPlay');
    assert.equal(mapKeyToShortcutAction(' ', { isEditor: false }), null);

    assert.equal(nextAtmosphereMode('auto'), 'day');
    assert.equal(nextAtmosphereMode('day'), 'sunset');
    assert.equal(nextAtmosphereMode('sunset'), 'night');
    assert.equal(nextAtmosphereMode('night'), 'auto');
  });

  test('DemoOfficeSession aligns WorkerStart redacted provider/summary seq and preserves auto.lastError when unredacted', () => {
    const t0 = 1_700_000_000_000;
    const session = createDemoOfficeSession(t0);
    // Advance through 2 ticks so tick #1 emits WorkerStart with seq >= 5
    session.tick(t0 + 2_600);
    session.tick(t0 + 5_200);

    // Inject an automation error to verify unredacted vs redacted behavior
    const internal = session as unknown as {
      snapshot: ReturnType<typeof createEmptySnapshot>;
    };
    internal.snapshot.automations['demo-auto-1'].lastError = 'Timeout waiting for registry';

    const unredacted = session.getPayload({
      themeId: 'startup_office',
      atmosphereMode: 'sunset',
      redactMode: false,
      locale: 'en',
      languageSetting: 'en',
      botAppearances: {},
    });
    assert.equal(unredacted.atmosphereMode, 'sunset');
    assert.equal(
      unredacted.snapshot.automations['demo-auto-1'].lastError,
      'Timeout waiting for registry'
    );

    const redactedEn = session.getPayload({
      themeId: 'startup_office',
      atmosphereMode: 'sunset',
      redactMode: true,
      locale: 'en',
      languageSetting: 'en',
      botAppearances: {},
    });
    assert.equal(
      redactedEn.snapshot.automations['demo-auto-1'].lastError,
      'Error details hidden'
    );

    const workerStarts = redactedEn.events.filter((r) => r.event.kind === 'WorkerStart');
    assert.ok(workerStarts.length >= 2);
    for (const rec of workerStarts) {
      assert.ok(typeof rec.workerSeq === 'number');
      assert.equal(rec.redactedSummary, `Worker #${rec.workerSeq}`);
      if (rec.event.kind === 'WorkerStart') {
        assert.equal(rec.event.provider, `Worker #${rec.workerSeq}`);
      }
    }
  });
});
