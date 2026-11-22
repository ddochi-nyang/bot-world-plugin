import fs from 'node:fs';
import path from 'node:path';
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing';
import { decodeBotWorldContent, encodeBotWorldContent, mergeBotWorldDocuments } from '../editor/doc-sync.ts';
import { getThemeConfig } from '../shared/assets-catalog.ts';
import { resolveFollowTargetBotId } from '../shared/camera.ts';
import { createDemoOfficeSession } from '../shared/demo-office.ts';
import { tStrings } from '../shared/i18n.ts';
import {
  MAX_PARTICLES,
  MILESTONE_THRESHOLDS,
  MilestoneTracker,
  MotionDirector,
  countDailyCompletions,
  detectCrossedMilestone,
  hasErrorDeskBeacon,
  isCompletionEvent,
} from '../shared/motion.ts';
import {
  type OfficeReport,
  formatReportMarkdown,
  renderOfficeReportModal,
} from '../shared/office-report.ts';
import {
  mapKeyToShortcutAction,
  nextSoundMode,
  nextWeatherMode,
  renderShortcutsModal,
  shouldIgnoreShortcutEvent,
} from '../shared/shortcuts.ts';
import {
  type AudioContextLike,
  SoundscapeEngine,
  classifyEventSoundCue,
  resolveAmbientProfile,
} from '../shared/soundscape.ts';
import {
  MAX_RAIN_PARTICLES,
  MAX_RAIN_RIPPLES,
  MAX_SNOW_PARTICLES,
  MAX_STARLIGHT_PARTICLES,
  WeatherSystem,
  resolveWeatherKind,
} from '../shared/weather.ts';
import type { OrcaClient } from './orca-cli.ts';
import {
  DEFAULT_BOTWORLD_DOCUMENT,
  type WeatherMode,
  type WorldEventRecord,
  createEmptySnapshot,
  isValidSoundMode,
  isValidWeatherMode,
  validateBotWorldDocument,
} from './types.ts';
import { BotWorldWorkerController } from './worker.ts';

function createMinimalClient(): OrcaClient {
  return {
    isStopped: () => false,
    status: async () => ({
      ok: true,
      result: { runtime: { state: 'ready', reachable: true, runtimeId: 'rt-sw' } },
    }),
    botList: async () => ({
      ok: true,
      result: {
        bots: [
          { id: 'b1', name: 'Ops Lead', agent: 'claude', paused: false, specialty: 'Triage' },
          { id: 'b2', name: 'Security', agent: 'claude', paused: false, specialty: 'Auth' },
        ],
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

function makeFakeAudioContext() {
  let oscCreated = 0;
  let oscStopped = 0;
  let bufferSourcesCreated = 0;
  let bufferSourcesStopped = 0;
  let closed = false;
  let resumed = false;
  let nowSec = 10;

  const makeParam = () => ({
    setValueAtTime: () => {},
    linearRampToValueAtTime: () => {},
    exponentialRampToValueAtTime: () => {},
  });

  const ctx: AudioContextLike = {
    get currentTime() {
      return nowSec;
    },
    sampleRate: 22050,
    state: 'suspended',
    destination: {
      connect: (d) => d,
      disconnect: () => {},
    },
    resume: () => {
      resumed = true;
    },
    close: () => {
      closed = true;
    },
    createGain: () => ({
      gain: makeParam(),
      connect: (d) => d,
      disconnect: () => {},
    }),
    createOscillator: () => {
      oscCreated += 1;
      const osc = {
        type: 'sine',
        frequency: makeParam(),
        onended: null as (() => void) | null,
        connect: (d: ReturnType<AudioContextLike['createGain']>) => d,
        disconnect: () => {},
        start: () => {},
        stop: () => {
          oscStopped += 1;
        },
      };
      return osc as unknown as ReturnType<AudioContextLike['createOscillator']>;
    },
    createBiquadFilter: () => ({
      type: 'bandpass',
      frequency: makeParam(),
      Q: makeParam(),
      connect: (d) => d,
      disconnect: () => {},
    }),
    createBuffer: (_channels, length) => {
      const buf = new Float32Array(length);
      return {
        getChannelData: () => buf,
      };
    },
    createBufferSource: () => {
      bufferSourcesCreated += 1;
      const src = {
        buffer: null,
        loop: false,
        onended: null as (() => void) | null,
        connect: (d: ReturnType<AudioContextLike['createGain']>) => d,
        disconnect: () => {},
        start: () => {},
        stop: () => {
          bufferSourcesStopped += 1;
        },
      };
      return src as unknown as ReturnType<AudioContextLike['createBufferSource']>;
    },
  };

  return {
    ctx,
    stats: () => ({
      oscCreated,
      oscStopped,
      bufferSourcesCreated,
      bufferSourcesStopped,
      closed,
      resumed,
    }),
    advanceTime: (sec: number) => {
      nowSec += sec;
    },
  };
}

describe('Bot World v0.5.0 — Cozy Sound & Weather + v0.4.0 Audit Refinements', () => {
  test('resolveWeatherKind & WeatherSystem enforce deterministic theme/phase mapping, particle caps, and dt stability', () => {
    // Explicit overrides always win
    for (const explicit of ['clear', 'rain', 'snow', 'starlight'] as const) {
      assert.equal(resolveWeatherKind(explicit, 'day', 'startup_office'), explicit);
      assert.equal(resolveWeatherKind(explicit, 'night', 'cozy_cafe'), explicit);
    }

    // Auto mapping
    assert.equal(resolveWeatherKind('auto', 'day', 'cozy_cafe'), 'clear');
    assert.equal(resolveWeatherKind('auto', 'sunset', 'cozy_cafe'), 'rain');
    assert.equal(resolveWeatherKind('auto', 'night', 'cozy_cafe'), 'rain');
    assert.equal(resolveWeatherKind('auto', 'day', 'cyber_ops'), 'clear');
    assert.equal(resolveWeatherKind('auto', 'night', 'cyber_ops'), 'starlight');
    assert.equal(resolveWeatherKind('auto', 'day', 'startup_office'), 'clear');
    assert.equal(resolveWeatherKind('auto', 'night', 'startup_office'), 'starlight');
    assert.equal(resolveWeatherKind('auto', 'night', 'corporate_office'), 'starlight');

    // Invalid runtime mode falls back safely to auto rules
    assert.equal(
      resolveWeatherKind('tornado' as unknown as WeatherMode, 'night', 'cozy_cafe'),
      'rain'
    );

    const weather = new WeatherSystem();
    const designSize: [number, number] = [1376, 768];

    weather.step(0.016, 'rain', designSize);
    assert.equal(weather.particles.length, MAX_RAIN_PARTICLES);
    for (let i = 0; i < 60; i++) {
      // Huge dt simulates tab sleep; must clamp cleanly without NaN or exceeding ripple cap
      weather.step(45, 'rain', designSize);
    }
    assert.equal(weather.particles.length, MAX_RAIN_PARTICLES);
    assert.ok(weather.ripples.length <= MAX_RAIN_RIPPLES);
    assert.ok(weather.particles.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));

    weather.step(0.016, 'snow', designSize);
    assert.equal(weather.particles.length, MAX_SNOW_PARTICLES);
    assert.equal(weather.ripples.length, 0);
    weather.step(0.05, 'snow', designSize);
    assert.ok(weather.particles.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));

    weather.step(0.016, 'starlight', designSize);
    assert.equal(weather.particles.length, MAX_STARLIGHT_PARTICLES);
    weather.step(0.05, 'starlight', designSize);
    assert.ok(weather.particles.every((p) => p.y <= designSize[1] * 0.65));

    weather.step(0.016, 'clear', designSize);
    assert.equal(weather.particles.length, 0);
  });

  test('classifyEventSoundCue & SoundscapeEngine enforce default-off, user gesture safety, cooldown throttling, and dispose', () => {
    assert.equal(
      classifyEventSoundCue({
        kind: 'ItemNeedsYou',
        itemUid: 'i1',
        number: 1,
        botId: 'b1',
        botName: 'Security',
        title: 'Approve',
        optionsCount: 2,
      }),
      'needs_you'
    );
    assert.equal(
      classifyEventSoundCue({
        kind: 'ItemDone',
        itemUid: 'i2',
        number: 2,
        botId: 'b1',
        botName: 'Ops Lead',
        title: 'Ship',
      }),
      'task_done'
    );
    assert.equal(
      classifyEventSoundCue({
        kind: 'WorkerDone',
        dispatchId: 'w1',
        parentBotId: 'b1',
        parentBotName: 'Ops Lead',
        subject: 'Done',
      }),
      'task_done'
    );
    assert.equal(
      classifyEventSoundCue({ kind: 'BotFailed', botId: 'b1', botName: 'Ops', message: 'Boom' }),
      'error'
    );
    assert.equal(
      classifyEventSoundCue({
        kind: 'Handoff',
        messageId: 'm1',
        from: { kind: 'Bot', botId: 'b1', botName: 'Ops' },
        to: { kind: 'Bot', botId: 'b2', botName: 'Sec' },
        subject: 'Check',
      }),
      'handoff'
    );
    assert.equal(
      classifyEventSoundCue({ kind: 'BotIdle', botId: 'b1', botName: 'Ops' }),
      null
    );

    assert.equal(resolveAmbientProfile('rain', 'day', 'startup_office'), 'rain');
    assert.equal(resolveAmbientProfile('starlight', 'night', 'cyber_ops'), 'night_breeze');
    assert.equal(resolveAmbientProfile('clear', 'day', 'cozy_cafe'), 'cafe_hum');

    // Node no-op safety (no window.AudioContext)
    const nodeEngine = new SoundscapeEngine();
    assert.equal(nodeEngine.getMode(), 'off');
    nodeEngine.setMode('ambient', { fromUserGesture: true });
    assert.equal(nodeEngine.isUnlocked(), false);
    assert.equal(nodeEngine.playCue('needs_you'), false);
    nodeEngine.dispose();

    // Mock AudioContext behavior
    let fakeTime = 10_000;
    let ctxInstantiations = 0;
    const fake = makeFakeAudioContext();
    const engine = new SoundscapeEngine({
      nowMs: () => fakeTime,
      createAudioContext: () => {
        ctxInstantiations += 1;
        return fake.ctx;
      },
    });

    // Default off & non-gesture setMode must NEVER create AudioContext
    assert.equal(engine.getMode(), 'off');
    engine.setMode('chimes', { fromUserGesture: false });
    assert.equal(ctxInstantiations, 0);
    assert.equal(engine.playCue('needs_you'), false);

    // Real user gesture unlocks AudioContext
    engine.setMode('chimes', { fromUserGesture: true });
    assert.equal(ctxInstantiations, 1);
    assert.equal(engine.isUnlocked(), true);
    assert.equal(fake.stats().resumed, true);

    // Suppression during replay scrubbing or Demo/Live transitions
    assert.equal(engine.playCue('needs_you', { suppressed: true }), false);

    // Per-type cooldown prevents burst spam
    assert.equal(engine.playCue('needs_you'), true);
    assert.equal(engine.playCue('needs_you'), false); // within 3500ms cooldown
    assert.equal(engine.playCue('task_done'), true); // different cue type allowed immediately
    fakeTime += 4000;
    assert.equal(engine.playCue('needs_you'), true);

    // Ambient mode starts pink noise loop & switches cleanly on weather update
    engine.setMode('ambient', { fromUserGesture: true });
    const afterAmbient = fake.stats();
    assert.ok(afterAmbient.bufferSourcesCreated >= 1);
    engine.updateAmbientContext('rain', 'night', 'cozy_cafe');
    assert.equal(engine.getAmbientProfile(), 'rain');
    assert.ok(fake.stats().bufferSourcesStopped >= 1);

    // Switching to off stops ambient and closes AudioContext
    engine.setMode('off', { fromUserGesture: true });
    assert.equal(fake.stats().closed, true);
    assert.equal(engine.isUnlocked(), false);
    engine.dispose();
  });

  test('MilestoneTracker, MotionDirector confetti/banner, error beacon flags, and huddle sparkles work deterministically', () => {
    const dayTs = new Date(2026, 10, 22, 14, 0, 0).getTime();
    assert.deepEqual(MILESTONE_THRESHOLDS, [5, 10, 25, 50]);
    assert.equal(
      isCompletionEvent({ kind: 'ItemDone', itemUid: '1', number: 1, botId: 'b1', botName: 'Ops', title: 'X' }),
      true
    );
    assert.equal(
      isCompletionEvent({
        kind: 'AutomationRun',
        automationId: 'a1',
        automationName: 'Probe',
        botId: null,
        botName: null,
        success: false,
        noReply: false,
        error: 'err',
      }),
      false
    );

    const historyEvents: WorldEventRecord[] = Array.from({ length: 4 }, (_, i) => ({
      timestampMs: dayTs - (i + 1) * 60_000,
      summary: 'Done',
      redactedSummary: 'Done',
      event: {
        kind: 'ItemDone',
        itemUid: `it-${i}`,
        number: i + 1,
        botId: 'b1',
        botName: 'Ops Lead',
        title: `Task ${i + 1}`,
      },
    }));
    assert.equal(countDailyCompletions(historyEvents, dayTs), 4);
    assert.equal(detectCrossedMilestone(4, 5, new Set()), 5);
    assert.equal(detectCrossedMilestone(4, 5, new Set([5])), null); // no duplicates

    const tracker = new MilestoneTracker();
    tracker.seedBaseline(historyEvents, dayTs);
    assert.equal(tracker.getCompletionCount(), 4);

    // 5th completion crosses milestone 5 once
    const m1 = tracker.evaluateNewEvents(
      [{ kind: 'WorkerDone', dispatchId: 'w1', parentBotId: 'b1', parentBotName: 'Ops', subject: 'OK' }],
      dayTs + 5_000
    );
    assert.equal(m1, 5);
    // Subsequent completion at 6 does not re-trigger 5
    const m2 = tracker.evaluateNewEvents(
      [{ kind: 'ItemDone', itemUid: 'it-x', number: 9, botId: 'b1', botName: 'Ops', title: 'Next' }],
      dayTs + 10_000
    );
    assert.equal(m2, null);

    // MotionDirector confetti & banner + huddle sparkle + error desk beacon
    const snap = createEmptySnapshot();
    snap.capturedAt = dayTs;
    snap.bots['b1'] = {
      id: 'b1',
      name: 'Ops Lead',
      agent: 'claude',
      paused: false,
      specialty: 'Triage',
      status: { kind: 'Error', message: 'Timeout' },
      currentTaskTitle: 'Check',
      currentTool: null,
      lastActivityAt: dayTs,
      homeChatId: 'c1',
      needsYouCount: 0,
      activeWorkerCount: 0,
    };
    snap.bots['b2'] = {
      id: 'b2',
      name: 'Security',
      agent: 'claude',
      paused: false,
      specialty: 'Auth',
      status: { kind: 'Working', tool: 'read_file' },
      currentTaskTitle: 'Audit',
      currentTool: 'read_file',
      lastActivityAt: dayTs,
      homeChatId: 'c2',
      needsYouCount: 0,
      activeWorkerCount: 0,
    };
    snap.botOrder = ['b1', 'b2'];

    assert.equal(hasErrorDeskBeacon(snap.bots['b1']), true);
    assert.equal(hasErrorDeskBeacon(snap.bots['b2']), false);

    const motion = new MotionDirector();
    const theme = getThemeConfig('startup_office', 'en');
    motion.triggerMilestone(10);
    assert.ok(motion.milestoneBanner !== null);
    assert.equal(motion.milestoneBanner.count, 10);
    assert.ok(motion.particles.length > 0 && motion.particles.length <= MAX_PARTICLES);
    assert.ok(motion.particles.some((p) => p.kind === 'MilestoneConfetti'));

    // Consecutive bot-to-bot exchange triggers golden huddle sparkle ring
    motion.enqueueEvents(
      [
        {
          kind: 'Handoff',
          messageId: 'h1',
          from: { kind: 'Bot', botId: 'b1', botName: 'Ops Lead' },
          to: { kind: 'Bot', botId: 'b2', botName: 'Security' },
          subject: 'Check policy',
        },
        {
          kind: 'Reply',
          messageId: 'h2',
          from: { kind: 'Bot', botId: 'b2', botName: 'Security' },
          to: { kind: 'Bot', botId: 'b1', botName: 'Ops Lead' },
          subject: 'Policy ok',
        },
      ],
      snap,
      theme,
      'en'
    );
    assert.equal(motion.huddles.length, 1);

    // Stepping 2.6+ seconds clears both milestone banner and huddle cleanly
    for (let i = 0; i < 15; i++) {
      motion.step(0.2, snap, theme);
    }
    assert.equal(motion.milestoneBanner, null);
    assert.equal(motion.huddles.length, 0);

    // Demo session showcases Error desk & completion events during its 8-step cycle
    const demo = createDemoOfficeSession(dayTs);
    let sawError = false;
    let sawDone = false;
    for (let i = 0; i < 8; i++) {
      const evs = demo.tick(dayTs + (i + 1) * 2600);
      if (evs.some((e) => e.kind === 'BotFailed')) sawError = true;
      if (evs.some((e) => e.kind === 'ItemDone' || e.kind === 'WorkerDone')) sawDone = true;
    }
    assert.equal(sawError, true);
    assert.equal(sawDone, true);
  });

  test('worker RPCs, settings, and .botworld doc-sync persist weatherMode & soundMode safely', async () => {
    assert.equal(isValidWeatherMode('rain'), true);
    assert.equal(isValidWeatherMode('blizzard'), false);
    assert.equal(isValidSoundMode('chimes'), true);
    assert.equal(isValidSoundMode('loud'), false);

    // .botworld document validation, merge, and encode
    const legacy = validateBotWorldDocument(
      JSON.stringify({
        version: 1,
        themeId: 'cozy_cafe',
        redactMode: false,
        selectedBotId: null,
        botAppearances: {},
      })
    );
    assert.equal(legacy.valid, true);
    assert.equal(legacy.data.weatherMode, 'auto');

    const invalidWeather = validateBotWorldDocument(
      JSON.stringify({
        version: 1,
        themeId: 'cozy_cafe',
        weatherMode: 'hailstorm',
        redactMode: false,
        selectedBotId: null,
        botAppearances: {},
      })
    );
    assert.equal(invalidWeather.valid, true);
    assert.equal(invalidWeather.data.weatherMode, 'auto');

    const merged = mergeBotWorldDocuments(
      DEFAULT_BOTWORLD_DOCUMENT,
      { ...DEFAULT_BOTWORLD_DOCUMENT, weatherMode: 'snow' },
      { ...DEFAULT_BOTWORLD_DOCUMENT, weatherMode: 'invalid' as unknown as 'auto' }
    );
    assert.equal(merged.weatherMode, 'snow');
    const encoded = encodeBotWorldContent({
      ...DEFAULT_BOTWORLD_DOCUMENT,
      weatherMode: 'rain',
    });
    const decoded = decodeBotWorldContent(encoded);
    assert.equal(decoded.weatherMode, 'rain');

    const host = mockHost({
      settings: {
        defaultTheme: 'startup_office',
        atmosphereMode: 'auto',
        weatherMode: 'auto',
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
      assert.equal(initial.weatherMode, 'auto');
      assert.equal(initial.soundMode, 'off');

      const wRes = await worker.request('botWorld.setWeatherMode', { weatherMode: 'rain' });
      assert.equal(wRes.weatherMode, 'rain');

      const sRes = await worker.request('botWorld.setSoundMode', { soundMode: 'ambient' });
      assert.equal(sRes.soundMode, 'ambient');

      const updated = await worker.request('botWorld.getState');
      assert.equal(updated.weatherMode, 'rain');
      assert.equal(updated.soundMode, 'ambient');

      await assert.rejects(
        () => worker.request('botWorld.setWeatherMode', { weatherMode: 'fog' as unknown as 'auto' }),
        (err: unknown) => (err as { code?: string })?.code === 'invalid_params'
      );
      await assert.rejects(
        () => worker.request('botWorld.setSoundMode', { soundMode: 'loud' as unknown as 'off' }),
        (err: unknown) => (err as { code?: string })?.code === 'invalid_params'
      );

      await workerOrca.settings.set('weatherMode', 'starlight');
      await new Promise((r) => setTimeout(r, 25));
      const afterSetting = await worker.request('botWorld.getState');
      assert.equal(afterSetting.weatherMode, 'starlight');
    } finally {
      await worker.deactivate();
    }
  });

  test('v0.4.0 audit fixes: fallback masking without redacted flag, follow-cam filter sync, modal shortcut suppression, and EN/KO i18n', () => {
    // 1. Manually constructed OfficeReport omitting `redacted` flag must STILL be masked when redactMode is true
    const manualReport: OfficeReport = {
      windowHours: 24,
      generatedAtMs: 1_700_050_000_000,
      totalEvents: 5,
      workerRuns: 1,
      collaborations: 2,
      automationsTotal: 1,
      automationsSucceeded: 1,
      automationSuccessRate: 100,
      needsOwnerCount: 0,
      activeBotsCount: 2,
      totalBotsCount: 2,
      topBots: [{ botId: 'b1', botName: 'SecretApolloBot', eventCount: 5, sharePct: 100 }],
      hourlyBuckets: [],
      badges: [
        {
          badgeId: 'mvp',
          emoji: '🏆',
          label: 'Daily MVP',
          subtitle: 'Top',
          winners: ['SecretVaultGuardian'],
        },
      ],
    };
    const mdMasked = formatReportMarkdown(manualReport, { redactMode: true, locale: 'en' });
    assert.equal(mdMasked.includes('SecretApolloBot'), false);
    assert.equal(mdMasked.includes('SecretVaultGuardian'), false);

    // 2. resolveFollowTargetBotId integrates with active status filter
    const snap = createEmptySnapshot();
    snap.bots['b1'] = {
      id: 'b1',
      name: 'Alpha',
      agent: 'claude',
      paused: false,
      specialty: '',
      status: { kind: 'Idle' },
      currentTaskTitle: null,
      currentTool: null,
      lastActivityAt: 1000,
      homeChatId: null,
      needsYouCount: 0,
      activeWorkerCount: 0,
    };
    snap.bots['b2'] = {
      id: 'b2',
      name: 'Beta',
      agent: 'claude',
      paused: false,
      specialty: '',
      status: { kind: 'Working', tool: 'read_file' },
      currentTaskTitle: 'Task',
      currentTool: 'read_file',
      lastActivityAt: 1000,
      homeChatId: null,
      needsYouCount: 0,
      activeWorkerCount: 0,
    };
    snap.botOrder = ['b1', 'b2'];

    // Selected b1 is filtered out -> picks first visible matching bot b2
    assert.equal(resolveFollowTargetBotId(snap, 'b1', new Set(['b2'])), 'b2');
    // Filter matches 0 bots -> returns null so UI shows clear feedback
    assert.equal(resolveFollowTargetBotId(snap, 'b1', new Set()), null);
    // Selected b2 is visible -> keeps b2
    assert.equal(resolveFollowTargetBotId(snap, 'b2', new Set(['b1', 'b2'])), 'b2');

    // 3. Shortcuts M, W, and / suppression while modal is open
    assert.equal(mapKeyToShortcutAction('m'), 'toggleSound');
    assert.equal(mapKeyToShortcutAction('M'), 'toggleSound');
    assert.equal(mapKeyToShortcutAction('w'), 'cycleWeather');
    assert.equal(mapKeyToShortcutAction('W'), 'cycleWeather');
    assert.equal(mapKeyToShortcutAction('/'), 'focusSearch');

    assert.equal(mapKeyToShortcutAction('/', { modalOpen: true }), null);
    assert.equal(mapKeyToShortcutAction('m', { modalOpen: true }), null);
    assert.equal(mapKeyToShortcutAction('w', { modalOpen: true }), null);
    assert.equal(mapKeyToShortcutAction('Escape', { modalOpen: true }), 'closeOrClearSelection');
    assert.equal(shouldIgnoreShortcutEvent({ key: '/', target: null }, { modalOpen: true }), true);
    assert.equal(shouldIgnoreShortcutEvent({ key: 'm', target: null }, { modalOpen: true }), true);
    assert.equal(shouldIgnoreShortcutEvent({ key: 'w', target: null }, { modalOpen: true }), true);
    assert.equal(shouldIgnoreShortcutEvent({ key: 'Escape', target: null }, { modalOpen: true }), false);

    assert.equal(nextWeatherMode('auto'), 'clear');
    assert.equal(nextWeatherMode('starlight'), 'auto');
    assert.equal(nextSoundMode('off'), 'chimes');
    assert.equal(nextSoundMode('ambient'), 'off');

    // 4. EN & KO strings + renderOfficeReportModal fallback mask + renderShortcutsModal M/W entries
    const en = tStrings('en');
    const ko = tStrings('ko');
    assert.equal(en.soundModes.off, 'Off');
    assert.equal(ko.soundModes.off, '음소거');
    assert.equal(en.weatherModes.starlight, 'Stars');
    assert.equal(ko.weatherModes.starlight, '별빛');
    assert.ok(en.milestoneBannerText(10).includes('10'));
    assert.ok(ko.milestoneBannerText(10).includes('10'));

    const g = globalThis as Record<string, unknown>;
    const prevDoc = g.document;
    const prevNode = g.Node;
    const prevHtmlInput = g.HTMLInputElement;
    const prevHtmlImg = g.HTMLImageElement;
    class FakeNode {
      childNodes: FakeNode[] = [];
      textContent = '';
      get firstChild(): FakeNode | null {
        return this.childNodes[0] ?? null;
      }
      appendChild(child: FakeNode): FakeNode {
        this.childNodes.push(child);
        return child;
      }
      removeChild(child: FakeNode): FakeNode {
        const idx = this.childNodes.indexOf(child);
        if (idx >= 0) this.childNodes.splice(idx, 1);
        return child;
      }
      collectText(): string {
        if (this.childNodes.length === 0) return this.textContent;
        return this.childNodes.map((c) => c.collectText()).join('');
      }
    }
    class FakeElement extends FakeNode {
      className = '';
      title = '';
      classList = {
        tokens: new Set<string>(),
        toggle: (cls: string, force?: boolean) => {
          if (force === undefined) {
            if (this.classList.tokens.has(cls)) this.classList.tokens.delete(cls);
            else this.classList.tokens.add(cls);
          } else if (force) {
            this.classList.tokens.add(cls);
          } else {
            this.classList.tokens.delete(cls);
          }
        },
        contains: (cls: string) => this.classList.tokens.has(cls),
      };
      setAttribute(): void {}
      addEventListener(): void {}
    }
    g.Node = FakeNode;
    g.HTMLInputElement = FakeElement;
    g.HTMLImageElement = FakeElement;
    g.document = {
      createElement: (tag: string) => new FakeElement(tag),
      createTextNode: (text: string) => {
        const n = new FakeNode();
        n.textContent = text;
        return n;
      },
    };
    try {
      const reportBackdrop = new FakeElement('div');
      renderOfficeReportModal(reportBackdrop as unknown as HTMLElement, {
        open: true,
        report: manualReport,
        redactMode: true,
        locale: 'en',
        copied: false,
        onCopyMarkdown: () => {},
        onClose: () => {},
      });
      const modalText = reportBackdrop.collectText();
      assert.equal(modalText.includes('SecretApolloBot'), false);
      assert.equal(modalText.includes('SecretVaultGuardian'), false);

      const shortcutsBackdrop = new FakeElement('div');
      renderShortcutsModal(shortcutsBackdrop as unknown as HTMLElement, {
        open: true,
        locale: 'ko',
        isEditor: true,
        onClose: () => {},
      });
      const shortcutsText = shortcutsBackdrop.collectText();
      assert.ok(shortcutsText.includes('M'));
      assert.ok(shortcutsText.includes('W'));
      assert.ok(shortcutsText.includes('사운드'));
      assert.ok(shortcutsText.includes('날씨'));
    } finally {
      g.document = prevDoc;
      g.Node = prevNode;
      g.HTMLInputElement = prevHtmlInput;
      g.HTMLImageElement = prevHtmlImg;
    }

    // Verify zero modal-open bypass in editor/main.ts & panel/main.ts
    for (const relPath of ['editor/main.ts', 'panel/main.ts']) {
      const src = fs.readFileSync(path.resolve(relPath), 'utf8');
      assert.ok(src.includes('const modalOpen = state.shortcutsOpen || state.reportOpen || state.zonesOpen;'));
      assert.ok(src.includes('shouldIgnoreShortcutEvent(ev, { modalOpen })'));
    }
  });
});
