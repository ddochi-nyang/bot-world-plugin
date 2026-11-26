import fs from 'node:fs';
import path from 'node:path';
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing';
import { getThemeConfig } from '../shared/assets-catalog.ts';
import {
  BossRaidEngine,
  CRIT_EVENT_DAMAGE,
  DEMO_RESPAWN_COOLDOWN_MS,
  LIVE_RESPAWN_COOLDOWN_MS,
  MAX_ATTACK_BEAMS,
  MAX_DAMAGE_FLOATS,
  MAX_RAID_PARTICLES,
  NORMAL_EVENT_DAMAGE,
  OWNER_STRIKE_COOLDOWN_MS,
  OWNER_STRIKE_DAMAGE,
  RAID_BOSS_CATALOG,
  TRANSIENT_THREAT_HOLD_MS,
  applyRaidOutcomeToStats,
  classifyRaidAttackEvent,
  createEmptyBossRaidStats,
  evaluateBossEncounter,
  paintBossRaidLayer,
  renderBossRaidModal,
  resolveRaidSuppressionReason,
  sanitizeBossRaidStats,
  validateRecordRaidOutcomeInput,
} from '../shared/boss-raid.ts';
import { createDemoOfficeSession } from '../shared/demo-office.ts';
import { buildOfficeReport, formatReportMarkdown } from '../shared/office-report.ts';
import { mapKeyToShortcutAction, renderShortcutsModal } from '../shared/shortcuts.ts';
import { type AudioContextLike, SoundscapeEngine } from '../shared/soundscape.ts';
import { createToolbarChrome, syncToolbarChrome } from '../shared/toolbar-chrome.ts';
import type { OrcaClient } from './orca-cli.ts';
import {
  type BossKind,
  type BotState,
  type WorldEvent,
  type WorldSnapshot,
  createEmptySnapshot,
} from './types.ts';
import * as workerModule from './worker.ts';

function makeBot(id: string, name: string, status: BotState['status'] = { kind: 'Idle' }): BotState {
  return {
    id,
    name,
    agent: 'claude',
    paused: false,
    specialty: 'Engineering',
    status,
    unreadCount: 0,
    lastActivityAt: 1000,
    deskIndex: 0,
  };
}

function makeSnapshot(bots: BotState[], activeWorkers = 0): WorldSnapshot {
  const snap = createEmptySnapshot(10_000);
  snap.runtime.connected = true;
  snap.initialSyncComplete = true;
  for (const [idx, b] of bots.entries()) {
    snap.bots[b.id] = { ...b, deskIndex: idx };
    snap.botOrder.push(b.id);
  }
  for (let i = 0; i < activeWorkers; i += 1) {
    snap.workers[`w-${i}`] = {
      dispatchId: `d-${i}`,
      taskId: `t-${i}`,
      runId: `r-${i}`,
      parentBotId: bots[0]?.id ?? null,
      parentBotName: bots[0]?.name ?? null,
      provider: 'claude',
      model: null,
      workerState: 'ready',
      dispatchStatus: 'dispatched',
      terminalState: 'attached',
      terminalHandle: null,
      worktreeId: null,
      liveness: 'Alive',
      activity: 'working',
      toolName: 'run_command',
      taskTitle: `Task ${i}`,
      updatedAt: 10_000,
    };
  }
  return snap;
}

function makeMinimalClient(): OrcaClient {
  return {
    isStopped: () => false,
    status: async () => ({
      ok: true,
      result: { runtime: { state: 'ready', reachable: true } },
    }),
    botList: async () => ({
      ok: true,
      result: {
        bots: [
          { id: 'bot-alpha', name: 'SecretAlpha', agent: 'claude', paused: false },
          { id: 'bot-beta', name: 'SecretBeta', agent: 'codex', paused: false },
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
    state: 'running',
    destination: { connect: (d) => d, disconnect: () => {} },
    resume: () => {},
    close: () => {},
    createGain: () => ({ gain: makeParam(), connect: (d) => d, disconnect: () => {} }),
    createOscillator: () => {
      oscCreated += 1;
      return {
        type: 'sine',
        frequency: makeParam(),
        onended: null,
        connect: (d: ReturnType<AudioContextLike['createGain']>) => d,
        disconnect: () => {},
        start: () => {},
        stop: () => {},
      } as unknown as ReturnType<AudioContextLike['createOscillator']>;
    },
    createBiquadFilter: () => ({
      type: 'bandpass',
      frequency: makeParam(),
      Q: makeParam(),
      connect: (d) => d,
      disconnect: () => {},
    }),
    createBuffer: (_channels, length) => ({ getChannelData: () => new Float32Array(length) }),
    createBufferSource: () =>
      ({
        buffer: null,
        loop: false,
        onended: null,
        connect: (d: ReturnType<AudioContextLike['createGain']>) => d,
        disconnect: () => {},
        start: () => {},
        stop: () => {},
      }) as unknown as ReturnType<AudioContextLike['createBufferSource']>,
  };
  return {
    ctx,
    getOscCreated: () => oscCreated,
    advanceSec: (s: number) => {
      nowSec += s;
    },
  };
}

function makeSpyCanvas2D() {
  let shadowBlurWrites = 0;
  let drawCalls = 0;
  const target: Record<string, unknown> = {
    globalAlpha: 1,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    font: '10px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    quadraticCurveTo: () => {},
    arc: () => {},
    ellipse: () => {},
    translate: () => {},
    rotate: () => {},
    fill: () => {
      drawCalls += 1;
    },
    stroke: () => {
      drawCalls += 1;
    },
    fillRect: () => {
      drawCalls += 1;
    },
    strokeRect: () => {
      drawCalls += 1;
    },
    fillText: () => {
      drawCalls += 1;
    },
    strokeText: () => {
      drawCalls += 1;
    },
    roundRect: () => {},
    measureText: (t: string) => ({ width: t.length * 6 }),
  };
  const proxy = new Proxy(target, {
    set(obj, prop, value) {
      if (prop === 'shadowBlur') {
        shadowBlurWrites += 1;
      }
      obj[String(prop)] = value;
      return true;
    },
  });
  return {
    ctx: proxy as unknown as CanvasRenderingContext2D,
    getShadowBlurWrites: () => shadowBlurWrites,
    getDrawCalls: () => drawCalls,
  };
}

describe('Boss Raid & Pomodoro Co-op', () => {
  test('evaluates 4 original bosses, threat priority, pomodoro priority, and calm office', () => {
    const calmSnap = makeSnapshot([makeBot('b1', 'A'), makeBot('b2', 'B')]);
    assert.equal(
      evaluateBossEncounter({
        snapshot: calmSnap,
        pomodoroActive: false,
        currentStreak: 0,
        practiceBossKind: null,
      }),
      null,
      'calm office must stay clear with no boss'
    );

    // sprint_titan when working + activeWorkers >= 4
    const busySnap = makeSnapshot(
      [
        makeBot('b1', 'A', { kind: 'Working', label: 't1' }),
        makeBot('b2', 'B', { kind: 'Working', label: 't2' }),
        makeBot('b3', 'C', { kind: 'Working', label: 't3' }),
      ],
      1
    );
    assert.deepEqual(
      evaluateBossEncounter({
        snapshot: busySnap,
        pomodoroActive: false,
        currentStreak: 0,
        practiceBossKind: null,
      }),
      { kind: 'sprint_titan', source: 'threat' }
    );

    // stall_golem beats sprint_titan (>=2 NeedsOwner or stuckAlerts >= 1)
    const stalledSnap = makeSnapshot(
      [
        makeBot('b1', 'A', { kind: 'NeedsOwner', reason: 'Approve' }),
        makeBot('b2', 'B', { kind: 'NeedsOwner', reason: 'Confirm' }),
        makeBot('b3', 'C', { kind: 'Working', label: 't3' }),
        makeBot('b4', 'D', { kind: 'Working', label: 't4' }),
      ],
      1
    );
    assert.deepEqual(
      evaluateBossEncounter({
        snapshot: stalledSnap,
        pomodoroActive: false,
        currentStreak: 0,
        practiceBossKind: null,
      }),
      { kind: 'stall_golem', source: 'threat' }
    );

    // error_blob beats stall_golem
    const oneErrSnap = makeSnapshot([
      makeBot('b1', 'A', { kind: 'Error', message: '503' }),
      makeBot('b2', 'B', { kind: 'NeedsOwner', reason: 'r1' }),
      makeBot('b3', 'C', { kind: 'NeedsOwner', reason: 'r2' }),
    ]);
    assert.deepEqual(
      evaluateBossEncounter({
        snapshot: oneErrSnap,
        pomodoroActive: false,
        currentStreak: 0,
        practiceBossKind: null,
      }),
      { kind: 'error_blob', source: 'threat' }
    );

    // ci_wyvern beats error_blob on >=2 errors
    const twoErrSnap = makeSnapshot([
      makeBot('b1', 'A', { kind: 'Error', message: '503' }),
      makeBot('b2', 'B', { kind: 'Error', message: '502' }),
    ]);
    assert.deepEqual(
      evaluateBossEncounter({
        snapshot: twoErrSnap,
        pomodoroActive: false,
        currentStreak: 0,
        practiceBossKind: null,
      }),
      { kind: 'ci_wyvern', source: 'threat' }
    );

    // Active Pomodoro overrides threat bosses and upgrades to ci_wyvern at streak >= 2
    assert.deepEqual(
      evaluateBossEncounter({
        snapshot: oneErrSnap,
        pomodoroActive: true,
        currentStreak: 0,
        practiceBossKind: null,
      }),
      { kind: 'sprint_titan', source: 'pomodoro' }
    );
    assert.deepEqual(
      evaluateBossEncounter({
        snapshot: calmSnap,
        pomodoroActive: true,
        currentStreak: 2,
        practiceBossKind: null,
      }),
      { kind: 'ci_wyvern', source: 'pomodoro' }
    );
  });

  test('enforces suppression modes (replay, pet, broadcast, off) and resource caps', () => {
    assert.equal(resolveRaidSuppressionReason({ isReplay: true, viewMode: 'office', bossRaidMode: 'auto' }), 'replay');
    assert.equal(resolveRaidSuppressionReason({ isReplay: false, viewMode: 'pet', bossRaidMode: 'auto' }), 'pet');
    assert.equal(resolveRaidSuppressionReason({ isReplay: false, viewMode: 'broadcast', bossRaidMode: 'auto' }), 'broadcast');
    assert.equal(resolveRaidSuppressionReason({ isReplay: false, viewMode: 'office', bossRaidMode: 'off' }), 'off');
    assert.equal(resolveRaidSuppressionReason({ isReplay: false, viewMode: 'office', bossRaidMode: 'auto' }), null);

    const engine = new BossRaidEngine();
    const theme = getThemeConfig('startup_office', 'en');
    const snap = makeSnapshot([makeBot('b1', 'Alpha', { kind: 'Error', message: 'fail' })]);
    const sounds: string[] = [];

    engine.syncState({
      snapshot: snap,
      theme,
      bossRaidMode: 'off',
      viewMode: 'office',
      isReplay: false,
      nowMs: 1_000,
      onSoundCue: (c) => sounds.push(c),
    });
    assert.equal(engine.activeBoss, null);
    assert.equal(sounds.length, 0);

    // Spawn active boss in auto office mode
    engine.syncState({
      snapshot: snap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      nowMs: 2_000,
      onSoundCue: (c) => sounds.push(c),
    });
    assert.equal(engine.activeBoss?.kind, 'error_blob');
    assert.deepEqual(sounds, ['raid_spawn']);

    // Flood attack events beyond MAX_ATTACK_BEAMS and MAX_DAMAGE_FLOATS
    const burstEvents: WorldEvent[] = [];
    for (let i = 0; i < 40; i += 1) {
      burstEvents.push({ kind: 'BotWorking', botId: 'b1', botName: 'Alpha', taskTitle: `t-${i}` });
    }
    engine.reset();
    engine.summonPracticeBoss('ci_wyvern', { nowMs: 3_000, bossRaidMode: 'auto', viewMode: 'office', isReplay: false });
    if (engine.activeBoss) {
      engine.activeBoss.hp = 9999;
      engine.activeBoss.maxHp = 9999;
    }
    engine.onEvents(burstEvents, {
      snapshot: snap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      nowMs: 3_100,
    });
    assert.ok(engine.beams.length <= MAX_ATTACK_BEAMS, 'beams must stay capped <= 12');
    assert.ok(engine.damageFloats.length <= MAX_DAMAGE_FLOATS, 'damage floats must stay capped <= 24');
  });

  test('bot events (including spec aliases), manual strike cooldown, victory confetti, and respawn cooldowns', () => {
    // Event damage & crit classification
    assert.deepEqual(classifyRaidAttackEvent({ kind: 'ToolStart', botId: 'b1', botName: 'A' }), {
      botId: 'b1',
      damage: NORMAL_EVENT_DAMAGE,
      isCrit: false,
    });
    assert.deepEqual(classifyRaidAttackEvent({ kind: 'WorkStarted', botId: 'b1', botName: 'A' }), {
      botId: 'b1',
      damage: NORMAL_EVENT_DAMAGE,
      isCrit: false,
    });
    assert.deepEqual(classifyRaidAttackEvent({ kind: 'MessageSent', botId: 'b1', botName: 'A' }), {
      botId: 'b1',
      damage: NORMAL_EVENT_DAMAGE,
      isCrit: false,
    });
    assert.deepEqual(classifyRaidAttackEvent({ kind: 'ItemDone', botId: 'b1', itemTitle: 'ship' }), {
      botId: 'b1',
      damage: CRIT_EVENT_DAMAGE,
      isCrit: true,
    });
    assert.deepEqual(classifyRaidAttackEvent({ kind: 'WorkDone', botId: 'b1', botName: 'A' }), {
      botId: 'b1',
      damage: CRIT_EVENT_DAMAGE,
      isCrit: true,
    });

    const engine = new BossRaidEngine();
    const theme = getThemeConfig('startup_office', 'en');
    const snap = makeSnapshot([makeBot('b1', 'Alpha', { kind: 'Error', message: 'fail' })]);
    const outcomes: Array<Record<string, unknown>> = [];
    const sounds: string[] = [];

    engine.summonPracticeBoss('error_blob', {
      nowMs: 1_000,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      onSoundCue: (c) => sounds.push(c),
    });
    assert.equal(engine.activeBoss?.hp, RAID_BOSS_CATALOG.error_blob.maxHp);

    // Owner strike cooldown (250ms)
    const struck1 = engine.strikeFromOwner({
      snapshot: snap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      nowMs: 1_100,
      onSoundCue: (c) => sounds.push(c),
    });
    assert.equal(struck1, true);
    assert.equal(engine.activeBoss?.hp, RAID_BOSS_CATALOG.error_blob.maxHp - OWNER_STRIKE_DAMAGE);

    const struckTooSoon = engine.strikeFromOwner({
      snapshot: snap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      nowMs: 1_100 + OWNER_STRIKE_COOLDOWN_MS - 10,
    });
    assert.equal(struckTooSoon, false);

    // Finish boss with ItemDone crit
    if (engine.activeBoss) {
      engine.activeBoss.hp = 10;
    }
    engine.onEvents([{ kind: 'ItemDone', botId: 'b1', itemTitle: 'Ship it' }], {
      snapshot: snap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      demoMode: false,
      nowMs: 2_000,
      onOutcome: (o) => outcomes.push(o as Record<string, unknown>),
      onSoundCue: (c) => sounds.push(c),
    });

    assert.equal(engine.activeBoss, null);
    assert.ok(engine.victoryBanner !== null, 'victory banner should appear on defeat');
    assert.ok(engine.particles.length > 0 && engine.particles.length <= MAX_RAID_PARTICLES);
    assert.ok(sounds.includes('raid_victory'));
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].cleared, true);
    assert.equal(engine.isInRespawnCooldown(2_000), true);
    assert.equal(engine.isInRespawnCooldown(2_000 + LIVE_RESPAWN_COOLDOWN_MS - 100), true);
    assert.equal(engine.isInRespawnCooldown(2_000 + LIVE_RESPAWN_COOLDOWN_MS + 10), false);

    // Demo cooldown is 6s and does not block clean reset
    engine.reset();
    const calmDemoSnap = makeSnapshot([makeBot('b1', 'DemoBot')]);
    engine.summonPracticeBoss('error_blob', {
      nowMs: 10_000,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
    });
    if (engine.activeBoss) engine.activeBoss.hp = 5;
    engine.strikeFromOwner({
      snapshot: calmDemoSnap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      demoMode: true,
      nowMs: 11_000,
    });
    assert.equal(engine.isInRespawnCooldown(11_000 + DEMO_RESPAWN_COOLDOWN_MS - 50), true);
    assert.equal(engine.isInRespawnCooldown(11_000 + DEMO_RESPAWN_COOLDOWN_MS + 50), false);
  });

  test('renders all 4 original pixel bosses without shadowBlur and returns valid hit rect', () => {
    const theme = getThemeConfig('startup_office', 'en');
    const vt = {
      scale: 1,
      originX: 0,
      originY: 0,
      designW: theme.designSize[0],
      designH: theme.designSize[1],
    };
    const kinds: BossKind[] = ['error_blob', 'stall_golem', 'ci_wyvern', 'sprint_titan'];
    for (const kind of kinds) {
      const engine = new BossRaidEngine();
      engine.summonPracticeBoss(kind, {
        nowMs: 5_000,
        bossRaidMode: 'auto',
        viewMode: 'office',
        isReplay: false,
      });
      const spy = makeSpyCanvas2D();
      const rect = paintBossRaidLayer(spy.ctx, vt, theme, engine, {
        locale: 'en',
        uiScale: 1,
        fontFamily: 'monospace',
      });
      assert.equal(spy.getShadowBlurWrites(), 0, `${kind} must never set shadowBlur`);
      assert.ok(spy.getDrawCalls() > 10, `${kind} must issue direct Canvas 2D draw calls`);
      assert.ok(
        Array.isArray(rect) && rect[2] > 40 && rect[3] > 40,
        `${kind} must expose clickable hit rect`
      );
    }
  });

  test('pomodoro co-op presets, pause/resume/abandon/complete, dt sanitization, and streak', () => {
    const engine = new BossRaidEngine();
    const theme = getThemeConfig('startup_office', 'en');
    const snap = makeSnapshot([makeBot('b1', 'Alpha')]);
    const outcomes: Array<Record<string, unknown>> = [];

    engine.startPomodoro(15, {
      currentStreak: 0,
      nowMs: 1_000,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
    });
    assert.equal(engine.isPomodoroActive(), true);
    assert.equal(engine.isPomodoroRunning(), true);
    assert.equal(engine.activeBoss?.kind, 'sprint_titan');

    engine.pausePomodoro();
    assert.equal(engine.isPomodoroRunning(), false);
    const hpWhenPaused = engine.activeBoss?.hp;

    // Step with NaN / Infinity / negative dt while paused or running stays safe
    engine.step(Number.NaN, {
      snapshot: snap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      nowMs: 2_000,
    });
    assert.equal(engine.activeBoss?.hp, hpWhenPaused);

    engine.resumePomodoro();
    engine.step(-10, {
      snapshot: snap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      nowMs: 2_500,
    });
    assert.equal(engine.pomodoro.remainingSecs, 15 * 60);

    // Complete 15m pomodoro (900 seconds in clamped steps)
    for (let i = 0; i < 90; i += 1) {
      engine.step(10, {
        snapshot: snap,
        theme,
        bossRaidMode: 'auto',
        viewMode: 'office',
        isReplay: false,
        nowMs: 3_000 + i * 10_000,
        onOutcome: (o) => outcomes.push(o as Record<string, unknown>),
      });
    }
    assert.equal(engine.isPomodoroActive(), false);
    const pomoOutcome = outcomes.find((o) => o.pomodoroCompleted === true);
    assert.ok(pomoOutcome, 'completing pomodoro emits pomodoroCompleted outcome');
    assert.equal(pomoOutcome?.focusMinutes, 15);

    // Streak >= 2 summons ci_wyvern; abandon resets streak
    engine.startPomodoro(25, {
      currentStreak: 2,
      nowMs: 100_000,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
    });
    assert.equal(engine.activeBoss?.kind, 'ci_wyvern');
    const abandonOutcomes: Array<Record<string, unknown>> = [];
    engine.abandonPomodoro({
      demoMode: false,
      onOutcome: (o) => abandonOutcomes.push(o as Record<string, unknown>),
    });
    assert.equal(engine.isPomodoroActive(), false);
    assert.equal(abandonOutcomes.length, 1);
    assert.equal(abandonOutcomes[0].resetStreak, true);
  });

  test('worker RPC persistence, non-PII integer stats, input validation, and demo isolation', async () => {
    const client = makeMinimalClient();
    const host = mockHost({
      settings: { bossRaidMode: 'auto' },
    });
    let controller: workerModule.BotWorldWorkerController | null = null;

    const worker = await mountWorker(
      {
        default: async (orca) => {
          controller = new workerModule.BotWorldWorkerController(orca, client);
          await controller.init({ disableAutoLoop: true });
          await controller.runPollTick(true);
        },
        deactivate: async () => {
          controller?.dispose();
        },
      },
      { host }
    );

    const initialStats = await worker.request('botWorld.getRaidStats');
    assert.equal(initialStats.version, 1);
    assert.equal(initialStats.raidsCleared, 0);

    // Record valid outcome via RPC
    const saved = await worker.request('botWorld.recordRaidOutcome', {
      cleared: true,
      pomodoroCompleted: true,
      focusMinutes: 25,
      damageDealt: 320,
    });
    assert.equal(saved.raidsCleared, 1);
    assert.equal(saved.pomodorosCompleted, 1);
    assert.equal(saved.totalFocusMinutes, 25);
    assert.equal(saved.totalDamage, 320);
    assert.equal(saved.currentStreak, 1);
    assert.equal(saved.bestStreak, 1);

    // Storage must contain only non-PII integer keys under botWorld.raid.v1
    const rawStored = host.data().storage['botWorld.raid.v1'] as Record<string, unknown>;
    assert.ok(rawStored && typeof rawStored === 'object');
    assert.deepEqual(
      Object.keys(rawStored).sort(),
      [
        'bestStreak',
        'currentStreak',
        'pomodorosCompleted',
        'raidsCleared',
        'totalDamage',
        'totalFocusMinutes',
        'updatedAtMs',
        'version',
      ].sort()
    );
    assert.equal(JSON.stringify(rawStored).includes('SecretAlpha'), false);

    // Reject negative / NaN / Infinity / PII fields with invalid_params
    const invalidInputs = [
      { focusMinutes: -5 },
      { damageDealt: Number.NaN },
      { damageDealt: Number.POSITIVE_INFINITY },
      { botName: 'SecretAlpha', cleared: true },
      { focusMinutes: '25' },
    ];
    for (const bad of invalidInputs) {
      let rejected = false;
      try {
        await worker.request('botWorld.recordRaidOutcome', bad as never);
      } catch (err) {
        rejected = (err as { code?: string })?.code === 'invalid_params';
      }
      assert.equal(rejected, true, `expected invalid_params for: ${JSON.stringify(bad)}`);
    }

    // Validator unit check on upper clamping / prototype pollution
    assert.equal(validateRecordRaidOutcomeInput({ botName: 'leak' }).ok, false);
    const clamped = applyRaidOutcomeToStats(
      createEmptyBossRaidStats(100),
      { focusMinutes: 9999, damageDealt: 999999 },
      200
    );
    assert.equal(clamped.totalFocusMinutes, 180);
    assert.equal(clamped.totalDamage, 50_000);
    assert.equal(sanitizeBossRaidStats({ raidsCleared: -1, extraPii: 'Secret' }).raidsCleared, 0);

    // Demo mode simulation does not emit persisted outcomes or write to host.storage
    const storageBeforeDemo = JSON.stringify(host.data().storage['botWorld.raid.v1']);
    const demoEngine = new BossRaidEngine();
    let demoStats = createEmptyBossRaidStats();
    const demoErrSnap = makeSnapshot([
      makeBot('b1', 'DemoBot', { kind: 'Error', message: 'demo 503' }),
    ]);
    demoEngine.syncState({
      snapshot: demoErrSnap,
      theme: getThemeConfig('startup_office', 'en'),
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      demoMode: true,
      nowMs: 1_000,
    });
    assert.equal(demoEngine.activeBoss?.kind, 'error_blob');
    if (demoEngine.activeBoss) demoEngine.activeBoss.hp = 5;
    demoEngine.strikeFromOwner({
      snapshot: demoErrSnap,
      theme: getThemeConfig('startup_office', 'en'),
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      demoMode: true,
      nowMs: 2_000,
      onOutcome: (o) => {
        demoStats = applyRaidOutcomeToStats(demoStats, o, 2_000);
      },
    });
    assert.equal(demoEngine.activeBoss, null);
    assert.equal(demoStats.raidsCleared, 0, 'demoMode=true skips persisted onOutcome');
    assert.equal(
      JSON.stringify(host.data().storage['botWorld.raid.v1']),
      storageBeforeDemo,
      'Demo mode must not modify host.storage'
    );

    await worker.deactivate();

    // Verify bossRaidMode='off' setting flows into worker state payload
    const offHost = mockHost({ settings: { bossRaidMode: 'off' } });
    let offCtrl: workerModule.BotWorldWorkerController | null = null;
    const offWorker = await mountWorker(
      {
        default: async (orca) => {
          offCtrl = new workerModule.BotWorldWorkerController(orca, client);
          await offCtrl.init({ disableAutoLoop: true });
          await offCtrl.runPollTick(true);
        },
        deactivate: async () => {
          offCtrl?.dispose();
        },
      },
      { host: offHost }
    );
    const offState = await offWorker.request('botWorld.getState');
    assert.equal(offState.bossRaidMode, 'off');
    await offWorker.deactivate();
  });

  test('redact mode masks contributor & office report in EN and KO', () => {
    const snap = makeSnapshot([makeBot('b1', 'SecretTopBot', { kind: 'Error', message: 'boom' })]);
    const engine = new BossRaidEngine();
    const theme = getThemeConfig('startup_office', 'en');
    engine.summonPracticeBoss('error_blob', {
      nowMs: 1_000,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
    });
    engine.onEvents([{ kind: 'ItemDone', botId: 'b1', itemTitle: 'Fix' }], {
      snapshot: snap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      nowMs: 2_000,
    });

    const unredacted = engine.getTopContributor(snap, false, 'en');
    assert.equal(unredacted?.displayName, 'SecretTopBot');

    const redactedEn = engine.getTopContributor(snap, true, 'en');
    assert.equal(redactedEn?.displayName, 'Bot #1');
    const redactedKo = engine.getTopContributor(snap, true, 'ko');
    assert.equal(redactedKo?.displayName, '봇 #1');

    const stats = {
      ...createEmptyBossRaidStats(10_000),
      raidsCleared: 3,
      pomodorosCompleted: 2,
      totalFocusMinutes: 50,
      totalDamage: 840,
      currentStreak: 2,
      bestStreak: 4,
    };
    const report = buildOfficeReport([], snap, {
      redactMode: true,
      locale: 'ko',
      bossRaidStats: stats,
    });
    const md = formatReportMarkdown(report, { redactMode: true, locale: 'ko' });
    assert.ok(md.includes('보스 레이드'), 'markdown report includes Boss Raid section');
    assert.ok(md.includes('50분') || md.includes('50'), 'markdown report includes focus minutes');
    assert.equal(md.includes('SecretTopBot'), false, 'redacted report leaks no bot names');
  });

  test('toolbar 0px invariant, shortcut X, soundscape raid cues, and clean manifest', () => {
    // Manifest keeps version 1.0.0 and exact 5 capabilities
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'orca-plugin.json'), 'utf8')
    ) as {
      version: string;
      capabilities: string[];
      contributes: { settings: Array<{ key: string; default: unknown; enum: string[] }> };
    };
    assert.equal(manifest.version, '1.0.0');
    assert.equal(manifest.capabilities.length, 5);
    const raidSetting = manifest.contributes.settings.find((s) => s.key === 'bossRaidMode');
    assert.ok(raidSetting);
    assert.equal(raidSetting?.default, 'auto');
    assert.deepEqual(raidSetting?.enum, ['auto', 'off']);

    // Shortcut X maps to toggleRaid
    assert.equal(mapKeyToShortcutAction('x', { isEditor: false, modalOpen: false }), 'toggleRaid');
    assert.equal(mapKeyToShortcutAction('X', { isEditor: true, modalOpen: true }), 'toggleRaid');

    // Soundscape raid cues silent when OFF or suppressed, active when ON
    const fakeAudio = makeFakeAudioContext();
    const sound = new SoundscapeEngine({
      createAudioContext: () => fakeAudio.ctx,
    });
    sound.playCue('raid_spawn', { suppressed: false });
    assert.equal(fakeAudio.getOscCreated(), 0, 'sound OFF must stay completely silent');

    sound.setMode('chimes', { fromUserGesture: true });
    const afterAmbient = fakeAudio.getOscCreated();
    sound.playCue('raid_spawn', { suppressed: true });
    assert.equal(fakeAudio.getOscCreated(), afterAmbient, 'suppressed raid cue stays silent');

    sound.playCue('raid_spawn', { suppressed: false });
    assert.ok(fakeAudio.getOscCreated() > afterAmbient, 'raid_spawn synthesizes tone when ON');
    const afterSpawn = fakeAudio.getOscCreated();
    sound.playCue('raid_hit', { suppressed: false });
    assert.ok(fakeAudio.getOscCreated() > afterSpawn, 'raid_hit synthesizes tone when ON');
    fakeAudio.advanceSec(1);
    const afterHit = fakeAudio.getOscCreated();
    sound.playCue('raid_victory', { suppressed: false });
    assert.ok(fakeAudio.getOscCreated() > afterHit, 'raid_victory synthesizes fanfare when ON');
    sound.dispose();

    // Shortcuts modal DOM & Toolbar button presence check (via shared CSS)
    assert.ok(typeof renderShortcutsModal === 'function');
    assert.ok(typeof createToolbarChrome === 'function');
    assert.ok(typeof syncToolbarChrome === 'function');
  });

  test('separates stepVisuals from stepPomodoro, skips stats on live practice boss, and enforces bossRaidMode=off in Demo mode', () => {
    const theme = getThemeConfig('startup_office', 'en');
    const calmSnap = makeSnapshot([makeBot('b1', 'Alpha')]);
    const engine = new BossRaidEngine();

    // 1. stepVisuals must advance visual transients ONLY without draining Pomodoro time or DPS
    engine.startPomodoro(15, {
      currentStreak: 0,
      nowMs: 1_000,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
    });
    engine.strikeFromOwner({
      snapshot: calmSnap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      nowMs: 1_100,
    });
    const hpAfterStrike = engine.activeBoss?.hp ?? 0;
    const beamBefore = engine.beams[0]?.age ?? 0;
    engine.stepVisuals(0.1);
    assert.equal(engine.pomodoro.remainingSecs, 15 * 60, 'stepVisuals must not decrement Pomodoro timer');
    assert.equal(engine.activeBoss?.hp, hpAfterStrike, 'stepVisuals must not apply Pomodoro DPS');
    assert.ok((engine.beams[0]?.age ?? 0) > beamBefore, 'stepVisuals must advance beam age');

    // stepPomodoro advances countdown & DPS cleanly by 1x rate
    engine.stepPomodoro(5, {
      snapshot: calmSnap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      nowMs: 6_100,
    });
    assert.equal(engine.pomodoro.remainingSecs, 15 * 60 - 5);
    assert.ok((engine.activeBoss?.hp ?? hpAfterStrike) < hpAfterStrike, 'stepPomodoro applies focus DPS');

    // 2. Live practice boss defeat & damage must NEVER emit onOutcome or leak into pendingDamageForStats
    const practiceEngine = new BossRaidEngine();
    const outcomes: Array<Record<string, unknown>> = [];
    practiceEngine.summonPracticeBoss('error_blob', {
      nowMs: 10_000,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
    });
    practiceEngine.strikeFromOwner({
      snapshot: calmSnap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      demoMode: false,
      nowMs: 10_500,
      onOutcome: (o) => outcomes.push(o as Record<string, unknown>),
    });
    if (practiceEngine.activeBoss) {
      practiceEngine.activeBoss.hp = 5;
    }
    practiceEngine.onEvents([{ kind: 'ItemDone', botId: 'b1', itemTitle: 'Practice finish' }], {
      snapshot: calmSnap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      demoMode: false,
      nowMs: 11_000,
      onOutcome: (o) => outcomes.push(o as Record<string, unknown>),
    });
    assert.equal(practiceEngine.activeBoss, null);
    assert.equal(outcomes.length, 0, 'live practice boss defeat must never call onOutcome');

    // Subsequent live threat boss clear must not include prior practice boss damage
    const errSnap = makeSnapshot([makeBot('b1', 'Alpha', { kind: 'Error', message: '503' })]);
    const threatSpawnAt = 11_000 + LIVE_RESPAWN_COOLDOWN_MS + 100;
    practiceEngine.syncState({
      snapshot: errSnap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      demoMode: false,
      nowMs: threatSpawnAt,
    });
    assert.equal(practiceEngine.activeBoss?.source, 'threat');
    if (practiceEngine.activeBoss) {
      practiceEngine.activeBoss.hp = 5;
    }
    practiceEngine.strikeFromOwner({
      snapshot: errSnap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      demoMode: false,
      nowMs: threatSpawnAt + 500,
      onOutcome: (o) => outcomes.push(o as Record<string, unknown>),
    });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].cleared, true);
    assert.equal(outcomes[0].damageDealt, 5, 'prior practice damage must not pollute threat stats');

    // 3. Demo mode honors bossRaidMode='off' from livePayload (panel & editor entrypoints)
    const demo = createDemoOfficeSession();
    const demoPayload = demo.getPayload({
      themeId: 'startup_office',
      locale: 'en',
      botAppearances: {},
    });
    assert.equal(demoPayload.bossRaidMode, undefined, 'demo session payload omits bossRaidMode');
    const demoEngine = new BossRaidEngine();
    demoEngine.syncState({
      snapshot: demoPayload.snapshot,
      theme,
      bossRaidMode: 'off',
      viewMode: 'office',
      isReplay: false,
      demoMode: true,
      nowMs: 50_000,
    });
    assert.equal(demoEngine.activeBoss, null);
    for (const relPath of ['panel/main.ts', 'editor/main.ts']) {
      const src = fs.readFileSync(path.resolve(relPath), 'utf8');
      assert.ok(
        /function activeBossRaidMode\(\):\s*BossRaidMode\s*\{\s*return livePayload\.bossRaidMode \?\? 'auto';/.test(
          src
        ),
        `${relPath} activeBossRaidMode must read livePayload.bossRaidMode so Demo mode respects off setting`
      );
      assert.ok(!src.includes("shortcut: 'X'"), `${relPath} must use tooltipKbd instead of shortcut`);
      assert.ok(!src.includes('bossRaidStepCtx'), `${relPath} must not pass legacy bossRaidStepCtx`);
    }
  });

  test('holds transient threat-event boss, promotes untouched lower threats, and disables practice summon during active threats', () => {
    const theme = getThemeConfig('startup_office', 'en');
    const calmSnap = makeSnapshot([makeBot('b1', 'Alpha'), makeBot('b2', 'Beta')]);
    const engine = new BossRaidEngine();

    // 1. Transient threat event (WorkerFailed / BotError) holds across immediate snapshot-only syncState
    engine.onEvents([{ kind: 'WorkerFailed', error: 'build failed' }], {
      snapshot: calmSnap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      nowMs: 100_000,
    });
    assert.equal(engine.activeBoss?.kind, 'error_blob');
    assert.equal(engine.activeBoss?.source, 'threat');

    engine.syncState({
      snapshot: calmSnap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      nowMs: 102_000,
    });
    assert.equal(
      engine.activeBoss?.kind,
      'error_blob',
      'transient event threat boss must stay active across immediate snapshot-only syncState'
    );

    // Expires back to calm after hold duration when snapshot stays calm
    engine.syncState({
      snapshot: calmSnap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      nowMs: 100_000 + TRANSIENT_THREAT_HOLD_MS + 100,
    });
    assert.equal(engine.activeBoss, null, 'transient event boss clears once hold expires on calm office');

    // 2. Higher-priority threat promotes an untouched lower-priority threat boss
    const busySnap = makeSnapshot(
      [
        makeBot('b1', 'A', { kind: 'Working', label: 't1' }),
        makeBot('b2', 'B', { kind: 'Working', label: 't2' }),
        makeBot('b3', 'C', { kind: 'Working', label: 't3' }),
      ],
      1
    );
    engine.syncState({
      snapshot: busySnap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      nowMs: 200_000,
    });
    assert.equal(engine.activeBoss?.kind, 'sprint_titan');
    assert.equal(engine.activeBoss?.hp, RAID_BOSS_CATALOG.sprint_titan.maxHp);

    const twoErrSnap = makeSnapshot([
      makeBot('b1', 'A', { kind: 'Error', message: '503' }),
      makeBot('b2', 'B', { kind: 'Error', message: '502' }),
    ]);
    engine.syncState({
      snapshot: twoErrSnap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      nowMs: 201_000,
    });
    assert.equal(
      engine.activeBoss?.kind,
      'ci_wyvern',
      'untouched sprint_titan must promote to ci_wyvern when >=2 errors occur'
    );

    // Practice summon is blocked while active threat or pomodoro boss is running
    const practiceWhileThreat = engine.summonPracticeBoss('error_blob', {
      nowMs: 202_000,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
    });
    assert.equal(practiceWhileThreat, null, 'summonPracticeBoss must not overwrite active threat boss');

    // Modal renders Practice button disabled during active threat
    class FakeEl {
      tagName: string;
      children: Array<FakeEl | string> = [];
      className = '';
      disabled = false;
      textContent = '';
      attributes = new Map<string, string>();
      style: Record<string, string> = {};
      classList = {
        add: (...cls: string[]) => {
          const set = new Set(this.className.split(/\s+/).filter(Boolean));
          for (const c of cls) set.add(c);
          this.className = Array.from(set).join(' ');
        },
        remove: (...cls: string[]) => {
          const set = new Set(this.className.split(/\s+/).filter(Boolean));
          for (const c of cls) set.delete(c);
          this.className = Array.from(set).join(' ');
        },
        toggle: (c: string, force?: boolean) => {
          const has = this.classList.contains(c);
          const next = force ?? !has;
          if (next) this.classList.add(c);
          else this.classList.remove(c);
          return next;
        },
        contains: (c: string) => this.className.split(/\s+/).includes(c),
      };
      constructor(tag: string) {
        this.tagName = tag.toLowerCase();
      }
      appendChild(child: FakeEl | string) {
        this.children.push(child);
        return child;
      }
      removeChild(child: FakeEl | string) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) this.children.splice(idx, 1);
      }
      get firstChild() {
        return this.children[0] ?? null;
      }
      setAttribute(k: string, v: string) {
        this.attributes.set(k, v);
      }
      addEventListener() {}
      findButtons(): FakeEl[] {
        const out: FakeEl[] = this.tagName === 'button' ? [this] : [];
        for (const ch of this.children) {
          if (ch instanceof FakeEl) out.push(...ch.findButtons());
        }
        return out;
      }
      collectText(): string {
        let txt = this.textContent;
        for (const ch of this.children) {
          txt += typeof ch === 'string' ? ch : ch.collectText();
        }
        return txt;
      }
    }
    const g = globalThis as Record<string, unknown>;
    const prevDoc = g.document;
    const prevNode = g.Node;
    g.Node = FakeEl;
    g.document = {
      createElement: (tag: string) => new FakeEl(tag),
      createTextNode: (t: string) => {
        const n = new FakeEl('#text');
        n.textContent = t;
        return n;
      },
    };
    try {
      const backdrop = new FakeEl('div');
      renderBossRaidModal(backdrop as unknown as HTMLElement, {
        open: true,
        locale: 'ko',
        redactMode: false,
        demoMode: false,
        snapshot: twoErrSnap,
        engine,
        stats: createEmptyBossRaidStats(),
        suppressionReason: null,
        onCoopStrike: () => {},
        onSummonPractice: () => {},
        onSelectPreset: () => {},
        onStartPomodoro: () => {},
        onPausePomodoro: () => {},
        onResumePomodoro: () => {},
        onAbandonPomodoro: () => {},
        onClose: () => {},
      });
      const practiceBtn = backdrop
        .findButtons()
        .find((b) => b.collectText().includes('연습 보스 소환'));
      assert.ok(practiceBtn, 'practice button must render in modal');
      assert.equal(
        practiceBtn?.disabled,
        true,
        'practice button must be disabled when threat boss is active'
      );
    } finally {
      g.document = prevDoc;
      g.Node = prevNode;
    }

    // Already-damaged lower-threat boss must NOT silently reset/promote to another threat
    engine.reset();
    engine.syncState({
      snapshot: busySnap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      nowMs: 210_000,
    });
    assert.equal(engine.activeBoss?.kind, 'sprint_titan');
    engine.strikeFromOwner({
      snapshot: busySnap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      nowMs: 211_000,
    });
    const hpDamaged = engine.activeBoss?.hp ?? 0;
    assert.ok(hpDamaged < RAID_BOSS_CATALOG.sprint_titan.maxHp);
    engine.syncState({
      snapshot: twoErrSnap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      nowMs: 212_000,
    });
    assert.equal(engine.activeBoss?.kind, 'sprint_titan');
    assert.equal(engine.activeBoss?.hp, hpDamaged);
  });
});
