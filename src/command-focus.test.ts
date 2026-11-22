import fs from 'node:fs';
import path from 'node:path';
import { assert, describe, test } from 'orca/testing';
import { renderBotDetail } from '../shared/bot-detail-view.ts';
import {
  CameraController,
  FOCUS_SPOTLIGHT_ZOOM,
  FOLLOW_CAM_MIN_ZOOM,
  MAX_CAMERA_ZOOM,
  MIN_CAMERA_ZOOM,
  clampPan,
  clampZoom,
  createStageViewport,
  pickNextFocusBotId,
  screenToWorld,
  worldToScreen,
} from '../shared/camera.ts';
import { buildCollabNetwork } from '../shared/collab-network.ts';
import { createDemoOfficeSession } from '../shared/demo-office.ts';
import {
  countFilterPresets,
  filterBotIds,
  getBotRedactedAlias,
  matchesSearchQuery,
  matchesStatusPreset,
} from '../shared/filter.ts';
import { computeOfficeBadges } from '../shared/office-badges.ts';
import {
  buildOfficeReport,
  formatReportMarkdown,
  renderOfficeReportModal,
} from '../shared/office-report.ts';
import {
  mapKeyToShortcutAction,
  renderShortcutsModal,
  shouldIgnoreShortcutEvent,
} from '../shared/shortcuts.ts';
import { type WorldEventRecord, type WorldSnapshot, createEmptySnapshot } from './types.ts';

function makeTestSnapshot(nowMs = 1_700_050_000_000): WorldSnapshot {
  const snap = createEmptySnapshot();
  snap.capturedAt = nowMs;
  snap.runtime.connected = true;
  snap.runtime.reachable = true;
  snap.bots['b-lead'] = {
    id: 'b-lead',
    name: 'Apollo Lead',
    agent: 'claude',
    paused: false,
    specialty: 'Release Triage',
    status: { kind: 'Working', tool: 'read_file' },
    currentTaskTitle: 'Coordinate canary rollout',
    currentTool: 'read_file',
    lastActivityAt: nowMs - 5_000,
    homeChatId: 'c1',
    needsYouCount: 0,
    activeWorkerCount: 2,
  };
  snap.bots['b-sec'] = {
    id: 'b-sec',
    name: 'Vault Guardian',
    agent: 'claude',
    paused: false,
    specialty: 'IAM & Secret Audit',
    status: { kind: 'NeedsOwner', count: 1, prompt: 'Approve IAM role?', optionsCount: 2 },
    currentTaskTitle: 'Review IAM boundary',
    currentTool: null,
    lastActivityAt: nowMs - 8_000,
    homeChatId: 'c2',
    needsYouCount: 1,
    activeWorkerCount: 0,
  };
  snap.bots['b-err'] = {
    id: 'b-err',
    name: 'Billing Watcher',
    agent: 'gemini',
    paused: false,
    specialty: 'Cloud Cost',
    status: { kind: 'Error', message: 'Quota exceeded' },
    currentTaskTitle: 'Check daily budget',
    currentTool: null,
    lastActivityAt: nowMs - 12_000,
    homeChatId: 'c3',
    needsYouCount: 0,
    activeWorkerCount: 0,
  };
  snap.bots['b-idle'] = {
    id: 'b-idle',
    name: 'Doc Alpaca',
    agent: 'codex',
    paused: false,
    specialty: 'Documentation',
    status: { kind: 'Idle' },
    currentTaskTitle: null,
    currentTool: null,
    lastActivityAt: nowMs - 600_000,
    homeChatId: 'c4',
    needsYouCount: 0,
    activeWorkerCount: 0,
  };
  snap.botOrder = ['b-lead', 'b-sec', 'b-err', 'b-idle'];
  snap.workers['w-1'] = {
    dispatchId: 'w-1',
    taskId: 't-1',
    runId: 'r-1',
    parentBotId: 'b-lead',
    parentBotName: 'Apollo Lead',
    provider: 'codex',
    model: 'gpt-5',
    workerState: 'ready',
    dispatchStatus: 'dispatched',
    terminalState: 'attached',
    terminalHandle: 'term_1',
    worktreeId: 'wt-1',
    liveness: 'Live',
    activity: 'working',
    toolName: 'run_command',
    taskTitle: 'Run canary smoke tests',
    updatedAt: nowMs - 3_000,
  };
  snap.workers['w-2'] = {
    dispatchId: 'w-2',
    taskId: 't-2',
    runId: 'r-2',
    parentBotId: 'b-lead',
    parentBotName: 'Apollo Lead',
    provider: 'claude',
    model: 'sonnet',
    workerState: 'ready',
    dispatchStatus: 'dispatched',
    terminalState: 'attached',
    terminalHandle: 'term_2',
    worktreeId: 'wt-2',
    liveness: 'Live',
    activity: 'working',
    toolName: 'edit_file',
    taskTitle: 'Update release checklist',
    updatedAt: nowMs - 2_000,
  };
  return snap;
}

describe('Bot World v0.4.0 — Command & Focus', () => {
  test('CameraController clamps zoom/pan, round-trips screen<->world, cycles focus targets, and releases follow cam', () => {
    const designSize: [number, number] = [1376, 768];
    assert.equal(clampZoom(0.2), MIN_CAMERA_ZOOM);
    assert.equal(clampZoom(Number.NaN), MIN_CAMERA_ZOOM);
    assert.equal(clampZoom(9.5), MAX_CAMERA_ZOOM);
    assert.equal(clampZoom(1.75), 1.75);

    // At zoom 1.0, pan must clamp strictly to (0, 0)
    assert.deepEqual(clampPan(500, -400, 1.0, designSize), [0, 0]);
    // At zoom 2.0, max pan is 0.25 * designSize -> [344, 192]
    assert.deepEqual(clampPan(999, -999, 2.0, designSize), [344, -192]);

    const vp = createStageViewport(1200, 720, designSize);
    for (const camPose of [
      { zoom: 1.0, panX: 0, panY: 0 },
      { zoom: 1.65, panX: -120, panY: 75 },
      { zoom: 2.6, panX: 300, panY: -180 },
    ]) {
      const [wx, wy] = screenToWorld(412, 295, vp, camPose);
      const [sx, sy] = worldToScreen(wx, wy, vp, camPose);
      assert.ok(Math.abs(sx - 412) < 1e-6, `Expected sx ~ 412, got ${sx}`);
      assert.ok(Math.abs(sy - 295) < 1e-6, `Expected sy ~ 295, got ${sy}`);
    }

    // Cursor-centered wheel zoom keeps the world point under cursor pinned
    const cam = new CameraController();
    const cursorX = 820;
    const cursorY = 240;
    const [wxBefore, wyBefore] = screenToWorld(cursorX, cursorY, vp, cam);
    cam.zoomAtScreenPoint(1.8, cursorX, cursorY, vp, true);
    const [wxAfter, wyAfter] = screenToWorld(cursorX, cursorY, vp, cam);
    assert.ok(Math.abs(wxBefore - wxAfter) < 1e-5);
    assert.ok(Math.abs(wyBefore - wyAfter) < 1e-5);

    // Smooth ease converges and snaps cleanly
    cam.focusWorldPoint(300, 200, FOCUS_SPOTLIGHT_ZOOM, designSize, { botId: 'b-sec' });
    assert.equal(cam.spotlightBotId, 'b-sec');
    assert.equal(cam.isAnimating(), true);
    for (let i = 0; i < 60; i++) {
      cam.step(0.05, designSize);
    }
    assert.ok(Math.abs(cam.zoom - FOCUS_SPOTLIGHT_ZOOM) < 1e-4);

    // Focus target cycling prioritizes NeedsOwner / Blocked / Error over Working
    const snap = makeTestSnapshot();
    const f1 = pickNextFocusBotId(snap, null);
    assert.equal(f1, 'b-sec');
    const f2 = pickNextFocusBotId(snap, f1);
    assert.equal(f2, 'b-err');
    const f3 = pickNextFocusBotId(snap, f2);
    assert.equal(f3, 'b-sec');

    // When no urgent bots exist, cycles through Working bots
    snap.bots['b-sec'].status = { kind: 'Idle' };
    snap.bots['b-err'].status = { kind: 'Idle' };
    assert.equal(pickNextFocusBotId(snap, null), 'b-lead');

    // Follow cam centers at >= 1.5x and releases on manual pan or reset
    cam.setFollowBot('b-lead');
    assert.equal(cam.followBotId, 'b-lead');
    assert.ok(cam.targetZoom >= FOLLOW_CAM_MIN_ZOOM);
    cam.updateFollowTarget(420, 310, designSize, true);
    assert.ok(cam.zoom >= FOLLOW_CAM_MIN_ZOOM);
    cam.panByScreenDelta(20, 10, vp, true);
    assert.equal(cam.followBotId, null);

    cam.setFollowBot('b-lead');
    assert.equal(cam.followBotId, 'b-lead');
    cam.reset(true);
    assert.equal(cam.followBotId, null);
    assert.equal(cam.zoom, MIN_CAMERA_ZOOM);
    assert.equal(cam.panX, 0);
    assert.equal(cam.panY, 0);
  });

  test('status filter presets & search strictly prevent leaking real bot names when Redact Mode is ON', () => {
    const snap = makeTestSnapshot();
    const counts = countFilterPresets(snap);
    assert.deepEqual(counts, {
      all: 4,
      working: 1,
      needs_you: 1,
      error: 1,
      workers: 1,
    });

    assert.equal(matchesStatusPreset(snap.bots['b-lead'], 'workers', snap), true);
    assert.equal(matchesStatusPreset(snap.bots['b-sec'], 'needs_you', snap), true);
    assert.equal(matchesStatusPreset(snap.bots['b-err'], 'error', snap), true);

    // Non-redacted search matches name, role, task, and active worker titles
    assert.equal(
      matchesSearchQuery(snap.bots['b-lead'], 'apollo', {
        snapshot: snap,
        redactMode: false,
        locale: 'en',
      }),
      true
    );
    assert.equal(
      matchesSearchQuery(snap.bots['b-lead'], 'canary smoke', {
        snapshot: snap,
        redactMode: false,
        locale: 'en',
      }),
      true
    );
    assert.equal(
      matchesSearchQuery(snap.bots['b-sec'], 'iam & secret', {
        snapshot: snap,
        redactMode: false,
        locale: 'en',
      }),
      true
    );

    // STRICT REDACT CHECK: searching real bot name, specialty, task, or worker title MUST NOT match!
    for (const secretQuery of [
      'apollo',
      'vault',
      'guardian',
      'billing',
      'alpaca',
      'release triage',
      'canary smoke',
      'iam boundary',
      'quota exceeded',
      'codex',
    ]) {
      const matched = filterBotIds(snap, {
        preset: 'all',
        query: secretQuery,
        redactMode: true,
        locale: 'en',
      });
      assert.equal(
        matched.size,
        0,
        `Redact mode leaked match for query "${secretQuery}": ${Array.from(matched).join(',')}`
      );
    }

    // Searching redacted alias ("Bot #1" in en, "봇 #2" in ko) matches safely
    assert.equal(getBotRedactedAlias('b-lead', snap, 'en'), 'Bot #1');
    assert.equal(getBotRedactedAlias('b-sec', snap, 'ko'), '봇 #2');
    const aliasMatchEn = filterBotIds(snap, {
      preset: 'all',
      query: 'bot #1',
      redactMode: true,
      locale: 'en',
    });
    assert.deepEqual(Array.from(aliasMatchEn), ['b-lead']);

    const aliasMatchKo = filterBotIds(snap, {
      preset: 'needs_you',
      query: '봇 #2',
      redactMode: true,
      locale: 'ko',
    });
    assert.deepEqual(Array.from(aliasMatchKo), ['b-sec']);
  });

  test('buildCollabNetwork aggregates bot<->bot, bot<->worker, and automation->bot edges from 24h events + Demo Office', () => {
    const nowMs = 1_700_050_000_000;
    const snap = makeTestSnapshot(nowMs);
    const events: WorldEventRecord[] = [
      // Outside 24h window -> ignored
      {
        timestampMs: nowMs - 26 * 3600_000,
        summary: 'Old handoff',
        redactedSummary: 'Old',
        event: {
          kind: 'Handoff',
          messageId: 'm-old',
          from: { kind: 'Bot', botId: 'b-err', botName: 'Billing Watcher' },
          to: { kind: 'Bot', botId: 'b-idle', botName: 'Doc Alpaca' },
          subject: 'Old',
        },
      },
      // Bot <-> Bot handoff + reply (same pair aggregated)
      {
        timestampMs: nowMs - 2 * 3600_000,
        summary: 'Handoff',
        redactedSummary: 'Handoff',
        event: {
          kind: 'Handoff',
          messageId: 'm1',
          from: { kind: 'Bot', botId: 'b-lead', botName: 'Apollo Lead' },
          to: { kind: 'Bot', botId: 'b-sec', botName: 'Vault Guardian' },
          subject: 'Audit IAM',
        },
      },
      {
        timestampMs: nowMs - 1 * 3600_000,
        summary: 'Reply',
        redactedSummary: 'Reply',
        event: {
          kind: 'Reply',
          messageId: 'm2',
          from: { kind: 'Bot', botId: 'b-sec', botName: 'Vault Guardian' },
          to: { kind: 'Bot', botId: 'b-lead', botName: 'Apollo Lead' },
          subject: 'Looks good',
        },
      },
      // WorkerStart on visible worker w-1 increments bot_worker weight
      {
        timestampMs: nowMs - 30 * 60_000,
        summary: 'Worker started',
        redactedSummary: 'Worker #1',
        event: {
          kind: 'WorkerStart',
          dispatchId: 'w-1',
          parentBotId: 'b-lead',
          parentBotName: 'Apollo Lead',
          provider: 'codex',
          taskTitle: 'Run canary smoke tests',
        },
      },
      // AutomationRun -> Bot
      {
        timestampMs: nowMs - 15 * 60_000,
        summary: 'Auto run',
        redactedSummary: 'Auto done',
        event: {
          kind: 'AutomationRun',
          automationId: 'a1',
          automationName: 'Nightly Check',
          botId: 'b-sec',
          botName: 'Vault Guardian',
          success: true,
          noReply: false,
          error: null,
        },
      },
    ];

    const edges = buildCollabNetwork(events, snap, { nowMs });
    const botBot = edges.find((e) => e.kind === 'bot_bot');
    assert.ok(botBot);
    assert.equal(botBot.weight, 2);

    const workerEdge1 = edges.find(
      (e) => e.kind === 'bot_worker' && e.to.kind === 'worker' && e.to.dispatchId === 'w-1'
    );
    const workerEdge2 = edges.find(
      (e) => e.kind === 'bot_worker' && e.to.kind === 'worker' && e.to.dispatchId === 'w-2'
    );
    assert.ok(workerEdge1);
    assert.equal(workerEdge1.weight, 2);
    assert.ok(workerEdge2);
    assert.equal(workerEdge2.weight, 1);

    const autoEdge = edges.find((e) => e.kind === 'automation_bot');
    assert.ok(autoEdge);
    assert.equal(autoEdge.weight, 1);

    // Demo Office has rich multi-bot collaboration edges out of the box
    const demo = createDemoOfficeSession(nowMs);
    const demoPayload = demo.getPayload({
      themeId: 'startup_office',
      redactMode: false,
      locale: 'en',
      languageSetting: 'en',
      botAppearances: {},
    });
    const demoEdges = buildCollabNetwork(demoPayload.events, demoPayload.snapshot, { nowMs });
    assert.ok(demoEdges.filter((e) => e.kind === 'bot_bot').length >= 3);
    assert.ok(demoEdges.filter((e) => e.kind === 'bot_worker').length >= 4);
    assert.ok(demoEdges.filter((e) => e.kind === 'automation_bot').length >= 2);
  });

  test('computeOfficeBadges determines mvp, delegator, night_owl, steady deterministically and redacts aliases in reports', () => {
    // Use local-time 23:15 so night_owl events fall in 21:00..04:59 regardless of TZ
    const nightBase = new Date(2026, 10, 21, 23, 15, 0).getTime();
    const nowMs = nightBase + 3600_000;
    const snap = makeTestSnapshot(nowMs);

    const events: WorldEventRecord[] = [
      {
        timestampMs: nightBase - 30 * 60_000,
        summary: 'Working',
        redactedSummary: 'Working',
        event: { kind: 'BotWorking', botId: 'b-lead', botName: 'Apollo Lead', tool: 'read_file' },
      },
      {
        timestampMs: nightBase - 20 * 60_000,
        summary: 'Done #1',
        redactedSummary: 'Done',
        event: {
          kind: 'ItemDone',
          itemUid: 'it-1',
          number: 1,
          botId: 'b-lead',
          botName: 'Apollo Lead',
          title: 'Secret ship',
        },
      },
      {
        timestampMs: nightBase - 10 * 60_000,
        summary: 'Worker started',
        redactedSummary: 'Worker #1',
        event: {
          kind: 'WorkerStart',
          dispatchId: 'w-1',
          parentBotId: 'b-lead',
          parentBotName: 'Apollo Lead',
          provider: 'codex',
          taskTitle: 'Tests',
        },
      },
      // b-sec has 3 night events and 0 errors -> earns steady & night_owl
      {
        timestampMs: nightBase,
        summary: 'Working',
        redactedSummary: 'Working',
        event: { kind: 'BotWorking', botId: 'b-sec', botName: 'Vault Guardian', tool: 'read_file' },
      },
      {
        timestampMs: nightBase + 5 * 60_000,
        summary: 'Tool',
        redactedSummary: 'Working',
        event: { kind: 'ToolChanged', botId: 'b-sec', botName: 'Vault Guardian', tool: 'edit_file' },
      },
      {
        timestampMs: nightBase + 10 * 60_000,
        summary: 'Needs you',
        redactedSummary: 'Needs you',
        event: {
          kind: 'ItemNeedsYou',
          itemUid: 'it-2',
          number: 2,
          botId: 'b-sec',
          botName: 'Vault Guardian',
          title: 'Secret IAM',
          optionsCount: 2,
        },
      },
      // b-err has 3 events + 1 error -> NOT eligible for steady
      {
        timestampMs: nightBase + 12 * 60_000,
        summary: 'Working',
        redactedSummary: 'Working',
        event: { kind: 'BotWorking', botId: 'b-err', botName: 'Billing Watcher', tool: 'search_web' },
      },
      {
        timestampMs: nightBase + 14 * 60_000,
        summary: 'Working',
        redactedSummary: 'Working',
        event: { kind: 'BotWorking', botId: 'b-err', botName: 'Billing Watcher', tool: 'search_web' },
      },
      {
        timestampMs: nightBase + 16 * 60_000,
        summary: 'Failed',
        redactedSummary: 'Error occurred',
        event: { kind: 'BotFailed', botId: 'b-err', botName: 'Billing Watcher', message: 'Boom' },
      },
    ];

    const summary = computeOfficeBadges(events, snap, {
      nowMs,
      redactMode: false,
      locale: 'en',
    });
    assert.equal(summary.mvpBotId, 'b-lead');
    assert.ok(summary.badgesByBot['b-lead'].includes('mvp'));
    assert.ok(summary.badgesByBot['b-lead'].includes('delegator'));
    assert.ok(summary.badgesByBot['b-lead'].includes('steady'));
    assert.ok(summary.badgesByBot['b-sec'].includes('steady'));
    assert.equal(summary.badgesByBot['b-err']?.includes('steady') ?? false, false);
    const nightWinner = summary.awards.find((a) => a.badgeId === 'night_owl');
    assert.ok(nightWinner);

    // Redact Mode uses Bot #1 / 봇 #1 alias in badge awards and report Markdown
    const redactedSummary = computeOfficeBadges(events, snap, {
      nowMs,
      redactMode: true,
      locale: 'en',
    });
    assert.equal(
      redactedSummary.awards.find((a) => a.badgeId === 'mvp')?.botName,
      'Bot #1'
    );

    const reportRedactedEn = buildOfficeReport(events, snap, {
      nowMs,
      redactMode: true,
      locale: 'en',
    });
    assert.ok(reportRedactedEn.topBots.length > 0);
    for (const tb of reportRedactedEn.topBots) {
      assert.equal(tb.botName, getBotRedactedAlias(tb.botId, snap, 'en'));
    }
    const mdEn = formatReportMarkdown(reportRedactedEn, { redactMode: true, locale: 'en' });
    assert.ok(mdEn.includes('## Top Active Bots (24h)'));
    assert.ok(mdEn.includes('## Daily MVP & Office Badges'));
    assert.ok(mdEn.includes('Bot #1'));
    for (const secretBotName of ['Apollo Lead', 'Vault Guardian', 'Billing Watcher', 'Doc Alpaca']) {
      assert.equal(
        mdEn.includes(secretBotName),
        false,
        `Redacted EN report markdown leaked real bot name "${secretBotName}"`
      );
    }

    const reportRedactedKo = buildOfficeReport(events, snap, {
      nowMs,
      redactMode: true,
      locale: 'ko',
    });
    assert.ok(reportRedactedKo.topBots.length > 0);
    for (const tb of reportRedactedKo.topBots) {
      assert.equal(tb.botName, getBotRedactedAlias(tb.botId, snap, 'ko'));
    }
    const mdKo = formatReportMarkdown(reportRedactedKo, { redactMode: true, locale: 'ko' });
    assert.ok(mdKo.includes('## 가장 활발한 봇 Top 3 (24h)'));
    assert.ok(mdKo.includes('## 오늘의 MVP & 오피스 배지'));
    assert.ok(mdKo.includes('봇 #1'));
    for (const secretBotName of ['Apollo Lead', 'Vault Guardian', 'Billing Watcher', 'Doc Alpaca']) {
      assert.equal(
        mdKo.includes(secretBotName),
        false,
        `Redacted KO report markdown leaked real bot name "${secretBotName}"`
      );
    }

    // Bot detail view and report modal render badges safely via DOM nodes
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
    class FakeHtmlInput extends FakeElement {}
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
        const n = new FakeNode();
        n.textContent = text;
        return n;
      },
    };
    try {
      const detailRoot = new FakeElement('div');
      renderBotDetail(detailRoot as unknown as HTMLElement, {
        snapshot: snap,
        bot: snap.bots['b-lead'],
        redactMode: false,
        botAppearances: {},
        locale: 'ko',
        badges: ['mvp', 'delegator'],
        onSelectCharacter: () => {},
      });
      const detailText = detailRoot.collectText();
      assert.ok(detailText.includes('오늘의 MVP'));
      assert.ok(detailText.includes('위임왕'));

      const reportBackdrop = new FakeElement('div');
      renderOfficeReportModal(reportBackdrop as unknown as HTMLElement, {
        open: true,
        report: reportRedactedEn,
        redactMode: true,
        locale: 'en',
        copied: false,
        onCopyMarkdown: () => {},
        onClose: () => {},
      });
      const modalText = reportBackdrop.collectText();
      assert.ok(modalText.includes('Daily MVP & Office Badges'));
      assert.ok(modalText.includes('Bot #1'));
      for (const secretBotName of ['Apollo Lead', 'Vault Guardian', 'Billing Watcher', 'Doc Alpaca']) {
        assert.equal(
          modalText.includes(secretBotName),
          false,
          `Redacted report modal leaked real bot name "${secretBotName}"`
        );
      }

      const shortcutsBackdrop = new FakeElement('div');
      renderShortcutsModal(shortcutsBackdrop as unknown as HTMLElement, {
        open: true,
        locale: 'en',
        isEditor: true,
        onClose: () => {},
      });
      const shortcutsText = shortcutsBackdrop.collectText();
      for (const keyChar of ['N', 'F', '0', '/', 'C']) {
        assert.ok(shortcutsText.includes(keyChar), `Expected shortcut help to list ${keyChar}`);
      }
    } finally {
      g.document = prevDoc;
      g.Node = prevNode;
      g.HTMLInputElement = prevHtmlInput;
      g.HTMLImageElement = prevHtmlImg;
    }
  });

  test('shortcuts dispatch N, F, 0, /, C cleanly, suppress input focus (except Escape), and copyReportMarkdown cleans up in finally', () => {
    assert.equal(mapKeyToShortcutAction('n'), 'focusUrgent');
    assert.equal(mapKeyToShortcutAction('N'), 'focusUrgent');
    assert.equal(mapKeyToShortcutAction('f'), 'toggleFollowCam');
    assert.equal(mapKeyToShortcutAction('F'), 'toggleFollowCam');
    assert.equal(mapKeyToShortcutAction('0'), 'resetCamera');
    assert.equal(mapKeyToShortcutAction('/'), 'focusSearch');
    assert.equal(mapKeyToShortcutAction('c'), 'toggleCollabNetwork');
    assert.equal(mapKeyToShortcutAction('C'), 'toggleCollabNetwork');
    assert.equal(mapKeyToShortcutAction('Escape'), 'closeOrClearSelection');

    const inputTarget = { tagName: 'INPUT' } as unknown as EventTarget;
    const textareaTarget = { tagName: 'TEXTAREA' } as unknown as EventTarget;
    const selectTarget = { tagName: 'SELECT' } as unknown as EventTarget;
    const editableTarget = { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget;

    for (const key of ['n', 'f', '0', '/', 'c']) {
      assert.equal(shouldIgnoreShortcutEvent({ key, target: inputTarget }), true);
      assert.equal(shouldIgnoreShortcutEvent({ key, target: textareaTarget }), true);
      assert.equal(shouldIgnoreShortcutEvent({ key, target: selectTarget }), true);
      assert.equal(shouldIgnoreShortcutEvent({ key, target: editableTarget }), true);
      assert.equal(shouldIgnoreShortcutEvent({ key, target: null }), false);
    }
    // Escape must still work inside input so search can blur/clear
    assert.equal(shouldIgnoreShortcutEvent({ key: 'Escape', target: inputTarget }), false);

    // v0.3.0 audit refinement: document.body.removeChild(ta) runs inside finally in both editor and panel
    for (const relPath of ['editor/main.ts', 'panel/main.ts']) {
      const src = fs.readFileSync(path.resolve(relPath), 'utf8');
      const finallyIdx = src.indexOf('finally {', src.indexOf('async function copyReportMarkdown'));
      assert.ok(finallyIdx > 0, `Expected finally block in copyReportMarkdown in ${relPath}`);
      const snippet = src.slice(finallyIdx, finallyIdx + 160);
      assert.ok(
        snippet.includes('document.body.removeChild(ta)'),
        `Expected document.body.removeChild(ta) inside finally in ${relPath}`
      );
    }
  });
});
