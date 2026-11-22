import fs from 'node:fs';
import path from 'node:path';
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing';
import { decodeBotWorldContent, encodeBotWorldContent, mergeBotWorldDocuments } from '../editor/doc-sync.ts';
import { getThemeConfig } from '../shared/assets-catalog.ts';
import { createDemoOfficeSession } from '../shared/demo-office.ts';
import { el } from '../shared/dom.ts';
import { tStrings } from '../shared/i18n.ts';
import { MotionDirector, ReplayController } from '../shared/motion.ts';
import { buildOfficeReport, formatReportMarkdown, renderOfficeReportModal } from '../shared/office-report.ts';
import {
  PHOTO_CARD_BANNER_HEIGHT,
  buildPhotoCardFilename,
  buildPhotoCardMetadata,
  composePhotoCardCanvas,
  downloadPhotoCardCanvas,
} from '../shared/photo-card.ts';
import { mapKeyToShortcutAction, renderShortcutsModal, shouldIgnoreShortcutEvent } from '../shared/shortcuts.ts';
import { resolveAtmospherePhase } from '../shared/stage-renderer.ts';
import { TIMELAPSE_DURATION_MS, TimelapseController } from '../shared/timelapse.ts';
import {
  MAX_TEAM_ZONES,
  MAX_ZONE_LABEL_LENGTH,
  STARTER_TEAM_ZONES,
  formatZoneDisplayLabel,
  renderZonesModal,
  sanitizeTeamZones,
  zonesModalRenderKey,
} from '../shared/zones.ts';
import type { OrcaClient } from './orca-cli.ts';
import {
  DEFAULT_BOTWORLD_DOCUMENT,
  type ThemeId,
  type WorldEventRecord,
  createEmptySnapshot,
  validateBotWorldDocument,
} from './types.ts';
import {
  MAX_WEEKLY_TREND_DAYS,
  formatLocalDateKey,
  getLastSevenDaysTrend,
  hydrateWeeklyTrendStore,
  mergeEventsIntoWeeklyTrend,
  mergeWeeklyTrendStore,
} from './weekly-trend.ts';
import { BotWorldWorkerController } from './worker.ts';

function makeSampleSnapshot(nowMs: number) {
  const snap = createEmptySnapshot();
  snap.capturedAt = nowMs;
  snap.runtime.connected = true;
  snap.runtime.reachable = true;
  snap.bots['b1'] = {
    id: 'b1',
    name: 'SecretBotAlpha',
    agent: 'claude',
    paused: false,
    specialty: 'Security',
    status: { kind: 'Working', tool: 'read_file' },
    currentTaskTitle: 'Audit secret token',
    currentTool: 'read_file',
    lastActivityAt: nowMs,
    homeChatId: 'c1',
    needsYouCount: 0,
    activeWorkerCount: 1,
  };
  snap.bots['b2'] = {
    id: 'b2',
    name: 'OpsBotBeta',
    agent: 'codex',
    paused: false,
    specialty: 'Infra',
    status: { kind: 'Idle' },
    currentTaskTitle: null,
    currentTool: null,
    lastActivityAt: nowMs - 10_000,
    homeChatId: 'c2',
    needsYouCount: 0,
    activeWorkerCount: 0,
  };
  snap.botOrder = ['b1', 'b2'];
  snap.workers['w1'] = {
    dispatchId: 'w1',
    taskId: 't1',
    runId: 'r1',
    parentBotId: 'b1',
    parentBotName: 'SecretBotAlpha',
    provider: 'claude',
    model: 'sonnet',
    workerState: 'ready',
    dispatchStatus: 'dispatched',
    terminalState: 'attached',
    terminalHandle: 'term_1',
    worktreeId: 'wt_1',
    liveness: 'Live',
    activity: 'working',
    toolName: 'read_file',
    taskTitle: 'Check files',
    updatedAt: nowMs,
  };
  return snap;
}

function makeMinimalClient(): { client: OrcaClient; setItemStatus: (status: string) => void } {
  let itemStatus = 'in_progress';
  const client: OrcaClient = {
    isStopped: () => false,
    status: async () => ({
      ok: true,
      result: { runtime: { state: 'ready', reachable: true, runtimeId: 'rt-sr' } },
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
    botItemList: async () => ({
      ok: true,
      result: {
        items: [
          {
            uid: 'it-1',
            number: 1,
            title: 'Task 1',
            status: itemStatus,
            version: 1,
          },
        ],
      },
    }),
    worktreePs: async () => ({ ok: true, result: { worktrees: [] } }),
    orchestrationInbox: async () => ({ ok: true, result: { messages: [] } }),
    orchestrationWorkerList: async () => ({ ok: true, result: { workers: [] } }),
    orchestrationRunList: async () => ({ ok: true, result: { runs: [] } }),
    automationsList: async () => ({ ok: true, result: { automations: [] } }),
    automationsRuns: async () => ({ ok: true, result: { runs: [] } }),
  };
  return {
    client,
    setItemStatus: (status: string) => {
      itemStatus = status;
    },
  };
}

function installFakeDom() {
  const g = globalThis as Record<string, unknown>;
  const prevDoc = g.document;
  const prevNode = g.Node;
  const prevHtmlInput = g.HTMLInputElement;
  const prevHtmlImg = g.HTMLImageElement;

  class FakeNode {
    childNodes: FakeNode[] = [];
    parentNode: FakeNode | null = null;
    textContent = '';
    get firstChild(): FakeNode | null {
      return this.childNodes[0] ?? null;
    }
    appendChild(child: FakeNode): FakeNode {
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    removeChild(child: FakeNode): FakeNode {
      const idx = this.childNodes.indexOf(child);
      if (idx >= 0) {
        this.childNodes.splice(idx, 1);
        child.parentNode = null;
      }
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
    href = '';
    download = '';
    type = '';
    value = '';
    maxLength = 0;
    disabled = false;
    clicked = false;
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
    listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    constructor(public tagName: string) {
      super();
    }
    setAttribute(): void {}
    addEventListener(ev: string, cb: (...args: unknown[]) => void): void {
      const list = this.listeners.get(ev) ?? [];
      list.push(cb);
      this.listeners.set(ev, list);
    }
    click(): void {
      this.clicked = true;
    }
  }
  class FakeHtmlInput extends FakeElement {}
  class FakeHtmlImage extends FakeElement {
    src = '';
    alt = '';
  }

  const body = new FakeElement('body');
  g.Node = FakeNode;
  g.HTMLInputElement = FakeHtmlInput;
  g.HTMLImageElement = FakeHtmlImage;
  g.document = {
    body,
    createElement: (tag: string) =>
      tag === 'img'
        ? new FakeHtmlImage(tag)
        : tag === 'input'
          ? new FakeHtmlInput(tag)
          : new FakeElement(tag),
    createTextNode: (text: string) => {
      const n = new FakeNode();
      n.textContent = text;
      return n;
    },
  };

  return {
    FakeElement,
    body,
    restore: () => {
      g.document = prevDoc;
      g.Node = prevNode;
      g.HTMLInputElement = prevHtmlInput;
      g.HTMLImageElement = prevHtmlImg;
    },
  };
}

describe('Bot World v0.6.0 — Share & Replay+ + v0.5.0 Audit Refinements', () => {
  test('photo-card.ts builds sanitized filenames, banner metadata, redact badge, and revokes blob URLs in finally', async () => {
    const ts = new Date(2026, 10, 22, 9, 5, 0).getTime();
    assert.equal(buildPhotoCardFilename('cozy_cafe', ts), 'bot-world-cozy_cafe-20261122-0905.png');
    assert.equal(
      buildPhotoCardFilename('../../Users/alice/secret' as unknown as ThemeId, ts),
      'bot-world-startup_office-20261122-0905.png'
    );

    const snap = makeSampleSnapshot(ts);
    const events: WorldEventRecord[] = [
      {
        timestampMs: ts - 3600_000,
        summary: 'Working',
        redactedSummary: 'Working',
        event: { kind: 'BotWorking', botId: 'b1', botName: 'SecretBotAlpha', tool: 'read_file' },
      },
      {
        timestampMs: ts - 26 * 3600_000, // Outside 24h window
        summary: 'Old',
        redactedSummary: 'Old',
        event: { kind: 'BotIdle', botId: 'b2', botName: 'OpsBotBeta' },
      },
    ];

    const metaNormal = buildPhotoCardMetadata({
      snapshot: snap,
      events,
      themeId: 'cyber_ops',
      atmosphereMode: 'night',
      weatherMode: 'starlight',
      redactMode: false,
      locale: 'en',
      timestampMs: ts,
    });
    assert.equal(metaNormal.title, 'Bot World');
    assert.equal(metaNormal.themeName, 'Cyber Ops');
    assert.equal(metaNormal.bots, 2);
    assert.equal(metaNormal.working, 1);
    assert.equal(metaNormal.workers, 1);
    assert.equal(metaNormal.events24h, 1);
    assert.equal(metaNormal.redacted, false);
    assert.equal(metaNormal.redactBadgeLabel, null);

    const metaRedactedKo = buildPhotoCardMetadata({
      snapshot: snap,
      events,
      themeId: 'cozy_cafe',
      atmosphereMode: 'sunset',
      weatherMode: 'rain',
      redactMode: true,
      locale: 'ko',
      timestampMs: ts,
    });
    assert.equal(metaRedactedKo.title, '봇 월드');
    assert.equal(metaRedactedKo.themeName, '코지 카페');
    assert.equal(metaRedactedKo.redacted, true);
    assert.ok(metaRedactedKo.redactBadgeLabel?.includes('가림 모드'));

    // Canvas compositor dimensions & text calls
    const filledTexts: string[] = [];
    const fakeCtx = {
      save: () => {},
      restore: () => {},
      fillRect: () => {},
      drawImage: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }),
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      quadraticCurveTo: () => {},
      closePath: () => {},
      fill: () => {},
      stroke: () => {},
      measureText: (t: string) => ({ width: t.length * 7 }),
      fillText: (t: string) => {
        filledTexts.push(t);
      },
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      font: '',
      textAlign: 'left',
      textBaseline: 'middle',
    };
    const cardCanvas = composePhotoCardCanvas(
      { width: 1376, height: 768 } as unknown as HTMLCanvasElement,
      metaRedactedKo,
      (w, h) =>
        ({
          width: w,
          height: h,
          getContext: () => fakeCtx,
        }) as unknown as HTMLCanvasElement
    );
    assert.ok(cardCanvas !== null);
    assert.equal(cardCanvas.width, 1376);
    assert.equal(cardCanvas.height, 768 + PHOTO_CARD_BANNER_HEIGHT);
    assert.ok(filledTexts.some((t) => t.includes('가림 모드')));
    assert.equal(filledTexts.some((t) => t.includes('SecretBotAlpha')), false);

    // Headless download safety (no document)
    const headlessOk = await downloadPhotoCardCanvas(
      cardCanvas,
      'bot-world-cozy_cafe-20261122-0905.png'
    );
    assert.equal(headlessOk, false);

    // DOM download guarantees URL.revokeObjectURL and anchor removal in finally even when click() throws
    const dom = installFakeDom();
    const g = globalThis as Record<string, unknown>;
    const prevUrl = g.URL;
    let createdCount = 0;
    let revokedUrl: string | null = null;
    g.URL = {
      createObjectURL: () => {
        createdCount += 1;
        return 'blob:bot-world-test-1';
      },
      revokeObjectURL: (u: string) => {
        revokedUrl = u;
      },
    };
    try {
      const throwingCanvas = {
        toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(['png'], { type: 'image/png' })),
      } as unknown as HTMLCanvasElement;
      const prevCreateEl = (g.document as { createElement: (t: string) => unknown }).createElement;
      (g.document as { createElement: (t: string) => unknown }).createElement = (tag: string) => {
        const el = prevCreateEl(tag) as InstanceType<typeof dom.FakeElement>;
        if (tag === 'a') {
          el.click = () => {
            throw new Error('simulated click failure');
          };
        }
        return el;
      };
      const ok = await downloadPhotoCardCanvas(throwingCanvas, 'bot-world-test.png');
      assert.equal(ok, false);
      assert.equal(createdCount, 1);
      assert.equal(revokedUrl, 'blob:bot-world-test-1');
      assert.equal(dom.body.childNodes.length, 0);
    } finally {
      g.URL = prevUrl;
      dom.restore();
    }
  });

  test('timelapse.ts compresses 24h range into 10s linearly, handles degenerate ranges, and Demo Mode sweeps Day -> Sunset -> Night', () => {
    assert.equal(TIMELAPSE_DURATION_MS, 10_000);
    const tl = new TimelapseController();
    const t0 = 1_700_000_000_000;
    const tEnd = t0 + 24 * 3600_000;

    const startRes = tl.start([t0, tEnd], tEnd);
    assert.equal(tl.active, true);
    assert.equal(startRes.cursorMs, t0);
    assert.equal(tl.formatProgress(), '00.0s / 10s');

    const step1 = tl.advance(4_200);
    assert.equal(step1.active, true);
    assert.equal(step1.completed, false);
    assert.ok(Math.abs(step1.fraction - 0.42) < 1e-6);
    assert.equal(step1.cursorMs, t0 + Math.round(24 * 3600_000 * 0.42));
    assert.equal(tl.formatProgress(), '04.2s / 10s');

    const step2 = tl.advance(5_800);
    assert.equal(step2.active, false);
    assert.equal(step2.completed, true);
    assert.equal(step2.fraction, 1);
    assert.equal(step2.cursorMs, tEnd);

    // Cancellation & reset
    tl.start([t0, tEnd], tEnd);
    tl.advance(2_000);
    tl.stop();
    assert.equal(tl.active, false);
    tl.reset();
    assert.equal(tl.elapsedMs, 0);

    // Degenerate single-timestamp range safety
    const degenStart = tl.start([t0, t0], t0);
    assert.equal(degenStart.cursorMs, t0);
    const degenMid = tl.advance(5_000);
    assert.equal(degenMid.cursorMs, t0);
    assert.equal(Number.isFinite(degenMid.cursorMs), true);

    const nullStart = tl.start(null, tEnd);
    assert.equal(nullStart.cursorMs, tEnd);
    const nullEnd = tl.advance(10_000);
    assert.equal(nullEnd.cursorMs, tEnd);
    assert.equal(nullEnd.completed, true);

    // Demo Mode history spans 18h across Day -> Sunset -> Night
    const demo = createDemoOfficeSession(new Date(2026, 10, 22, 12, 0, 0).getTime());
    const demoPayload = demo.getPayload({
      themeId: 'startup_office',
      redactMode: false,
      locale: 'en',
      languageSetting: 'en',
      botAppearances: {},
    });
    const replay = new ReplayController();
    const bounds = replay.timeBounds(demoPayload.keyframes, demoPayload.events);
    assert.ok(bounds !== null);
    assert.ok(bounds[1] - bounds[0] >= 18 * 3600_000);

    const phases = new Set<string>();
    const theme = getThemeConfig('startup_office', 'en');
    tl.start(bounds, demoPayload.snapshot.capturedAt);
    replay.seekTo(bounds[0], demoPayload.keyframes, demoPayload.events, demoPayload.snapshot, theme, 'en');
    phases.add(resolveAtmospherePhase('auto', replay.cursorMs));
    for (let i = 0; i < 20; i++) {
      const s = tl.advance(500);
      replay.advanceToTimestamp(
        s.cursorMs,
        0.05,
        demoPayload.keyframes,
        demoPayload.events,
        demoPayload.snapshot,
        theme,
        'en'
      );
      phases.add(resolveAtmospherePhase('auto', replay.cursorMs));
    }
    assert.ok(phases.has('day'));
    assert.ok(phases.has('sunset'));
    assert.ok(phases.has('night'));
  });

  test('weekly-trend.ts merges idempotently, prunes >14 days, returns 7 chronological days, contains zero PII, and renders in reports', async () => {
    const day0 = new Date(2026, 10, 22, 15, 0, 0).getTime();
    const day0Key = formatLocalDateKey(day0);
    const events: WorldEventRecord[] = [
      {
        timestampMs: day0 - 120_000,
        summary: 'Worker started',
        redactedSummary: 'Worker #1',
        event: {
          kind: 'WorkerStart',
          dispatchId: 'd1',
          parentBotId: 'b1',
          parentBotName: 'SecretBotAlpha',
          provider: 'claude',
          taskTitle: 'TOP_SECRET_TITLE',
        },
      },
      {
        timestampMs: day0 - 60_000,
        summary: 'Handoff',
        redactedSummary: 'Handoff',
        event: {
          kind: 'Handoff',
          messageId: 'm1',
          from: { kind: 'Bot', botId: 'b1', botName: 'SecretBotAlpha' },
          to: { kind: 'Bot', botId: 'b2', botName: 'OpsBotBeta' },
          subject: 'CONFIDENTIAL_SUBJECT',
        },
      },
      {
        timestampMs: day0 - 10_000,
        summary: 'Item done',
        redactedSummary: 'Item done',
        event: {
          kind: 'ItemDone',
          itemUid: 'it1',
          number: 7,
          botId: 'b1',
          botName: 'SecretBotAlpha',
          title: 'CONFIDENTIAL_ITEM',
        },
      },
    ];

    // Idempotent merging across repeated polls
    const once = mergeEventsIntoWeeklyTrend([], events, day0, MAX_WEEKLY_TREND_DAYS);
    const twice = mergeEventsIntoWeeklyTrend(once, events, day0, MAX_WEEKLY_TREND_DAYS);
    assert.deepEqual(twice, once);
    assert.equal(twice.length, 1);
    assert.deepEqual(twice[0], {
      date: day0Key,
      events: 3,
      tasksDone: 1,
      workerRuns: 1,
      collaborations: 1,
    });

    // Store deduplication prevents double-counting same event IDs across polls
    let store = hydrateWeeklyTrendStore(null, day0);
    const m1 = mergeWeeklyTrendStore(store, events, day0);
    assert.equal(m1.changed, true);
    store = m1.store;
    const m2 = mergeWeeklyTrendStore(store, events, day0);
    assert.equal(m2.changed, false);
    assert.deepEqual(m2.store.days, m1.store.days);

    // Zero PII fields in serialized store
    const serialized = JSON.stringify(store);
    assert.equal(serialized.includes('SecretBotAlpha'), false);
    assert.equal(serialized.includes('TOP_SECRET_TITLE'), false);
    assert.equal(serialized.includes('CONFIDENTIAL'), false);

    // 14-day retention pruning
    const oldDate = formatLocalDateKey(day0 - 20 * 24 * 3600_000);
    const recentArchivedDate = formatLocalDateKey(day0 - 3 * 24 * 3600_000);
    const pruned = mergeEventsIntoWeeklyTrend(
      [
        { date: oldDate, events: 99, tasksDone: 9, workerRuns: 9, collaborations: 9 },
        { date: recentArchivedDate, events: 10, tasksDone: 3, workerRuns: 2, collaborations: 4 },
      ],
      events,
      day0,
      14
    );
    assert.equal(pruned.some((d) => d.date === oldDate), false);
    assert.equal(pruned.some((d) => d.date === recentArchivedDate), true);
    assert.equal(pruned.some((d) => d.date === day0Key), true);

    // Exact 7-day chronological window filling missing days with zeros
    const seven = getLastSevenDaysTrend(pruned, day0);
    assert.equal(seven.length, 7);
    assert.equal(seven[6].date, day0Key);
    assert.equal(seven[6].events, 3);
    assert.equal(seven[3].date, recentArchivedDate);
    assert.equal(seven[3].events, 10);
    assert.equal(seven[0].events, 0);
    for (let i = 1; i < seven.length; i++) {
      assert.ok(seven[i].date > seven[i - 1].date);
    }

    // Markdown & modal inclusion (EN + KO & Redact-safe)
    const snap = makeSampleSnapshot(day0);
    const report = buildOfficeReport(events, snap, {
      nowMs: day0,
      redactMode: true,
      locale: 'ko',
      weeklyTrend: seven,
    });
    assert.equal(report.weeklyTrend?.length, 7);
    const mdKo = formatReportMarkdown(report, { redactMode: true, locale: 'ko' });
    assert.ok(mdKo.includes('7일 주간 활동 추이'));
    assert.ok(mdKo.includes(day0Key));
    assert.equal(mdKo.includes('SecretBotAlpha'), false);
    assert.equal(mdKo.includes('CONFIDENTIAL'), false);

    const mdEn = formatReportMarkdown(report, { redactMode: true, locale: 'en' });
    assert.ok(mdEn.includes('7-Day Weekly Trend'));
    assert.ok(mdEn.includes(day0Key));

    const dom = installFakeDom();
    try {
      const backdrop = new dom.FakeElement('div');
      renderOfficeReportModal(backdrop as unknown as HTMLElement, {
        open: true,
        report,
        redactMode: true,
        locale: 'ko',
        copied: false,
        onCopyMarkdown: () => {},
        onClose: () => {},
      });
      const modalText = backdrop.collectText();
      assert.ok(modalText.includes('7일 주간 활동 추이'));
      assert.equal(modalText.includes('SecretBotAlpha'), false);
    } finally {
      dom.restore();
    }

    // Worker persists weeklyTrend in storage:own & returns it in payload without double-counting
    const host = mockHost({
      settings: { defaultTheme: 'startup_office', redactMode: false, pollIntervalSec: 5 },
    });
    const mock = makeMinimalClient();
    let controller!: BotWorldWorkerController;
    const worker = await mountWorker(
      {
        default: async (orca) => {
          controller = new BotWorldWorkerController(orca, mock.client);
          await controller.init({ disableAutoLoop: true });
          await controller.runPollTick(true);
          mock.setItemStatus('done');
          await controller.runPollTick(true);
          await controller.runPollTick(true);
        },
        deactivate: async () => {
          controller.dispose();
        },
      },
      { host }
    );
    try {
      const payload = await worker.request('botWorld.getState');
      assert.ok(Array.isArray(payload.weeklyTrend));
      assert.equal(payload.weeklyTrend?.length, 7);
      assert.equal(payload.weeklyTrend?.[6].events, 1);
      assert.equal(payload.weeklyTrend?.[6].tasksDone, 1);
      assert.ok(host.data().storage['botWorld.weeklyTrend'] !== undefined);
    } finally {
      await worker.deactivate();
    }
  });

  test('zones.ts validates coordinates, caps at 12, truncates labels, masks in Redact Mode, and round-trips .botworld doc-sync', () => {
    assert.equal(STARTER_TEAM_ZONES.length, 3);
    assert.equal(MAX_TEAM_ZONES, 12);
    assert.equal(MAX_ZONE_LABEL_LENGTH, 28);

    const dirtyZones = [
      {
        id: 'z1',
        label: '  Security\n\t &   Compliance Pod Over 28 Chars Long  ',
        x: -0.5,
        y: 0.99,
        w: 0.95,
        h: 0.5,
        color: 'neon-pink',
      },
      ...Array.from({ length: 15 }, (_, i) => ({
        id: `extra-${i}`,
        label: `Team ${i}`,
        x: 0.1,
        y: 0.1,
        w: 0.2,
        h: 0.2,
        color: 'emerald',
      })),
    ];
    const clean = sanitizeTeamZones(dirtyZones);
    assert.equal(clean.length, 12);
    assert.equal(clean[0].x, 0.02);
    assert.equal(clean[0].y, 0.92);
    assert.equal(clean[0].w, 0.9);
    assert.equal(clean[0].h, 0.08);
    assert.ok(clean[0].x + clean[0].w <= 1);
    assert.ok(clean[0].y + clean[0].h <= 1);
    assert.equal(clean[0].color, 'cyan');
    assert.ok(clean[0].label.length <= 28);
    assert.equal(clean[0].label.includes('\n'), false);
    assert.equal(clean[1].color, 'emerald');

    // Redact Mode masks zone labels
    assert.equal(formatZoneDisplayLabel(clean[0], 0, false, 'en'), clean[0].label);
    assert.equal(formatZoneDisplayLabel(clean[0], 0, true, 'en'), 'Zone #1');
    assert.equal(formatZoneDisplayLabel(clean[0], 1, true, 'ko'), '구역 #2');

    // .botworld round-trip validation, encode, decode, and merge
    const doc = {
      ...DEFAULT_BOTWORLD_DOCUMENT,
      zones: [...STARTER_TEAM_ZONES],
      showZones: false,
    };
    const encoded = encodeBotWorldContent(doc);
    const decoded = decodeBotWorldContent(encoded);
    assert.equal(decoded.showZones, false);
    assert.equal(decoded.zones?.length, 3);
    assert.equal(decoded.zones?.[0].label, 'Command & Triage');

    const validatedInvalid = validateBotWorldDocument(
      JSON.stringify({
        version: 1,
        themeId: 'startup_office',
        redactMode: false,
        selectedBotId: null,
        botAppearances: {},
        zones: [{ id: 'bad', label: 'X', x: 5, y: -1, w: 0.01, h: 99, color: 'bad' }],
        showZones: 'yes',
      })
    );
    assert.equal(validatedInvalid.valid, true);
    assert.equal(validatedInvalid.data.showZones, true);
    assert.equal(validatedInvalid.data.zones?.[0].x, 0.92);
    assert.equal(validatedInvalid.data.zones?.[0].y, 0.02);
    assert.equal(validatedInvalid.data.zones?.[0].w, 0.08);
    assert.equal(validatedInvalid.data.zones?.[0].h, 0.9);
    assert.equal(validatedInvalid.data.zones?.[0].color, 'cyan');

    const merged = mergeBotWorldDocuments(
      DEFAULT_BOTWORLD_DOCUMENT,
      { ...DEFAULT_BOTWORLD_DOCUMENT, zones: [clean[0]], showZones: true },
      { ...DEFAULT_BOTWORLD_DOCUMENT, zones: [...STARTER_TEAM_ZONES], showZones: false }
    );
    assert.equal(merged.zones?.length, 3);
    assert.equal(merged.showZones, false);

    // renderZonesModal masks zone labels when redactMode is true and uses zero innerHTML
    const dom = installFakeDom();
    try {
      const backdrop = new dom.FakeElement('div');
      renderZonesModal(backdrop as unknown as HTMLElement, {
        open: true,
        zones: STARTER_TEAM_ZONES,
        showZones: true,
        redactMode: true,
        locale: 'ko',
        onToggleShowZones: () => {},
        onLoadStarterPreset: () => {},
        onAddZone: () => {},
        onDeleteZone: () => {},
        onClearZones: () => {},
        onClose: () => {},
      });
      const text = backdrop.collectText();
      assert.ok(text.includes('구역 #1'));
      assert.equal(text.includes('Command & Triage'), false);
    } finally {
      dom.restore();
    }
  });

  test('v0.5.0 audit fixes: recentBotPairs stale pruning, P/Z shortcuts & modal suppression, and exitDemoMode sound sync', () => {
    const nowMs = 1_700_000_000_000;
    const snap = makeSampleSnapshot(nowMs);
    const theme = getThemeConfig('startup_office', 'en');
    const motion = new MotionDirector();

    motion.enqueueEvents(
      [
        {
          kind: 'Handoff',
          messageId: 'm1',
          from: { kind: 'Bot', botId: 'b1', botName: 'SecretBotAlpha' },
          to: { kind: 'Bot', botId: 'b2', botName: 'OpsBotBeta' },
          subject: 'Ping',
        },
      ],
      snap,
      theme,
      'en'
    );
    assert.equal(motion.recentBotPairCount(), 1);

    // Advance 10s -> still retained
    for (let i = 0; i < 40; i++) {
      motion.step(0.25, snap, theme);
    }
    assert.equal(motion.recentBotPairCount(), 1);

    // Advance past 18s -> pruned
    for (let i = 0; i < 40; i++) {
      motion.step(0.25, snap, theme);
    }
    assert.equal(motion.recentBotPairCount(), 0);

    // P & Z shortcut mapping and modal suppression
    assert.equal(mapKeyToShortcutAction('p'), 'takePhotoCard');
    assert.equal(mapKeyToShortcutAction('P'), 'takePhotoCard');
    assert.equal(mapKeyToShortcutAction('z'), 'toggleZones');
    assert.equal(mapKeyToShortcutAction('Z'), 'toggleZones');
    assert.equal(mapKeyToShortcutAction('p', { modalOpen: true }), null);
    assert.equal(mapKeyToShortcutAction('z', { modalOpen: true }), null);
    assert.equal(shouldIgnoreShortcutEvent({ key: 'p', target: null }, { modalOpen: true }), true);
    assert.equal(shouldIgnoreShortcutEvent({ key: 'z', target: null }, { modalOpen: true }), true);

    const dom = installFakeDom();
    try {
      const backdrop = new dom.FakeElement('div');
      renderShortcutsModal(backdrop as unknown as HTMLElement, {
        open: true,
        locale: 'ko',
        isEditor: true,
        onClose: () => {},
      });
      const text = backdrop.collectText();
      assert.ok(text.includes('P'));
      assert.ok(text.includes('Z'));
      assert.ok(text.includes('포토 카드'));
      assert.ok(text.includes('구역'));
    } finally {
      dom.restore();
    }

    // Verify exitDemoMode synchronously calls soundscape.setMode & stage-renderer dims cozy details
    for (const relPath of ['editor/main.ts', 'panel/main.ts']) {
      const src = fs.readFileSync(path.resolve(relPath), 'utf8');
      assert.ok(
        src.includes("soundscape.setMode(livePayload.soundMode ?? 'off', { fromUserGesture: false })"),
        `${relPath} must synchronously sync soundscape inside exitDemoMode`
      );
    }
    const rendererSrc = fs.readFileSync(path.resolve('shared/stage-renderer.ts'), 'utf8');
    assert.ok(
      rendererSrc.includes('const dimmedAlpha = filterSet !== null && !filterSet.has(bot.id) ? 0.24 : 1;'),
      'paintCozyAmbientDetails must apply 0.24 dimmed opacity when bot is filtered out'
    );
  });

  test('v0.6.0 polish fixes: DomAttrs maxLength, zones modal render key & panel vs editor subtitles', () => {
    const dom = installFakeDom();
    try {
      const inputEl = el('input', { type: 'text', maxLength: MAX_ZONE_LABEL_LENGTH }) as unknown as {
        maxLength: number;
      };
      assert.equal(inputEl.maxLength, MAX_ZONE_LABEL_LENGTH);

      const backdrop = new dom.FakeElement('div');
      const baseOpts = {
        open: true,
        zones: STARTER_TEAM_ZONES,
        showZones: true,
        redactMode: false,
        onToggleShowZones: () => {},
        onLoadStarterPreset: () => {},
        onAddZone: () => {},
        onDeleteZone: () => {},
        onClearZones: () => {},
        onClose: () => {},
      };

      // Editor default / persisted: true uses .botworld subtitle
      renderZonesModal(backdrop as unknown as HTMLElement, { ...baseOpts, locale: 'en' });
      assert.ok(backdrop.collectText().includes(tStrings('en').zonesModalSubtitle));

      // Panel (persisted: false) uses session subtitle in en and ko
      renderZonesModal(backdrop as unknown as HTMLElement, {
        ...baseOpts,
        locale: 'en',
        persisted: false,
      });
      assert.ok(backdrop.collectText().includes('Session floor overlay · Press Z to toggle'));
      assert.equal(backdrop.collectText().includes('.botworld'), false);

      renderZonesModal(backdrop as unknown as HTMLElement, {
        ...baseOpts,
        locale: 'ko',
        persisted: false,
      });
      assert.ok(backdrop.collectText().includes('세션 내 바닥 구역 · Z 키로 전환'));
      assert.equal(backdrop.collectText().includes('.botworld'), false);
    } finally {
      dom.restore();
    }

    // zonesModalRenderKey stays stable when nothing changed while open, preventing input focus loss
    const closedKey = zonesModalRenderKey({
      open: false,
      zones: STARTER_TEAM_ZONES,
      showZones: true,
      redactMode: false,
      locale: 'en',
      demoMode: false,
      persisted: true,
    });
    assert.equal(closedKey, 'closed');

    const openKey1 = zonesModalRenderKey({
      open: true,
      zones: STARTER_TEAM_ZONES,
      showZones: true,
      redactMode: false,
      locale: 'en',
      demoMode: true,
      persisted: false,
    });
    const openKey2 = zonesModalRenderKey({
      open: true,
      zones: STARTER_TEAM_ZONES.map((z) => ({ ...z })),
      showZones: true,
      redactMode: false,
      locale: 'en',
      demoMode: true,
      persisted: false,
    });
    assert.equal(openKey1, openKey2);

    const openKeyChanged = zonesModalRenderKey({
      open: true,
      zones: STARTER_TEAM_ZONES.slice(0, 2),
      showZones: true,
      redactMode: false,
      locale: 'en',
      demoMode: true,
      persisted: false,
    });
    assert.notEqual(openKey1, openKeyChanged);

    for (const relPath of ['editor/main.ts', 'panel/main.ts']) {
      const src = fs.readFileSync(path.resolve(relPath), 'utf8');
      assert.ok(
        src.includes('if (nextKey === lastZonesModalKey)'),
        `${relPath} must skip zones modal rebuild when signature is unchanged`
      );
    }
  });
});
