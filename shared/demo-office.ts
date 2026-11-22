import {
  createEventRecord,
  formatEventSummaries,
  redactWorldEvent,
  scrubWorldEvent,
} from '../src/events.ts';
import { redactLabel, scrubAll } from '../src/redact.ts';
import {
  type AtmosphereMode,
  type BotActivityStatus,
  type BotItemState,
  type BotState,
  type BotWorldStatePayload,
  type CharacterId,
  type InboxMessage,
  type Keyframe,
  type LanguageSetting,
  type ThemeId,
  type UiLocale,
  type WorkerState,
  type WorldEvent,
  type WorldEventRecord,
  type WorldSnapshot,
  botStatusLabel,
  createEmptySnapshot,
  isSafeKey,
} from '../src/types.ts';
import { tStrings } from './i18n.ts';

const MAX_DEMO_EVENTS = 120;
const MAX_DEMO_KEYFRAMES = 48;
const MAX_DEMO_MESSAGES = 20;

const KO_DEMO_TEXT = new Map<string, string>([
  // Specialties
  ['Team Coordination · Triage', '팀 조율 · 업무 분류'],
  ['Auth · IAM · Policy Review', '인증 · IAM · 정책 점검'],
  ['Terraform · Cluster Ops', '인프라 · 클라우드 클러스터 운영'],
  ['Deployments · Health Checks', '배포 · 상태 모니터링'],
  ['Spend Alerts · Budgets', '비용 이상 · 예산 관리'],
  ['CI/CD · Developer CLI', 'CI/CD · 개발 도구'],
  ['PR Notes · QA Guides', '문서 리뷰 · QA 가이드'],
  ['Office Stage · Telemetry', '오피스 스테이지 · 텔레메트리'],

  // Task titles & prompts
  ['Triage incoming PR reviews and delegate checks', '신규 PR 리뷰 분류 및 점검 위임'],
  ['Approve staging IAM role policy update?', '스테이징 IAM 역할 정책 변경을 승인할까요?'],
  ['Review staging IAM policy diff', '스테이징 IAM 정책 변경 검토'],
  ['Validate Terraform plan for staging VPC', '스테이징 VPC Terraform plan 검증'],
  ['Verify rollout readiness with Security', 'Security와 배포 준비 상태 확인'],
  ['Daily cloud spend variance check', '일일 클라우드 비용 편차 점검'],
  ['Refine plugin CLI validation rules', '플러그인 CLI 검증 규칙 개선'],
  ['Update onboarding guide for Demo Office', '데모 오피스 온보딩 가이드 업데이트'],
  ['Sync 24h office stage telemetry', '24시간 오피스 스테이지 텔레메트리 동기화'],
  ['Audit staging OAuth token TTL', '스테이징 OAuth 토큰 만료 시간 점검'],
  ['Check Helm chart diff for worker pool', '워커 풀 Helm 차트 변경분 확인'],
  ['Summarize weekly cost anomaly report', '주간 비용 이상 리포트 요약'],
  ['Verify canary latency SLOs', '카나리 지연 시간 SLO 검증'],
  ['Release checklist ready for approval', '릴리스 체크리스트 승인 대기'],
  ['Validate Terraform plan', 'Terraform plan 검증'],
  ['Scan dependency lockfiles', '의존성 락파일 취약점 스캔'],
  ['Collect test coverage summary', '테스트 커버리지 요약 수집'],
  ['Check cluster node utilization', '클러스터 노드 사용률 확인'],
  ['Inspect build cache hit rate', '빌드 캐시 적중률 점검'],

  // Items
  ['Staging IAM policy least-privilege check', '스테이징 IAM 최소 권한 점검'],
  ['Coordinate v0.1.3 release checklist', 'v0.1.3 릴리스 체크리스트 조율'],
  ['VPC peering module upgrade', 'VPC 피어링 모듈 업그레이드'],
  ['Optimize staging NAT gateway idle cost', '스테이징 NAT 게이트웨이 유휴 비용 최적화'],
  ['Add Demo Office preview mode', '데모 오피스 미리보기 모드 추가'],
  ['Draft release notes summary', '릴리스 노트 초안 요약'],
  ['Canary rollout verification', '카나리 롤아웃 검증'],
  ['Should staging role restrict S3 list scope?', '스테이징 역할의 S3 조회 범위를 제한할까요?'],

  // Automations
  ['Hourly Dependency Advisory Check', '시간별 의존성 권고 점검'],
  ['Daily Cloud Spend Digest', '일일 클라우드 비용 요약'],
  ['Staging Cluster Health Probe', '스테이징 클러스터 상태 점검'],
  ['Release Docs Sync', '릴리스 문서 동기화'],

  // Messages
  ['Review staging IAM role diff', '스테이징 IAM 역할 변경분 검토 요청'],
  ['Can you verify the least-privilege diff on the staging role?', '스테이징 역할의 최소 권한 변경분을 확인해 주세요.'],
  ['Re: Review staging IAM role diff', '회신: 스테이징 IAM 역할 변경분 검토'],
  ['Verified: policy scope looks clean after S3 prefix narrowing.', '확인 완료: S3 접두사 축소 후 정책 범위가 적절합니다.'],
  ['Need confirmation on canary traffic weight', '카나리 트래픽 비중 확인 요청'],
  ['Should canary rollout start at 10% or 25%?', '카나리 롤아웃을 10%와 25% 중 어디서 시작할까요?'],
  ['Deploy preview manifest ready', '미리보기 매니페스트 배포 준비 완료'],
  ['All staging checks passed; ready for rollout.', '모든 스테이징 점검을 통과해 배포 준비가 완료되었습니다.'],
  ['Weekly spend down 8.4% vs baseline', '주간 비용이 기준 대비 8.4% 절감되었습니다'],
  ['Idle staging workers scaled down cleanly.', '유휴 스테이징 워커가 정상 축소되었습니다.'],
  ['Terraform plan validated (0 destructive changes)', 'Terraform plan 검증 완료 (파괴적 변경 0건)'],
  ['Lockfile scan clean (0 critical advisories)', '락파일 스캔 정상 (심각 권고 0건)'],
]);

function tx(text: string, locale: UiLocale): string {
  if (locale !== 'ko') return text;
  return KO_DEMO_TEXT.get(text) ?? text;
}

function txNullable(text: string | null, locale: UiLocale): string | null {
  if (text === null) return null;
  return tx(text, locale);
}

function clonePlain<T>(val: T): T {
  return JSON.parse(JSON.stringify(val)) as T;
}

function formatDemoSnapshot(
  raw: WorldSnapshot,
  redactMode: boolean,
  locale: UiLocale
): WorldSnapshot {
  const s = tStrings(locale);
  const copy = clonePlain(raw);

  const bots: WorldSnapshot['bots'] = {};
  for (const [id, bot] of Object.entries(copy.bots)) {
    if (!isSafeKey(id)) continue;
    let status: BotActivityStatus = bot.status;
    if (redactMode) {
      if (status.kind === 'Working') {
        status = { kind: 'Working', tool: null };
      } else if (status.kind === 'NeedsOwner') {
        status = { kind: 'NeedsOwner', count: status.count, prompt: null, optionsCount: status.optionsCount };
      } else if (status.kind === 'Blocked') {
        status = { kind: 'Blocked', reason: null };
      } else if (status.kind === 'Error') {
        status = { kind: 'Error', message: status.message !== null ? s.errorHiddenLabel : null };
      }
    } else if (status.kind === 'NeedsOwner' && status.prompt) {
      status = { ...status, prompt: tx(status.prompt, locale) };
    } else if (status.kind === 'Blocked' && status.reason) {
      status = { ...status, reason: tx(status.reason, locale) };
    }

    const statusLabel = botStatusLabel(status, locale);
    const localizedTask = txNullable(bot.currentTaskTitle, locale);
    const nextBot: BotState = {
      ...bot,
      agent: redactMode ? s.privateLabel : scrubAll(bot.agent),
      specialty: redactMode ? '' : scrubAll(tx(bot.specialty, locale)),
      status,
      currentTaskTitle: redactMode ? redactLabel(bot.name, statusLabel) : localizedTask,
      currentTool: redactMode ? null : bot.currentTool,
    };
    Object.defineProperty(bots, id, {
      value: nextBot,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const workers: WorldSnapshot['workers'] = {};
  let workerIdx = 1;
  for (const [id, w] of Object.entries(copy.workers)) {
    if (!isSafeKey(id)) continue;
    const nextWorker: WorkerState = {
      ...w,
      provider: redactMode ? s.workerNumbered(workerIdx++) : scrubAll(w.provider),
      model: redactMode ? null : w.model,
      toolName: redactMode ? null : w.toolName,
      taskTitle: redactMode ? null : txNullable(w.taskTitle, locale),
      worktreeId: redactMode ? null : w.worktreeId,
    };
    Object.defineProperty(workers, id, {
      value: nextWorker,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const items: WorldSnapshot['items'] = {};
  for (const [id, it] of Object.entries(copy.items)) {
    if (!isSafeKey(id)) continue;
    const nextItem: BotItemState = {
      ...it,
      title: redactMode
        ? locale === 'ko'
          ? `비공개 작업 #${it.number}`
          : `Private Item #${it.number}`
        : scrubAll(tx(it.title, locale)),
      questionPrompt: redactMode ? null : txNullable(it.questionPrompt, locale),
    };
    Object.defineProperty(items, id, {
      value: nextItem,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const automations: WorldSnapshot['automations'] = {};
  const autoEntries = Object.entries(copy.automations)
    .filter(([id]) => isSafeKey(id))
    .sort((a, b) => a[1].name.localeCompare(b[1].name, locale, { numeric: true }));
  let autoIdx = 1;
  for (const [id, auto] of autoEntries) {
    Object.defineProperty(automations, id, {
      value: {
        ...auto,
        name: redactMode ? s.automationNumbered(autoIdx++) : scrubAll(tx(auto.name, locale)),
        lastError: auto.lastError
          ? redactMode
            ? s.errorHiddenLabel
            : scrubAll(auto.lastError)
          : null,
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const recentMessages: InboxMessage[] = redactMode
    ? []
    : copy.recentMessages.map((m) => ({
        ...m,
        subject: scrubAll(tx(m.subject, locale)),
        body: scrubAll(tx(m.body, locale)),
        payload: null,
      }));

  return {
    ...copy,
    bots,
    workers,
    items,
    automations,
    recentMessages,
  };
}

function localizeWorldEvent(event: WorldEvent, locale: UiLocale): WorldEvent {
  switch (event.kind) {
    case 'Handoff':
    case 'Question':
    case 'StatusReport':
    case 'Reply':
      return { ...event, subject: tx(event.subject, locale) };
    case 'WorkerStart':
      return { ...event, taskTitle: txNullable(event.taskTitle, locale) };
    case 'WorkerDone':
    case 'WorkerFailed':
      return { ...event, subject: tx(event.subject, locale) };
    case 'Escalation':
      return { ...event, reason: tx(event.reason, locale) };
    case 'ItemNeedsYou':
    case 'ItemDone':
    case 'ItemCanceled':
      return { ...event, title: tx(event.title, locale) };
    case 'BossReplied':
      return { ...event, subject: tx(event.subject, locale) };
    case 'AutomationRun':
      return { ...event, automationName: tx(event.automationName, locale) };
    case 'BotJoined':
      return { ...event, specialty: tx(event.specialty, locale) };
    default:
      return event;
  }
}

function buildInitialDemoSnapshot(nowMs: number): WorldSnapshot {
  const snap = createEmptySnapshot();
  snap.capturedAt = nowMs;
  snap.initialSyncComplete = true;
  snap.runtime = {
    connected: true,
    reachable: true,
    state: 'ready',
    runtimeId: 'demo-office',
    appVersion: '0.1.3',
    retryAfterSecs: null,
    errorMessage: null,
  };

  const botDefs: BotState[] = [
    {
      id: 'demo-ops-lead',
      name: 'Ops Lead',
      agent: 'claude',
      paused: false,
      specialty: 'Team Coordination · Triage',
      status: { kind: 'Working', tool: 'read_file' },
      currentTaskTitle: 'Triage incoming PR reviews and delegate checks',
      currentTool: 'read_file',
      lastActivityAt: nowMs - 8_000,
      homeChatId: 'demo-chat-ops-lead',
      needsYouCount: 0,
      activeWorkerCount: 2,
    },
    {
      id: 'demo-security',
      name: 'Security',
      agent: 'claude',
      paused: false,
      specialty: 'Auth · IAM · Policy Review',
      status: {
        kind: 'NeedsOwner',
        count: 1,
        prompt: 'Approve staging IAM role policy update?',
        optionsCount: 2,
      },
      currentTaskTitle: 'Review staging IAM policy diff',
      currentTool: null,
      lastActivityAt: nowMs - 14_000,
      homeChatId: 'demo-chat-security',
      needsYouCount: 1,
      activeWorkerCount: 0,
    },
    {
      id: 'demo-infra-ops',
      name: 'Infra Ops',
      agent: 'codex',
      paused: false,
      specialty: 'Terraform · Cluster Ops',
      status: { kind: 'Working', tool: 'run_command' },
      currentTaskTitle: 'Validate Terraform plan for staging VPC',
      currentTool: 'run_command',
      lastActivityAt: nowMs - 5_000,
      homeChatId: 'demo-chat-infra-ops',
      needsYouCount: 0,
      activeWorkerCount: 1,
    },
    {
      id: 'demo-cloud-ops',
      name: 'Cloud Ops',
      agent: 'claude',
      paused: false,
      specialty: 'Deployments · Health Checks',
      status: { kind: 'WaitingAnswer' },
      currentTaskTitle: 'Verify rollout readiness with Security',
      currentTool: null,
      lastActivityAt: nowMs - 22_000,
      homeChatId: 'demo-chat-cloud-ops',
      needsYouCount: 0,
      activeWorkerCount: 0,
    },
    {
      id: 'demo-cost-guard',
      name: 'Cost Guard',
      agent: 'gemini',
      paused: false,
      specialty: 'Spend Alerts · Budgets',
      status: { kind: 'Idle' },
      currentTaskTitle: null,
      currentTool: null,
      lastActivityAt: nowMs - 95_000,
      homeChatId: 'demo-chat-cost-guard',
      needsYouCount: 0,
      activeWorkerCount: 0,
    },
    {
      id: 'demo-dev-tools',
      name: 'Dev Tools',
      agent: 'codex',
      paused: false,
      specialty: 'CI/CD · Developer CLI',
      status: { kind: 'Working', tool: 'edit_file' },
      currentTaskTitle: 'Refine plugin CLI validation rules',
      currentTool: 'edit_file',
      lastActivityAt: nowMs - 11_000,
      homeChatId: 'demo-chat-dev-tools',
      needsYouCount: 0,
      activeWorkerCount: 1,
    },
    {
      id: 'demo-doc-review',
      name: 'Doc Review',
      agent: 'claude',
      paused: false,
      specialty: 'PR Notes · QA Guides',
      status: { kind: 'Idle' },
      currentTaskTitle: null,
      currentTool: null,
      lastActivityAt: nowMs - 120_000,
      homeChatId: 'demo-chat-doc-review',
      needsYouCount: 0,
      activeWorkerCount: 0,
    },
    {
      id: 'demo-bot-world',
      name: 'Bot World',
      agent: 'gemini',
      paused: false,
      specialty: 'Office Stage · Telemetry',
      status: { kind: 'Working', tool: 'call_mcp_tool' },
      currentTaskTitle: 'Sync 24h office stage telemetry',
      currentTool: 'call_mcp_tool',
      lastActivityAt: nowMs - 3_000,
      homeChatId: 'demo-chat-bot-world',
      needsYouCount: 0,
      activeWorkerCount: 0,
    },
  ];

  for (const bot of botDefs) {
    snap.bots[bot.id] = bot;
    snap.botOrder.push(bot.id);
    if (bot.homeChatId) {
      snap.chatIndex[bot.homeChatId] = bot.id;
    }
  }

  const workerDefs: WorkerState[] = [
    {
      dispatchId: 'demo-w-1',
      taskId: 'demo-wt-1',
      runId: 'demo-run-1',
      parentBotId: 'demo-ops-lead',
      parentBotName: 'Ops Lead',
      provider: 'claude',
      model: 'claude-sonnet',
      workerState: 'ready',
      dispatchStatus: 'dispatched',
      terminalState: 'attached',
      terminalHandle: 'term_demo_1',
      worktreeId: 'demo-wt-1',
      liveness: 'Live',
      activity: 'working',
      toolName: 'read_file',
      taskTitle: 'Collect test coverage summary',
      updatedAt: nowMs - 15_000,
    },
    {
      dispatchId: 'demo-w-2',
      taskId: 'demo-wt-2',
      runId: 'demo-run-2',
      parentBotId: 'demo-ops-lead',
      parentBotName: 'Ops Lead',
      provider: 'gemini',
      model: 'gemini-flash',
      workerState: 'ready',
      dispatchStatus: 'dispatched',
      terminalState: 'attached',
      terminalHandle: 'term_demo_2',
      worktreeId: 'demo-wt-2',
      liveness: 'Live',
      activity: 'working',
      toolName: 'search_web',
      taskTitle: 'Scan dependency lockfiles',
      updatedAt: nowMs - 12_000,
    },
    {
      dispatchId: 'demo-w-3',
      taskId: 'demo-wt-3',
      runId: 'demo-run-3',
      parentBotId: 'demo-infra-ops',
      parentBotName: 'Infra Ops',
      provider: 'codex',
      model: 'gpt-5',
      workerState: 'ready',
      dispatchStatus: 'dispatched',
      terminalState: 'attached',
      terminalHandle: 'term_demo_3',
      worktreeId: 'demo-wt-3',
      liveness: 'Live',
      activity: 'working',
      toolName: 'run_command',
      taskTitle: 'Validate Terraform plan',
      updatedAt: nowMs - 9_000,
    },
    {
      dispatchId: 'demo-w-4',
      taskId: 'demo-wt-4',
      runId: 'demo-run-4',
      parentBotId: 'demo-dev-tools',
      parentBotName: 'Dev Tools',
      provider: 'claude',
      model: 'claude-sonnet',
      workerState: 'ready',
      dispatchStatus: 'dispatched',
      terminalState: 'attached',
      terminalHandle: 'term_demo_4',
      worktreeId: 'demo-wt-4',
      liveness: 'Live',
      activity: 'working',
      toolName: 'edit_file',
      taskTitle: 'Inspect build cache hit rate',
      updatedAt: nowMs - 6_000,
    },
  ];
  for (const w of workerDefs) {
    snap.workers[w.dispatchId] = w;
  }

  snap.items = {
    'demo-item-14': {
      uid: 'demo-item-14',
      number: 14,
      ownerBotId: 'demo-security',
      ownerBotName: 'Security',
      title: 'Staging IAM policy least-privilege check',
      status: 'needs_you',
      version: 2,
      lastEventId: null,
      questionPrompt: 'Should staging role restrict S3 list scope?',
      optionsCount: 2,
      updatedAt: nowMs - 14_000,
    },
    'demo-item-15': {
      uid: 'demo-item-15',
      number: 15,
      ownerBotId: 'demo-ops-lead',
      ownerBotName: 'Ops Lead',
      title: 'Coordinate v0.1.3 release checklist',
      status: 'in_progress',
      version: 1,
      lastEventId: null,
      questionPrompt: null,
      optionsCount: 0,
      updatedAt: nowMs - 30_000,
    },
    'demo-item-16': {
      uid: 'demo-item-16',
      number: 16,
      ownerBotId: 'demo-infra-ops',
      ownerBotName: 'Infra Ops',
      title: 'VPC peering module upgrade',
      status: 'in_progress',
      version: 1,
      lastEventId: null,
      questionPrompt: null,
      optionsCount: 0,
      updatedAt: nowMs - 45_000,
    },
    'demo-item-17': {
      uid: 'demo-item-17',
      number: 17,
      ownerBotId: 'demo-cost-guard',
      ownerBotName: 'Cost Guard',
      title: 'Optimize staging NAT gateway idle cost',
      status: 'planned',
      version: 1,
      lastEventId: null,
      questionPrompt: null,
      optionsCount: 0,
      updatedAt: nowMs - 600_000,
    },
    'demo-item-18': {
      uid: 'demo-item-18',
      number: 18,
      ownerBotId: 'demo-dev-tools',
      ownerBotName: 'Dev Tools',
      title: 'Add Demo Office preview mode',
      status: 'in_progress',
      version: 3,
      lastEventId: null,
      questionPrompt: null,
      optionsCount: 0,
      updatedAt: nowMs - 25_000,
    },
  };

  snap.automations = {
    'demo-auto-1': {
      id: 'demo-auto-1',
      name: 'Hourly Dependency Advisory Check',
      botId: 'demo-security',
      enabled: true,
      lastRunStatus: 'completed',
      lastRunAt: nowMs - 1_800_000,
      lastError: null,
      lastRunId: 'demo-ar-1',
      lastRunNoReply: true,
    },
    'demo-auto-2': {
      id: 'demo-auto-2',
      name: 'Daily Cloud Spend Digest',
      botId: 'demo-cost-guard',
      enabled: true,
      lastRunStatus: 'completed',
      lastRunAt: nowMs - 3_600_000,
      lastError: null,
      lastRunId: 'demo-ar-2',
      lastRunNoReply: false,
    },
    'demo-auto-3': {
      id: 'demo-auto-3',
      name: 'Staging Cluster Health Probe',
      botId: 'demo-cloud-ops',
      enabled: true,
      lastRunStatus: 'completed',
      lastRunAt: nowMs - 900_000,
      lastError: null,
      lastRunId: 'demo-ar-3',
      lastRunNoReply: true,
    },
    'demo-auto-4': {
      id: 'demo-auto-4',
      name: 'Release Docs Sync',
      botId: 'demo-doc-review',
      enabled: true,
      lastRunStatus: 'completed',
      lastRunAt: nowMs - 5_400_000,
      lastError: null,
      lastRunId: 'demo-ar-4',
      lastRunNoReply: false,
    },
  };

  snap.recentMessages = [
    {
      id: 'demo-msg-1',
      sequence: 1,
      msgType: 'handoff',
      fromHandle: 'orca_session_id:demo-chat-ops-lead',
      toHandle: 'orca_session_id:demo-chat-security',
      runId: null,
      subject: 'Review staging IAM role diff',
      body: 'Can you verify the least-privilege diff on the staging role?',
      createdAt: new Date(nowMs - 480_000).toISOString(),
      threadId: null,
      payload: null,
    },
    {
      id: 'demo-msg-2',
      sequence: 2,
      msgType: 'status',
      fromHandle: 'orca_session_id:demo-chat-security',
      toHandle: 'orca_session_id:demo-chat-ops-lead',
      runId: null,
      subject: 'Re: Review staging IAM role diff',
      body: 'Verified: policy scope looks clean after S3 prefix narrowing.',
      createdAt: new Date(nowMs - 240_000).toISOString(),
      threadId: null,
      payload: null,
    },
    {
      id: 'demo-msg-3',
      sequence: 3,
      msgType: 'question',
      fromHandle: 'orca_session_id:demo-chat-cloud-ops',
      toHandle: 'orca:items',
      runId: null,
      subject: 'Need confirmation on canary traffic weight',
      body: 'Should canary rollout start at 10% or 25%?',
      createdAt: new Date(nowMs - 90_000).toISOString(),
      threadId: null,
      payload: null,
    },
    {
      id: 'demo-msg-4',
      sequence: 4,
      msgType: 'worker_done',
      fromHandle: 'dispatch:demo-w-3',
      toHandle: 'orca_session_id:demo-chat-infra-ops',
      runId: 'demo-run-3',
      subject: 'Terraform plan validated (0 destructive changes)',
      body: 'All staging checks passed; ready for rollout.',
      createdAt: new Date(nowMs - 30_000).toISOString(),
      threadId: null,
      payload: null,
    },
  ];
  snap.inboxCursor = {
    lastSequence: 4,
    seenIds: [],
    needsBackfill: false,
  };

  return snap;
}

function buildInitialDemoHistory(
  currentSnap: WorldSnapshot,
  nowMs: number
): { events: WorldEventRecord[]; keyframes: Keyframe[] } {
  const tMinus120m = nowMs - 120 * 60_000;
  const tMinus80m = nowMs - 80 * 60_000;
  const tMinus40m = nowMs - 40 * 60_000;

  const snap1 = clonePlain(currentSnap);
  snap1.capturedAt = tMinus120m;
  snap1.bots['demo-security'].status = { kind: 'Working', tool: 'read_file' };
  snap1.bots['demo-security'].needsYouCount = 0;
  snap1.bots['demo-security'].currentTaskTitle = 'Audit staging OAuth token TTL';
  snap1.bots['demo-security'].currentTool = 'read_file';
  snap1.bots['demo-cloud-ops'].status = { kind: 'Idle' };
  snap1.bots['demo-cloud-ops'].currentTaskTitle = null;
  snap1.bots['demo-cost-guard'].status = { kind: 'Working', tool: 'search_web' };
  snap1.bots['demo-cost-guard'].currentTaskTitle = 'Daily cloud spend variance check';
  snap1.bots['demo-cost-guard'].currentTool = 'search_web';
  snap1.items['demo-item-14'].status = 'in_progress';

  const snap2 = clonePlain(currentSnap);
  snap2.capturedAt = tMinus80m;
  snap2.bots['demo-security'].status = { kind: 'Working', tool: 'edit_file' };
  snap2.bots['demo-security'].needsYouCount = 0;
  snap2.bots['demo-security'].currentTool = 'edit_file';
  snap2.bots['demo-doc-review'].status = { kind: 'Working', tool: 'write_file' };
  snap2.bots['demo-doc-review'].currentTaskTitle = 'Draft release notes summary';
  snap2.bots['demo-doc-review'].currentTool = 'write_file';
  snap2.items['demo-item-14'].status = 'in_progress';

  const snap3 = clonePlain(currentSnap);
  snap3.capturedAt = tMinus40m;
  snap3.bots['demo-cloud-ops'].status = { kind: 'Working', tool: 'run_command' };
  snap3.bots['demo-cloud-ops'].currentTaskTitle = 'Verify canary latency SLOs';
  snap3.bots['demo-cloud-ops'].currentTool = 'run_command';

  const snap4 = clonePlain(currentSnap);
  snap4.capturedAt = nowMs;

  const rawEvents: Array<{ ts: number; ev: WorldEvent; seq?: number }> = [
    {
      ts: tMinus120m + 5_000,
      ev: { kind: 'BotWorking', botId: 'demo-cost-guard', botName: 'Cost Guard', tool: 'search_web' },
    },
    {
      ts: tMinus120m + 180_000,
      ev: {
        kind: 'AutomationRun',
        automationId: 'demo-auto-2',
        automationName: 'Daily Cloud Spend Digest',
        botId: 'demo-cost-guard',
        botName: 'Cost Guard',
        success: true,
        noReply: false,
        error: null,
      },
    },
    {
      ts: tMinus120m + 420_000,
      ev: {
        kind: 'AutomationRun',
        automationId: 'demo-auto-1',
        automationName: 'Hourly Dependency Advisory Check',
        botId: 'demo-security',
        botName: 'Security',
        success: true,
        noReply: true,
        error: null,
      },
    },
    {
      ts: tMinus80m + 15_000,
      ev: {
        kind: 'WorkerStart',
        dispatchId: 'demo-w-1',
        parentBotId: 'demo-ops-lead',
        parentBotName: 'Ops Lead',
        provider: 'claude',
        taskTitle: 'Collect test coverage summary',
      },
      seq: 1,
    },
    {
      ts: tMinus80m + 45_000,
      ev: {
        kind: 'StatusReport',
        messageId: 'demo-msg-init-1',
        from: { kind: 'Bot', botId: 'demo-dev-tools', botName: 'Dev Tools' },
        to: { kind: 'Bot', botId: 'demo-ops-lead', botName: 'Ops Lead' },
        subject: 'Refine plugin CLI validation rules',
      },
    },
    {
      ts: tMinus80m + 90_000,
      ev: { kind: 'ToolChanged', botId: 'demo-dev-tools', botName: 'Dev Tools', tool: 'edit_file' },
    },
    {
      ts: tMinus80m + 240_000,
      ev: {
        kind: 'Handoff',
        messageId: 'demo-msg-init-2',
        from: { kind: 'Bot', botId: 'demo-infra-ops', botName: 'Infra Ops' },
        to: { kind: 'Bot', botId: 'demo-cloud-ops', botName: 'Cloud Ops' },
        subject: 'Deploy preview manifest ready',
      },
    },
    {
      ts: tMinus40m + 20_000,
      ev: {
        kind: 'Handoff',
        messageId: 'demo-msg-1',
        from: { kind: 'Bot', botId: 'demo-ops-lead', botName: 'Ops Lead' },
        to: { kind: 'Bot', botId: 'demo-security', botName: 'Security' },
        subject: 'Review staging IAM role diff',
      },
    },
    {
      ts: tMinus40m + 120_000,
      ev: {
        kind: 'Question',
        messageId: 'demo-msg-init-3',
        from: { kind: 'Bot', botId: 'demo-cloud-ops', botName: 'Cloud Ops' },
        to: { kind: 'Bot', botId: 'demo-security', botName: 'Security' },
        subject: 'Verify rollout readiness with Security',
      },
    },
    {
      ts: tMinus40m + 180_000,
      ev: {
        kind: 'Reply',
        messageId: 'demo-msg-2',
        from: { kind: 'Bot', botId: 'demo-security', botName: 'Security' },
        to: { kind: 'Bot', botId: 'demo-ops-lead', botName: 'Ops Lead' },
        subject: 'Re: Review staging IAM role diff',
      },
    },
    {
      ts: nowMs - 180_000,
      ev: {
        kind: 'Handoff',
        messageId: 'demo-msg-init-4',
        from: { kind: 'Bot', botId: 'demo-ops-lead', botName: 'Ops Lead' },
        to: { kind: 'Bot', botId: 'demo-doc-review', botName: 'Doc Review' },
        subject: 'Draft release notes summary',
      },
    },
    {
      ts: nowMs - 120_000,
      ev: { kind: 'BotIdle', botId: 'demo-cost-guard', botName: 'Cost Guard' },
    },
    {
      ts: nowMs - 14_000,
      ev: {
        kind: 'ItemNeedsYou',
        itemUid: 'demo-item-14',
        number: 14,
        botId: 'demo-security',
        botName: 'Security',
        title: 'Staging IAM policy least-privilege check',
        optionsCount: 2,
      },
    },
  ];

  const events = rawEvents.map((item) => createEventRecord(item.ev, item.ts, item.seq ?? 1, 'en'));
  const keyframes: Keyframe[] = [
    { timestampMs: tMinus120m, snapshot: snap1 },
    { timestampMs: tMinus80m, snapshot: snap2 },
    { timestampMs: tMinus40m, snapshot: snap3 },
    { timestampMs: nowMs, snapshot: snap4 },
  ];

  return { events, keyframes };
}

export class DemoOfficeSession {
  private snapshot: WorldSnapshot;
  private events: WorldEventRecord[];
  private keyframes: Keyframe[];
  private stepIndex = 0;
  private msgSeq = 5;
  private workerSeqCounter = 5;
  private lastTickMs: number;
  private readonly explicitClock: boolean;

  constructor(nowMs?: number) {
    this.explicitClock = typeof nowMs === 'number' && Number.isFinite(nowMs);
    const baseMs = this.explicitClock ? (nowMs as number) : Date.now();
    this.lastTickMs = baseMs;
    this.snapshot = buildInitialDemoSnapshot(baseMs);
    const history = buildInitialDemoHistory(this.snapshot, baseMs);
    this.events = history.events;
    this.keyframes = history.keyframes;
  }

  private pushEvent(ev: WorldEvent, ts: number, workerSeqHint = 1): void {
    const rec = createEventRecord(ev, ts, workerSeqHint, 'en');
    this.events.push(rec);
    if (this.events.length > MAX_DEMO_EVENTS) {
      this.events.splice(0, this.events.length - MAX_DEMO_EVENTS);
    }
  }

  private pushMessage(msg: Omit<InboxMessage, 'sequence'>): void {
    const seq = this.msgSeq++;
    this.snapshot.recentMessages.push({ ...msg, sequence: seq });
    this.snapshot.inboxCursor.lastSequence = seq;
    if (this.snapshot.recentMessages.length > MAX_DEMO_MESSAGES) {
      this.snapshot.recentMessages.splice(
        0,
        this.snapshot.recentMessages.length - MAX_DEMO_MESSAGES
      );
    }
  }

  tick(nowMs?: number): WorldEvent[] {
    const ts =
      typeof nowMs === 'number' && Number.isFinite(nowMs)
        ? nowMs
        : this.explicitClock
          ? this.lastTickMs + 2_600
          : Math.max(Date.now(), this.lastTickMs + 2_600);
    this.lastTickMs = ts;
    this.snapshot.capturedAt = ts;

    const generated: WorldEvent[] = [];
    const phase = this.stepIndex % 8;
    this.stepIndex++;

    switch (phase) {
      case 0: {
        // Handoff Ops Lead -> Security + Ops Lead tool swap
        const opsLead = this.snapshot.bots['demo-ops-lead'];
        opsLead.status = { kind: 'Working', tool: 'read_file' };
        opsLead.currentTool = 'read_file';
        opsLead.lastActivityAt = ts;
        const msgId = `demo-msg-${this.msgSeq}`;
        this.pushMessage({
          id: msgId,
          msgType: 'handoff',
          fromHandle: 'orca_session_id:demo-chat-ops-lead',
          toHandle: 'orca_session_id:demo-chat-security',
          runId: null,
          subject: 'Review staging IAM role diff',
          body: 'Can you verify the least-privilege diff on the staging role?',
          createdAt: new Date(ts).toISOString(),
          threadId: null,
          payload: null,
        });
        const ev: WorldEvent = {
          kind: 'Handoff',
          messageId: msgId,
          from: { kind: 'Bot', botId: 'demo-ops-lead', botName: 'Ops Lead' },
          to: { kind: 'Bot', botId: 'demo-security', botName: 'Security' },
          subject: 'Review staging IAM role diff',
        };
        this.pushEvent(ev, ts);
        generated.push(ev);
        break;
      }
      case 1: {
        // WorkerStart under Infra Ops (rotate out previous ephemeral worker to keep 4 live workers)
        delete this.snapshot.workers['demo-w-ephemeral'];
        const seq = this.workerSeqCounter++;
        const dispatchId = `demo-w-ephemeral`;
        this.snapshot.workers[dispatchId] = {
          dispatchId,
          taskId: `demo-wt-${seq}`,
          runId: `demo-run-${seq}`,
          parentBotId: 'demo-infra-ops',
          parentBotName: 'Infra Ops',
          provider: 'codex',
          model: 'gpt-5',
          workerState: 'ready',
          dispatchStatus: 'dispatched',
          terminalState: 'attached',
          terminalHandle: `term_demo_${seq}`,
          worktreeId: `demo-wt-${seq}`,
          liveness: 'Live',
          activity: 'working',
          toolName: 'run_command',
          taskTitle: 'Validate Terraform plan',
          updatedAt: ts,
        };
        const infra = this.snapshot.bots['demo-infra-ops'];
        infra.activeWorkerCount = 2;
        infra.lastActivityAt = ts;
        const ev: WorldEvent = {
          kind: 'WorkerStart',
          dispatchId,
          parentBotId: 'demo-infra-ops',
          parentBotName: 'Infra Ops',
          provider: 'codex',
          taskTitle: 'Validate Terraform plan',
        };
        this.pushEvent(ev, ts, seq);
        generated.push(ev);
        break;
      }
      case 2: {
        // ToolChanged on Dev Tools + BotWorking on Cost Guard
        const devTools = this.snapshot.bots['demo-dev-tools'];
        const nextTool = devTools.currentTool === 'edit_file' ? 'run_command' : 'edit_file';
        devTools.status = { kind: 'Working', tool: nextTool };
        devTools.currentTool = nextTool;
        devTools.lastActivityAt = ts;
        const evTool: WorldEvent = {
          kind: 'ToolChanged',
          botId: 'demo-dev-tools',
          botName: 'Dev Tools',
          tool: nextTool,
        };
        this.pushEvent(evTool, ts);
        generated.push(evTool);

        const cost = this.snapshot.bots['demo-cost-guard'];
        cost.status = { kind: 'Working', tool: 'search_web' };
        cost.currentTool = 'search_web';
        cost.currentTaskTitle = 'Daily cloud spend variance check';
        cost.lastActivityAt = ts;
        const evWork: WorldEvent = {
          kind: 'BotWorking',
          botId: 'demo-cost-guard',
          botName: 'Cost Guard',
          tool: 'search_web',
        };
        this.pushEvent(evWork, ts + 1);
        generated.push(evWork);
        break;
      }
      case 3: {
        // ItemNeedsYou on Security
        const sec = this.snapshot.bots['demo-security'];
        sec.status = {
          kind: 'NeedsOwner',
          count: 1,
          prompt: 'Approve staging IAM role policy update?',
          optionsCount: 2,
        };
        sec.currentTool = null;
        sec.needsYouCount = 1;
        sec.lastActivityAt = ts;
        this.snapshot.items['demo-item-14'].status = 'needs_you';
        this.snapshot.items['demo-item-14'].updatedAt = ts;
        const ev: WorldEvent = {
          kind: 'ItemNeedsYou',
          itemUid: 'demo-item-14',
          number: 14,
          botId: 'demo-security',
          botName: 'Security',
          title: 'Staging IAM policy least-privilege check',
          optionsCount: 2,
        };
        this.pushEvent(ev, ts);
        generated.push(ev);
        break;
      }
      case 4: {
        // AutomationRun on Doc Review + Doc Review Working
        const auto = this.snapshot.automations['demo-auto-4'];
        auto.lastRunAt = ts;
        auto.lastRunStatus = 'completed';
        auto.lastRunNoReply = false;
        const doc = this.snapshot.bots['demo-doc-review'];
        doc.status = { kind: 'Working', tool: 'write_file' };
        doc.currentTool = 'write_file';
        doc.currentTaskTitle = 'Update onboarding guide for Demo Office';
        doc.lastActivityAt = ts;
        const evAuto: WorldEvent = {
          kind: 'AutomationRun',
          automationId: auto.id,
          automationName: auto.name,
          botId: 'demo-doc-review',
          botName: 'Doc Review',
          success: true,
          noReply: false,
          error: null,
        };
        this.pushEvent(evAuto, ts);
        generated.push(evAuto);
        break;
      }
      case 5: {
        // Reply from Security -> Ops Lead + Bot World tool switch
        const msgId = `demo-msg-${this.msgSeq}`;
        this.pushMessage({
          id: msgId,
          msgType: 'status',
          fromHandle: 'orca_session_id:demo-chat-security',
          toHandle: 'orca_session_id:demo-chat-ops-lead',
          runId: null,
          subject: 'Re: Review staging IAM role diff',
          body: 'Verified: policy scope looks clean after S3 prefix narrowing.',
          createdAt: new Date(ts).toISOString(),
          threadId: null,
          payload: null,
        });
        const evReply: WorldEvent = {
          kind: 'Reply',
          messageId: msgId,
          from: { kind: 'Bot', botId: 'demo-security', botName: 'Security' },
          to: { kind: 'Bot', botId: 'demo-ops-lead', botName: 'Ops Lead' },
          subject: 'Re: Review staging IAM role diff',
        };
        this.pushEvent(evReply, ts);
        generated.push(evReply);

        const bw = this.snapshot.bots['demo-bot-world'];
        const nextBwTool = bw.currentTool === 'call_mcp_tool' ? 'edit_file' : 'call_mcp_tool';
        bw.status = { kind: 'Working', tool: nextBwTool };
        bw.currentTool = nextBwTool;
        bw.lastActivityAt = ts;
        const evTool: WorldEvent = {
          kind: 'ToolChanged',
          botId: 'demo-bot-world',
          botName: 'Bot World',
          tool: nextBwTool,
        };
        this.pushEvent(evTool, ts + 1);
        generated.push(evTool);
        break;
      }
      case 6: {
        // BotIdle on Cost Guard + Cloud Ops resumes Working
        const cost = this.snapshot.bots['demo-cost-guard'];
        cost.status = { kind: 'Idle' };
        cost.currentTool = null;
        cost.currentTaskTitle = null;
        cost.lastActivityAt = ts;
        const evIdle: WorldEvent = {
          kind: 'BotIdle',
          botId: 'demo-cost-guard',
          botName: 'Cost Guard',
        };
        this.pushEvent(evIdle, ts);
        generated.push(evIdle);

        const cloud = this.snapshot.bots['demo-cloud-ops'];
        cloud.status = { kind: 'Working', tool: 'run_command' };
        cloud.currentTool = 'run_command';
        cloud.currentTaskTitle = 'Verify canary latency SLOs';
        cloud.lastActivityAt = ts;
        const evWork: WorldEvent = {
          kind: 'BotWorking',
          botId: 'demo-cloud-ops',
          botName: 'Cloud Ops',
          tool: 'run_command',
        };
        this.pushEvent(evWork, ts + 1);
        generated.push(evWork);
        break;
      }
      case 7:
      default: {
        // Handoff Infra Ops -> Cloud Ops; settle ephemeral worker & Doc Review to Idle
        delete this.snapshot.workers['demo-w-ephemeral'];
        this.snapshot.bots['demo-infra-ops'].activeWorkerCount = 1;

        const doc = this.snapshot.bots['demo-doc-review'];
        doc.status = { kind: 'Idle' };
        doc.currentTool = null;
        doc.currentTaskTitle = null;

        const cloud = this.snapshot.bots['demo-cloud-ops'];
        cloud.status = { kind: 'WaitingAnswer' };
        cloud.currentTool = null;
        cloud.currentTaskTitle = 'Verify rollout readiness with Security';
        cloud.lastActivityAt = ts;

        const sec = this.snapshot.bots['demo-security'];
        sec.status = { kind: 'Working', tool: 'read_file' };
        sec.currentTool = 'read_file';
        sec.needsYouCount = 0;
        sec.lastActivityAt = ts;
        this.snapshot.items['demo-item-14'].status = 'in_progress';

        const msgId = `demo-msg-${this.msgSeq}`;
        this.pushMessage({
          id: msgId,
          msgType: 'handoff',
          fromHandle: 'orca_session_id:demo-chat-infra-ops',
          toHandle: 'orca_session_id:demo-chat-cloud-ops',
          runId: null,
          subject: 'Deploy preview manifest ready',
          body: 'All staging checks passed; ready for rollout.',
          createdAt: new Date(ts).toISOString(),
          threadId: null,
          payload: null,
        });
        const evHandoff: WorldEvent = {
          kind: 'Handoff',
          messageId: msgId,
          from: { kind: 'Bot', botId: 'demo-infra-ops', botName: 'Infra Ops' },
          to: { kind: 'Bot', botId: 'demo-cloud-ops', botName: 'Cloud Ops' },
          subject: 'Deploy preview manifest ready',
        };
        this.pushEvent(evHandoff, ts);
        generated.push(evHandoff);
        break;
      }
    }

    if (this.stepIndex % 2 === 0) {
      this.keyframes.push({ timestampMs: ts, snapshot: clonePlain(this.snapshot) });
      if (this.keyframes.length > MAX_DEMO_KEYFRAMES) {
        this.keyframes.splice(0, this.keyframes.length - MAX_DEMO_KEYFRAMES);
      }
    }

    return generated;
  }

  getPayload(opts: {
    themeId: ThemeId;
    atmosphereMode?: AtmosphereMode;
    redactMode: boolean;
    locale: UiLocale;
    languageSetting: LanguageSetting;
    botAppearances: Record<string, CharacterId>;
  }): BotWorldStatePayload {
    const {
      themeId,
      atmosphereMode = 'auto',
      redactMode,
      locale,
      languageSetting,
      botAppearances,
    } = opts;
    const s = tStrings(locale);
    const snapshot = formatDemoSnapshot(this.snapshot, redactMode, locale);

    const workerSeqMap = new Map<string, number>();
    let nextWorkerSeq = 1;
    const workerLabelFor = (dispatchId: string): string => {
      let seq = workerSeqMap.get(dispatchId);
      if (seq === undefined) {
        seq = nextWorkerSeq++;
        workerSeqMap.set(dispatchId, seq);
      }
      return s.workerNumbered(seq);
    };

    const events: WorldEventRecord[] = this.events.map((rec) => {
      const seqHint = rec.workerSeq ?? 1;
      const localizedEv = scrubWorldEvent(localizeWorldEvent(rec.event, locale));
      if (redactMode) {
        const redactedEv = redactWorldEvent(
          localizedEv,
          (dispatchId) => {
            if (localizedEv.kind === 'WorkerStart' && dispatchId === localizedEv.dispatchId) {
              workerSeqMap.set(dispatchId, seqHint);
              return s.workerNumbered(seqHint);
            }
            return workerLabelFor(dispatchId);
          },
          locale
        );
        const [, redactedSummary] = formatEventSummaries(redactedEv, seqHint, locale);
        return {
          timestampMs: rec.timestampMs,
          summary: scrubAll(redactedSummary),
          redactedSummary: scrubAll(redactedSummary),
          event: redactedEv,
          ...(rec.workerSeq !== undefined ? { workerSeq: rec.workerSeq } : {}),
        };
      }
      const [summary, redactedSummary] = formatEventSummaries(localizedEv, seqHint, locale);
      return {
        timestampMs: rec.timestampMs,
        summary: scrubAll(summary),
        redactedSummary: scrubAll(redactedSummary),
        event: localizedEv,
        ...(rec.workerSeq !== undefined ? { workerSeq: rec.workerSeq } : {}),
      };
    });

    const keyframes: Keyframe[] = this.keyframes.map((kf) => ({
      timestampMs: kf.timestampMs,
      snapshot: formatDemoSnapshot(kf.snapshot, redactMode, locale),
    }));

    const safeAppearances: Record<string, CharacterId> = {};
    for (const [k, v] of Object.entries(botAppearances)) {
      if (isSafeKey(k)) {
        Object.defineProperty(safeAppearances, k, {
          value: v,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }

    return {
      snapshot,
      events,
      keyframes,
      activeTheme: themeId,
      atmosphereMode,
      redactMode,
      botAppearances: safeAppearances,
      pollIntervalSec: 5,
      locale,
      languageSetting,
    };
  }
}

export function createDemoOfficeSession(nowMs?: number): DemoOfficeSession {
  return new DemoOfficeSession(nowMs);
}
