import { assert, describe, mockHost, mountWorker, test } from 'orca/testing';
import {
  effectiveLocale,
  formatTimeHms,
  getHostLocale,
  localizeBotErrorMessage,
  normalizeLanguageSetting,
  pickLocale,
  resolveUiLocale,
  tStrings,
} from '../shared/i18n.ts';
import {
  deskPosition,
  getCharacterSpecs,
  getThemeConfig,
  resolveCharacterId,
  resolveLandmarkLabel,
  resolveThemeName,
} from '../shared/assets-catalog.ts';
import { renderBotDetail, renderEventTimelineList } from '../shared/bot-detail-view.ts';
import { MotionDirector, ReplayController } from '../shared/motion.ts';
import { statusBadgeStyle } from '../shared/stage-renderer.ts';
import {
  actorDisplayName,
  createEventRecord,
  eventTitle,
  extractWorkerSeq,
  formatEventSummaries,
  redactWorldEvent,
  resolveHandle,
  summarizeEvent,
} from './events.ts';
import type { OrcaClient } from './orca-cli.ts';
import { TimelineBuffer } from './timeline.ts';
import { type UiLocale, type WorldEventRecord, botStatusLabel, createEmptySnapshot } from './types.ts';
import { BotWorldWorkerController, buildStatusBarText, prepareSnapshotForUi } from './worker.ts';

function createMinimalClient(): OrcaClient {
  return {
    isStopped: () => false,
    status: async () => ({
      ok: true,
      result: { runtime: { state: 'ready', reachable: true, runtimeId: 'rt-i18n' } },
    }),
    botList: async () => ({
      ok: true,
      result: {
        bots: [
          { id: 'b1', name: 'Security', agent: 'claude', paused: false, specialty: 'Security' },
          { id: 'b2', name: 'Ops Lead', agent: 'claude', paused: false, specialty: 'Coordinator' },
        ],
      },
    }),
    botChats: async () => ({ ok: true, result: { chats: [] } }),
    botItemList: async () => ({ ok: true, result: { items: [] } }),
    worktreePs: async () => ({ ok: true, result: { worktrees: [] } }),
    orchestrationInbox: async () => ({ ok: true, result: { messages: [] } }),
    orchestrationWorkerList: async () => ({
      ok: true,
      result: {
        workers: [
          {
            dispatchId: 'd1',
            runId: 'r1',
            workerState: 'ready',
            dispatchStatus: 'dispatched',
            terminalState: 'attached',
            projection: {
              provider: { id: 'claude', model: 'sonnet' },
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
}

describe('i18n localization across English and Korean', () => {
  test('resolveUiLocale, normalizeLanguageSetting, effectiveLocale, and formatTimeHms work accurately', () => {
    assert.equal(resolveUiLocale('ko'), 'ko');
    assert.equal(resolveUiLocale('KO'), 'ko');
    assert.equal(resolveUiLocale('ko-KR'), 'ko');
    assert.equal(resolveUiLocale('ko_KR'), 'ko');
    assert.equal(resolveUiLocale('en'), 'en');
    assert.equal(resolveUiLocale('en-US'), 'en');
    assert.equal(resolveUiLocale('ja-JP'), 'en');
    assert.equal(resolveUiLocale(''), 'en');
    assert.equal(resolveUiLocale(null), 'en');
    assert.equal(resolveUiLocale(undefined), 'en');

    assert.equal(normalizeLanguageSetting('auto'), 'auto');
    assert.equal(normalizeLanguageSetting('en'), 'en');
    assert.equal(normalizeLanguageSetting('ko'), 'ko');
    assert.equal(normalizeLanguageSetting('fr'), 'auto');
    assert.equal(normalizeLanguageSetting(null), 'auto');
    assert.equal(normalizeLanguageSetting(123), 'auto');

    assert.equal(effectiveLocale('auto', 'ko-KR'), 'ko');
    assert.equal(effectiveLocale('auto', 'en-US'), 'en');
    assert.equal(effectiveLocale('en', 'ko-KR'), 'en');
    assert.equal(effectiveLocale('ko', 'en-US'), 'ko');

    assert.equal(formatTimeHms(0, 'en'), '--:--:--');
    assert.equal(formatTimeHms(0, 'ko'), '--:--:--');
    assert.match(formatTimeHms(1_700_000_000_000, 'en'), /^\d{2}:\d{2}:\d{2}$/);
    assert.match(formatTimeHms(1_700_000_000_000, 'ko'), /^\d{2}:\d{2}:\d{2}$/);
  });

  test('summarizeEvent, eventTitle, actorDisplayName, and resolveHandle switch cleanly between en and ko', () => {
    const snap = createEmptySnapshot();
    snap.bots['b1'] = {
      id: 'b1',
      name: 'Security',
      agent: 'claude',
      paused: false,
      specialty: 'Auth',
      status: { kind: 'Working', tool: 'run_command' },
      currentTaskTitle: 'Check IAM',
      currentTool: 'run_command',
      lastActivityAt: 1000,
      homeChatId: 'c1',
      needsYouCount: 0,
      activeWorkerCount: 1,
    };
    snap.workers['d1'] = {
      dispatchId: 'd1',
      taskId: null,
      runId: null,
      parentBotId: 'b1',
      parentBotName: 'Security',
      provider: 'claude',
      model: null,
      workerState: 'ready',
      dispatchStatus: 'dispatched',
      terminalState: 'attached',
      terminalHandle: 'term_1',
      worktreeId: null,
      liveness: 'Live',
      activity: 'working',
      toolName: null,
      taskTitle: null,
      updatedAt: 1000,
    };

    const workerEn = resolveHandle('dispatch:d1', null, snap, snap, 'en');
    const workerKo = resolveHandle('dispatch:d1', null, snap, snap, 'ko');
    assert.equal(actorDisplayName(workerEn, 'en'), 'Worker(claude)');
    assert.equal(actorDisplayName(workerKo, 'ko'), '도우미(claude)');
    // Stored actor label re-localizes when UI locale switches
    assert.equal(actorDisplayName(workerKo, 'en'), 'Worker(claude)');
    assert.equal(actorDisplayName(workerEn, 'ko'), '도우미(claude)');
    assert.equal(actorDisplayName({ kind: 'BossDesk' }, 'en'), 'Owner');
    assert.equal(actorDisplayName({ kind: 'BossDesk' }, 'ko'), '사장님');
    assert.equal(actorDisplayName({ kind: 'AutomationBoard' }, 'en'), 'Automation Board');
    assert.equal(actorDisplayName({ kind: 'OfficeDoor' }, 'en'), 'Entrance');

    const ev = {
      kind: 'Handoff' as const,
      messageId: 'm1',
      from: { kind: 'Bot' as const, botId: 'b1', botName: 'Security' },
      to: { kind: 'BossDesk' as const },
      subject: '',
    };
    assert.equal(summarizeEvent(ev, false, 'en'), 'Handoff: Security → Owner');
    assert.equal(summarizeEvent(ev, true, 'en'), 'Security → Owner: Task handoff');
    assert.equal(summarizeEvent(ev, false, 'ko'), '인계: Security → 사장님');
    assert.equal(summarizeEvent(ev, true, 'ko'), 'Security → 사장님: 업무 인계');

    const startEv = {
      kind: 'WorkerStart' as const,
      dispatchId: 'd1',
      parentBotId: 'b1',
      parentBotName: 'Security',
      provider: 'claude',
      taskTitle: 'Audit auth',
    };
    assert.equal(eventTitle(startEv, 'en'), 'Worker(claude): Audit auth');
    assert.equal(summarizeEvent(startEv, true, 'en', 2), 'Worker #2');
    assert.equal(eventTitle(startEv, 'ko'), '도우미(claude): Audit auth');
    assert.equal(summarizeEvent(startEv, true, 'ko', 2), '도우미 #2');

    const [normEn, redEn] = formatEventSummaries(
      { kind: 'BotFailed', botId: 'b1', botName: 'Security', message: '자동화 실행 전달 실패' },
      1,
      'en'
    );
    assert.equal(normEn, 'Error: Automation failed');
    assert.equal(redEn, 'Error occurred');
  });

  test('buildStatusBarText and prepareSnapshotForUi localize English and Korean redaction masks', () => {
    const snap = createEmptySnapshot();
    assert.equal(buildStatusBarText(snap, false, 'en'), 'Bot World (Offline)');
    assert.equal(buildStatusBarText(snap, true, 'en'), 'Bot World · Redacted · Offline');
    assert.equal(buildStatusBarText(snap, false, 'ko'), '봇 월드 (오프라인)');

    snap.runtime.connected = true;
    snap.runtime.reachable = true;
    snap.runtime.errorMessage = 'internal failure';
    snap.bots['b1'] = {
      id: 'b1',
      name: 'Security',
      agent: 'claude',
      paused: false,
      specialty: 'Auth',
      status: { kind: 'NeedsOwner', count: 1, prompt: 'Approve?', optionsCount: 2 },
      currentTaskTitle: 'Secret approval',
      currentTool: null,
      lastActivityAt: 1000,
      homeChatId: null,
      needsYouCount: 1,
      activeWorkerCount: 1,
    };
    snap.bots['b2'] = {
      id: 'b2',
      name: 'IaC',
      agent: 'claude',
      paused: false,
      specialty: 'Terraform',
      status: { kind: 'Working', tool: 'run_command' },
      currentTaskTitle: 'Plan modules',
      currentTool: 'run_command',
      lastActivityAt: 1000,
      homeChatId: null,
      needsYouCount: 0,
      activeWorkerCount: 0,
    };
    snap.workers['d1'] = {
      dispatchId: 'd1',
      taskId: null,
      runId: null,
      parentBotId: 'b1',
      parentBotName: 'Security',
      provider: 'codex',
      model: 'gpt-5',
      workerState: 'ready',
      dispatchStatus: 'dispatched',
      terminalState: 'attached',
      terminalHandle: null,
      worktreeId: null,
      liveness: 'Live',
      activity: 'working',
      toolName: null,
      taskTitle: 'Inspect',
      updatedAt: 1000,
    };
    snap.automations['a1'] = {
      id: 'a1',
      name: 'Daily Audit',
      botId: 'b1',
      enabled: true,
      lastRunStatus: 'failed',
      lastRunAt: 1000,
      lastError: 'Secret trace',
      lastRunId: 'r1',
      lastRunNoReply: false,
    };

    assert.equal(
      buildStatusBarText(snap, false, 'en'),
      'Bot World · 1 needs you · 1 working · +1 workers'
    );
    assert.equal(buildStatusBarText(snap, true, 'en'), 'Bot World · Redacted · 1/2 active');
    assert.equal(
      buildStatusBarText(snap, false, 'ko'),
      '봇 월드 · 결정 1 · 작업 1 · 워커 +1'
    );

    const maskedEn = prepareSnapshotForUi(snap, true, 'en');
    assert.equal(maskedEn.runtime.errorMessage, 'Error details hidden');
    assert.equal(maskedEn.bots['b1'].agent, 'Private');
    assert.equal(maskedEn.bots['b1'].currentTaskTitle, 'Security · Needs You');
    assert.equal(maskedEn.workers['d1'].provider, 'Worker #1');
    assert.equal(maskedEn.automations['a1'].name, 'Automation #1');
    assert.equal(maskedEn.automations['a1'].lastError, 'Error details hidden');
  });

  test('assets-catalog, stage-renderer badges, and motion bubbles localize in en and ko', () => {
    const enSpecs = getCharacterSpecs('en');
    const koSpecs = getCharacterSpecs('ko');
    assert.equal(enSpecs.ddochi.displayName, 'Owl');
    assert.equal(enSpecs.ddochi.roleHint, 'Coordinator');
    assert.equal(koSpecs.ddochi.displayName, '부엉이');
    assert.equal(koSpecs.ddochi.roleHint, '조율·리더');
    assert.equal(enSpecs.security.displayName, 'Hedgehog');
    assert.equal(koSpecs.security.displayName, '고슴도치');
    assert.equal(enSpecs.worker_helper.displayName, 'Worker');
    assert.equal(koSpecs.worker_helper.displayName, '도우미');

    assert.equal(
      tStrings('en').selectBotDescEmpty,
      'No bots yet. Create a bot in Orca and it will take a desk here automatically.'
    );
    assert.equal(
      tStrings('ko').selectBotDescEmpty,
      '아직 생성된 봇이 없습니다. Orca에서 봇을 만들면 이곳 책상에 자동으로 배치됩니다.'
    );

    assert.equal(resolveCharacterId('x', 'Security'), 'security');
    assert.equal(resolveCharacterId('x', '보안'), 'security');
    assert.equal(resolveThemeName('startup_office', 'en'), 'Startup Office');
    assert.equal(resolveThemeName('corporate_office', 'ko'), '대기업 사무실');
    assert.equal(resolveLandmarkLabel('bossDesk', 'en'), 'Owner Desk');
    assert.equal(resolveLandmarkLabel('officeDoor', 'en'), 'Entrance');
    assert.equal(resolveLandmarkLabel('automationBoard', 'en'), 'Automation Board');

    assert.equal(botStatusLabel({ kind: 'Working', tool: 'run_command' }, 'en'), 'Working');
    assert.equal(botStatusLabel({ kind: 'Working', tool: 'run_command' }, 'ko'), '작업 중');

    assert.equal(statusBadgeStyle({ kind: 'Working', tool: null }, false, 'en').text, '▶ Working');
    assert.equal(
      statusBadgeStyle({ kind: 'NeedsOwner', count: 1, prompt: null, optionsCount: 2 }, false, 'en')
        .text,
      '★ Needs You (2)'
    );
    assert.equal(statusBadgeStyle({ kind: 'Idle' }, false, 'en').text, '● Idle');
    assert.equal(statusBadgeStyle({ kind: 'Idle' }, false, 'ko').text, '● 대기');

    const motion = new MotionDirector();
    const snap = createEmptySnapshot();
    snap.bots['b1'] = {
      id: 'b1',
      name: 'Security',
      agent: 'claude',
      paused: false,
      specialty: '',
      status: { kind: 'Working', tool: null },
      currentTaskTitle: null,
      currentTool: null,
      lastActivityAt: 1000,
      homeChatId: null,
      needsYouCount: 0,
      activeWorkerCount: 0,
    };
    snap.botOrder = ['b1'];

    const themeEn = getThemeConfig('startup_office', 'en');
    motion.enqueueEvents(
      [{ kind: 'BotWorking', botId: 'b1', botName: 'Security', tool: 'read_file' }],
      snap,
      themeEn,
      'en'
    );
    assert.equal(motion.bubbles[0].normalText, 'Working (read_file)');
    assert.equal(motion.bubbles[0].redactedText, 'Working');

    motion.setLocale('ko');
    assert.equal(motion.bubbles[0].normalText, '작업 중 (read_file)');
    assert.equal(motion.bubbles[0].redactedText, '작업 중');
  });

  test('worker supports botWorld.setLanguage RPC, locale parameter on getState, and settings.onDidChange', async () => {
    const host = mockHost({
      settings: {
        defaultTheme: 'startup_office',
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
          await controller.runPollTick(true);
        },
        deactivate: async () => {
          controller.dispose();
        },
      },
      { host }
    );

    try {
      const enState = await worker.request('botWorld.getState', { locale: 'en-US' });
      assert.equal(enState.locale, 'en');
      assert.equal(enState.languageSetting, 'auto');

      const koAutoState = await worker.request('botWorld.getState', { locale: 'ko-KR' });
      assert.equal(koAutoState.locale, 'ko');
      assert.equal(koAutoState.languageSetting, 'auto');

      const setEn = await worker.request('botWorld.setLanguage', {
        language: 'en',
        hostLocale: 'ko-KR',
      });
      assert.equal(setEn.languageSetting, 'en');
      assert.equal(setEn.locale, 'en');

      const afterSet = await worker.request('botWorld.getState', { locale: 'ko-KR' });
      assert.equal(afterSet.locale, 'en');
      assert.equal(afterSet.languageSetting, 'en');

      // Settings change overrides UI override just like theme & redactMode
      await workerOrca.settings.set('language', 'ko');
      await new Promise((r) => setTimeout(r, 25));
      const afterSettings = await worker.request('botWorld.getState', { locale: 'en-US' });
      assert.equal(afterSettings.languageSetting, 'ko');
      assert.equal(afterSettings.locale, 'ko');

      // Invalid language rejected
      await assert.rejects(
        () =>
          worker.request('botWorld.setLanguage', {
            language: 'fr' as unknown as 'en',
          }),
        (err: unknown) => (err as { code?: string })?.code === 'invalid_params'
      );

      // Invalid host locale inputs rejected on getState, refresh, and setLanguage
      for (const badLocale of ['', '   ', 'ko KR', '../../etc/passwd', '123', ' ko-KR ', 'en\nUS']) {
        await assert.rejects(
          () => worker.request('botWorld.getState', { locale: badLocale }),
          (err: unknown) => (err as { code?: string })?.code === 'invalid_params'
        );
        await assert.rejects(
          () => worker.request('botWorld.refresh', { locale: badLocale }),
          (err: unknown) => (err as { code?: string })?.code === 'invalid_params'
        );
        await assert.rejects(
          () =>
            worker.request('botWorld.setLanguage', {
              language: 'auto',
              hostLocale: badLocale,
            }),
          (err: unknown) => (err as { code?: string })?.code === 'invalid_params'
        );
      }
    } finally {
      await worker.deactivate();
    }
  });

  test('regression: bidirectional Interrupted/중단됨, WorkerStart seq #2/#3 preservation, and redacted actor re-translation', () => {
    // 1. Bidirectional BotFailed and Error status message normalization
    assert.equal(localizeBotErrorMessage('Interrupted', 'ko'), '중단됨');
    assert.equal(localizeBotErrorMessage('  Interrupted  ', 'ko'), '중단됨');
    assert.equal(localizeBotErrorMessage('중단됨', 'en'), 'Interrupted');
    assert.equal(localizeBotErrorMessage(' 중단됨 ', 'en'), 'Interrupted');
    assert.equal(localizeBotErrorMessage('자동화 실행 전달 실패', 'en'), 'Automation failed');
    assert.equal(localizeBotErrorMessage('Automation failed', 'ko'), '자동화 실행 전달 실패');
    assert.equal(localizeBotErrorMessage('오류 상세 가려짐', 'en'), 'Error details hidden');

    const failedFromEn = {
      kind: 'BotFailed' as const,
      botId: 'b1',
      botName: 'Security',
      message: 'Interrupted',
    };
    const failedFromKo = {
      kind: 'BotFailed' as const,
      botId: 'b1',
      botName: 'Security',
      message: ' 중단됨 ',
    };
    assert.equal(eventTitle(failedFromEn, 'ko'), '오류: 중단됨');
    assert.equal(eventTitle(failedFromKo, 'en'), 'Error: Interrupted');
    assert.deepEqual(formatEventSummaries(failedFromKo, 1, 'en'), [
      'Error: Interrupted',
      'Error occurred',
    ]);
    assert.deepEqual(formatEventSummaries(failedFromEn, 1, 'ko'), [
      '오류: 중단됨',
      '오류 발생',
    ]);

    const snap = createEmptySnapshot();
    snap.bots['b1'] = {
      id: 'b1',
      name: 'Security',
      agent: 'claude',
      paused: false,
      specialty: 'Auth',
      status: { kind: 'Error', message: '중단됨' },
      currentTaskTitle: null,
      currentTool: null,
      lastActivityAt: 1000,
      homeChatId: null,
      needsYouCount: 0,
      activeWorkerCount: 0,
    };
    snap.bots['b2'] = {
      id: 'b2',
      name: 'IaC',
      agent: 'claude',
      paused: false,
      specialty: 'Infra',
      status: { kind: 'Error', message: '  Interrupted ' },
      currentTaskTitle: null,
      currentTool: null,
      lastActivityAt: 1000,
      homeChatId: null,
      needsYouCount: 0,
      activeWorkerCount: 0,
    };
    const uiEn = prepareSnapshotForUi(snap, false, 'en');
    const uiKo = prepareSnapshotForUi(snap, false, 'ko');
    assert.equal(
      uiEn.bots['b1'].status.kind === 'Error' ? uiEn.bots['b1'].status.message : null,
      'Interrupted'
    );
    assert.equal(
      uiKo.bots['b2'].status.kind === 'Error' ? uiKo.bots['b2'].status.message : null,
      '중단됨'
    );

    // 2. WorkerStart sequence preservation (#2, #3) across createEventRecord, hydrate, and extractWorkerSeq
    const now = 1_700_000_000_000;
    const start2 = {
      kind: 'WorkerStart' as const,
      dispatchId: 'd2',
      parentBotId: 'b1',
      parentBotName: 'Security',
      provider: 'claude',
      taskTitle: 'Secret task',
    };
    const rec2 = createEventRecord(start2, now - 2000, 2, 'ko');
    assert.equal(rec2.workerSeq, 2);
    assert.equal(rec2.redactedSummary, '도우미 #2');
    assert.equal(extractWorkerSeq(rec2), 2);

    const hydrated = TimelineBuffer.hydrate(
      {
        events: [
          rec2,
          // Legacy record without workerSeq field -> extracts #3 from redactedSummary
          {
            timestampMs: now - 1000,
            summary: 'Worker(codex): Check',
            redactedSummary: 'Worker #3',
            event: {
              kind: 'WorkerStart',
              dispatchId: 'd3',
              parentBotId: 'b1',
              parentBotName: 'Security',
              provider: 'codex',
              taskTitle: 'Check',
            },
          },
          // Invalid workerSeq (0, negative, float) must not be trusted
          {
            timestampMs: now - 500,
            summary: 'Worker(claude): Bad seq',
            redactedSummary: 'Worker #4',
            workerSeq: -5,
            event: {
              kind: 'WorkerStart',
              dispatchId: 'd4',
              parentBotId: 'b1',
              parentBotName: 'Security',
              provider: 'claude',
              taskTitle: 'Bad seq',
            },
          },
        ],
        keyframes: [],
      },
      now
    );
    assert.equal(hydrated.eventLog.length, 3);
    assert.equal(hydrated.eventLog[0].workerSeq, 2);
    assert.equal(hydrated.eventLog[1].workerSeq, 3);
    assert.equal(hydrated.eventLog[2].workerSeq, 4);

    // 3. Redacted actor / worker label bidirectional re-translation
    const redactedWorkerKo = {
      kind: 'Worker' as const,
      dispatchId: 'd2',
      parentBotId: 'b1',
      label: '도우미 #2',
    };
    const redactedWorkerEn = {
      kind: 'Worker' as const,
      dispatchId: 'd2',
      parentBotId: 'b1',
      label: 'Worker #2',
    };
    assert.equal(actorDisplayName(redactedWorkerKo, 'en'), 'Worker #2');
    assert.equal(actorDisplayName(redactedWorkerEn, 'ko'), '도우미 #2');
    assert.equal(
      actorDisplayName({ ...redactedWorkerKo, label: '도우미 #2 (claude)' }, 'en'),
      'Worker #2 (claude)'
    );
    assert.equal(
      actorDisplayName({ ...redactedWorkerEn, label: 'Worker #2 (claude)' }, 'ko'),
      '도우미 #2 (claude)'
    );
    assert.equal(actorDisplayName({ kind: 'Unknown', raw: '비공개' }, 'en'), 'Private');
    assert.equal(actorDisplayName({ kind: 'Unknown', raw: 'Private' }, 'ko'), '비공개');

    const rawHandoff = {
      kind: 'Handoff' as const,
      messageId: 'm-red',
      from: {
        kind: 'Worker' as const,
        dispatchId: 'd2',
        parentBotId: 'b1',
        label: 'Worker(claude)',
      },
      to: { kind: 'Unknown' as const, raw: 'external:foo' },
      subject: 'secret',
    };
    const redactedInKo = redactWorldEvent(rawHandoff, () => '도우미 #2', 'ko');
    assert.equal(summarizeEvent(redactedInKo, true, 'en'), 'Worker #2 → Private: Task handoff');
    const redactedInEn = redactWorldEvent(rawHandoff, () => 'Worker #2', 'en');
    assert.equal(summarizeEvent(redactedInEn, true, 'ko'), '도우미 #2 → 비공개: 업무 인계');

    const redactedStartKo = redactWorldEvent(
      start2,
      () => '도우미 #2',
      'ko'
    );
    assert.equal(eventTitle(redactedStartKo, 'en'), 'Worker started (Worker #2)');
  });

  test('regression: worker buildStatePayload preserves WorkerStart #2 in redactMode, i18n keys, DOM views, and ReplayController.resyncSnapshot', async () => {
    // 1. Worker buildStatePayload preserves WorkerStart #1 / #2 across redactMode & locale switch
    const host = mockHost({
      settings: {
        defaultTheme: 'startup_office',
        redactMode: true,
        pollIntervalSec: 5,
        language: 'ko',
      },
    });
    let controller!: BotWorldWorkerController;
    const worker = await mountWorker(
      {
        default: async (orca) => {
          controller = new BotWorldWorkerController(orca, createMinimalClient());
          await controller.init({ disableAutoLoop: true });
          const internal = controller as unknown as {
            timeline: TimelineBuffer;
          };
          const ts = Date.now();
          internal.timeline.pushEvent(
            {
              kind: 'WorkerStart',
              dispatchId: 'd-one',
              parentBotId: 'b1',
              parentBotName: 'Security',
              provider: 'claude',
              taskTitle: 'Task 1',
            },
            ts - 2000,
            1,
            'ko'
          );
          internal.timeline.pushEvent(
            {
              kind: 'WorkerStart',
              dispatchId: 'd-two',
              parentBotId: 'b1',
              parentBotName: 'Security',
              provider: 'codex',
              taskTitle: 'Task 2',
            },
            ts - 1000,
            2,
            'ko'
          );
        },
        deactivate: async () => {
          controller.dispose();
        },
      },
      { host }
    );

    try {
      const koPayload = await worker.request('botWorld.getState');
      assert.equal(koPayload.events.length, 2);
      assert.equal(koPayload.events[0].workerSeq, 1);
      assert.equal(koPayload.events[0].redactedSummary, '도우미 #1');
      assert.equal(koPayload.events[1].workerSeq, 2);
      assert.equal(koPayload.events[1].redactedSummary, '도우미 #2');
      if (koPayload.events[1].event.kind === 'WorkerStart') {
        assert.equal(koPayload.events[1].event.provider, '도우미 #2');
      }

      await worker.request('botWorld.setLanguage', { language: 'en' });
      const enPayload = await worker.request('botWorld.getState');
      assert.equal(enPayload.events[1].workerSeq, 2);
      assert.equal(enPayload.events[1].redactedSummary, 'Worker #2');
      if (enPayload.events[1].event.kind === 'WorkerStart') {
        assert.equal(enPayload.events[1].event.provider, 'Worker #2');
      }
    } finally {
      await worker.deactivate();
    }

    // 2. i18n dictionary cleanup & pickLocale safety
    const enDict = tStrings('en');
    const koDict = tStrings('ko');
    assert.equal(enDict.msgRedactedSummary('Security', 'Question'), 'Security · Private Question');
    assert.equal(koDict.msgRedactedSummary('보안', '질문'), '보안 · 질문 메시지');
    assert.equal(enDict.workerStateLabels.idle, 'Idle');
    assert.equal(enDict.workerStateLabels.released, 'Released');
    assert.equal(koDict.workerStateLabels.idle, '대기');
    assert.equal(koDict.workerStateLabels.released, '해제');
    assert.equal(pickLocale({ en: 'EN', ko: 'KO' }, '__proto__' as unknown as UiLocale), 'EN');
    assert.equal(tStrings('__proto__' as unknown as UiLocale).appTitlePanel, 'Bot World');
    assert.equal(getCharacterSpecs('constructor' as unknown as UiLocale).ddochi.displayName, 'Owl');
    assert.equal(getThemeConfig('startup_office', 'toString' as unknown as UiLocale).name, 'Startup Office');
    assert.equal(typeof getHostLocale(), 'string');

    // 3. ReplayController.resyncSnapshot updates replay.snapshot & bubbles on locale switch
    const ts1 = 1_700_000_000_000;
    const snapEn = createEmptySnapshot();
    snapEn.bots['b1'] = {
      id: 'b1',
      name: 'Security',
      agent: 'claude',
      paused: false,
      specialty: '',
      status: { kind: 'Error', message: 'Interrupted' },
      currentTaskTitle: null,
      currentTool: null,
      lastActivityAt: ts1,
      homeChatId: null,
      needsYouCount: 0,
      activeWorkerCount: 0,
    };
    snapEn.botOrder = ['b1'];
    const snapKo = structuredClone(snapEn);
    snapKo.bots['b1'].status = { kind: 'Error', message: '중단됨' };

    const replay = new ReplayController();
    const eventsForReplay: WorldEventRecord[] = [
      {
        timestampMs: ts1 + 500,
        summary: 'Error: Interrupted',
        redactedSummary: 'Error occurred',
        event: { kind: 'BotFailed', botId: 'b1', botName: 'Security', message: 'Interrupted' },
      },
    ];
    replay.seekTo(
      ts1 + 600,
      [{ timestampMs: ts1, snapshot: snapEn }],
      eventsForReplay,
      snapEn,
      getThemeConfig('startup_office', 'en'),
      'en'
    );
    assert.equal(
      replay.snapshot.bots['b1'].status.kind === 'Error'
        ? replay.snapshot.bots['b1'].status.message
        : null,
      'Interrupted'
    );
    assert.equal(replay.motion.bubbles[0].normalText, 'Error: Interrupted');

    replay.resyncSnapshot(
      [{ timestampMs: ts1, snapshot: snapKo }],
      snapKo,
      getThemeConfig('startup_office', 'ko'),
      'ko'
    );
    assert.equal(
      replay.snapshot.bots['b1'].status.kind === 'Error'
        ? replay.snapshot.bots['b1'].status.message
        : null,
      '중단됨'
    );
    assert.equal(replay.motion.bubbles[0].normalText, '오류: 중단됨');

    // 4. DOM view rendering regression (renderEventTimelineList preserves #2 & renderBotDetail localizes idle/Interrupted)
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
      id = '';
      title = '';
      attrs = new Map<string, string>();
      constructor(public tagName: string) {
        super();
      }
      setAttribute(k: string, v: string): void {
        this.attrs.set(k, v);
      }
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
      const listContainer = new FakeElement('div') as unknown as HTMLElement;
      const legacyStart2: WorldEventRecord = {
        timestampMs: ts1,
        summary: 'Worker(claude): Hidden',
        redactedSummary: 'Worker #2',
        event: {
          kind: 'WorkerStart',
          dispatchId: 'd2',
          parentBotId: 'b1',
          parentBotName: 'Security',
          provider: 'claude',
          taskTitle: 'Hidden',
        },
      };
      renderEventTimelineList(listContainer, {
        events: [legacyStart2],
        redactMode: true,
        locale: 'ko',
        onJumpToTime: () => {},
      });
      assert.ok((listContainer as unknown as FakeElement).collectText().includes('도우미 #2'));

      renderEventTimelineList(listContainer, {
        events: [{ ...legacyStart2, workerSeq: 3, redactedSummary: '도우미 #3' }],
        redactMode: true,
        locale: 'en',
        onJumpToTime: () => {},
      });
      assert.ok((listContainer as unknown as FakeElement).collectText().includes('Worker #3'));

      const detailContainer = new FakeElement('div') as unknown as HTMLElement;
      const detailSnap = createEmptySnapshot();
      detailSnap.bots['b1'] = {
        id: 'b1',
        name: 'Security',
        agent: 'claude',
        paused: false,
        specialty: 'Auth',
        status: { kind: 'Error', message: '중단됨' },
        currentTaskTitle: null,
        currentTool: null,
        lastActivityAt: ts1,
        homeChatId: null,
        needsYouCount: 0,
        activeWorkerCount: 1,
      };
      detailSnap.workers['d1'] = {
        dispatchId: 'd1',
        taskId: null,
        runId: null,
        parentBotId: 'b1',
        parentBotName: 'Security',
        provider: 'claude',
        model: null,
        workerState: 'ready',
        dispatchStatus: 'dispatched',
        terminalState: 'attached',
        terminalHandle: null,
        worktreeId: null,
        liveness: 'Live',
        activity: 'idle',
        toolName: null,
        taskTitle: null,
        updatedAt: ts1,
      };
      renderBotDetail(detailContainer, {
        snapshot: detailSnap,
        bot: detailSnap.bots['b1'],
        redactMode: false,
        botAppearances: {},
        locale: 'en',
        onSelectCharacter: () => {},
      });
      const detailEnText = (detailContainer as unknown as FakeElement).collectText();
      assert.ok(detailEnText.includes('Interrupted'));
      assert.ok(detailEnText.includes('Idle'));

      renderBotDetail(detailContainer, {
        snapshot: detailSnap,
        bot: { ...detailSnap.bots['b1'], status: { kind: 'Error', message: 'Interrupted' } },
        redactMode: false,
        botAppearances: {},
        locale: 'ko',
        onSelectCharacter: () => {},
      });
      const detailKoText = (detailContainer as unknown as FakeElement).collectText();
      assert.ok(detailKoText.includes('중단됨'));
      assert.ok(detailKoText.includes('대기 · 실행 중'));
    } finally {
      g.document = prevDoc;
      g.Node = prevNode;
      g.HTMLInputElement = prevHtmlInput;
      g.HTMLImageElement = prevHtmlImg;
    }
  });

  test('generalization: keyword character matching, deterministic fallback, and 25+ bot overflow deskPosition bounds', () => {
    // Role/keyword matching across arbitrary user bot names
    assert.equal(resolveCharacterId('b-qa', 'Backend QA'), 'doc_review');
    assert.equal(resolveCharacterId('b-devops', 'DevOps Bot'), 'iac');
    assert.equal(resolveCharacterId('b-finops', 'FinOps'), 'cost');
    assert.equal(resolveCharacterId('b-sec', 'Auth Guard'), 'security');
    assert.equal(resolveCharacterId('b-cve', 'Vuln Scanner'), 'cve');
    assert.equal(resolveCharacterId('b-ops', 'OnCall Monitor'), 'cloud_ops');
    assert.equal(resolveCharacterId('b-ci', 'CI Build'), 'internal_tools');
    assert.equal(resolveCharacterId('b-pm', 'PM Planner'), 'personal_assist');
    assert.equal(resolveCharacterId('b-lead', 'Tech Lead'), 'ddochi');
    assert.equal(resolveCharacterId('b-ko-infra', '인프라 봇'), 'iac');
    assert.equal(resolveCharacterId('b-ko-cost', '비용 분석'), 'cost');

    // Unmatched bot names fall back deterministically by botId hash
    const customAlpha1 = resolveCharacterId('custom-alpha-id', 'Custom Bot Alpha');
    const customAlpha2 = resolveCharacterId('custom-alpha-id', 'Custom Bot Alpha');
    assert.equal(customAlpha1, customAlpha2);
    assert.notEqual(customAlpha1, 'worker_helper');

    // 25+ bots (indices 0..44) stay inside designSize safe boundaries & clear of officeDoor
    for (const themeId of ['startup_office', 'corporate_office'] as const) {
      const theme = getThemeConfig(themeId, 'en');
      const [designW, designH] = theme.designSize;
      const minX = 72;
      const maxX = designW - 84;
      const minY = 145;
      const maxY = designH - 36;

      for (let idx = 0; idx < 45; idx++) {
        const [x, y] = deskPosition(theme, idx);
        assert.ok(
          x >= minX && x <= maxX,
          `${themeId} desk[${idx}] x=${x} out of safe bounds [${minX}, ${maxX}]`
        );
        assert.ok(
          y >= minY && y <= maxY,
          `${themeId} desk[${idx}] y=${y} out of safe bounds [${minY}, ${maxY}]`
        );
        if (idx >= theme.botDesks.length) {
          const doorDist = Math.hypot(x - theme.officeDoor.x, y - theme.officeDoor.y);
          assert.ok(
            doorDist >= 70,
            `${themeId} overflow desk[${idx}] (${x}, ${y}) too close to officeDoor (${theme.officeDoor.x}, ${theme.officeDoor.y}), dist=${doorDist}`
          );
        }
      }
    }
  });
});
