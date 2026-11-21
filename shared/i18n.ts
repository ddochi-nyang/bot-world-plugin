import {
  type CharacterId,
  type LanguageSetting,
  type ThemeId,
  type UiLocale,
  isValidLanguageSetting,
} from '../src/types.ts';

export type { LanguageSetting, UiLocale } from '../src/types.ts';

export function resolveUiLocale(rawLocale?: string | null): UiLocale {
  if (typeof rawLocale !== 'string') return 'en';
  const normalized = rawLocale.trim().toLowerCase();
  if (normalized === 'ko' || normalized.startsWith('ko-') || normalized.startsWith('ko_')) {
    return 'ko';
  }
  return 'en';
}

export function getHostLocale(): string {
  if (typeof orca !== 'undefined' && typeof orca.locale === 'string' && orca.locale.trim().length > 0) {
    return orca.locale.trim();
  }
  if (typeof navigator !== 'undefined' && typeof navigator.language === 'string' && navigator.language.trim().length > 0) {
    return navigator.language.trim();
  }
  return 'en';
}

export function pickLocale<T>(byLocale: Readonly<Record<UiLocale, T>>, locale: UiLocale = 'en'): T {
  return locale === 'ko' ? byLocale.ko : byLocale.en;
}

export function normalizeLanguageSetting(value: unknown): LanguageSetting {
  return isValidLanguageSetting(value) ? value : 'auto';
}

export function effectiveLocale(
  setting: LanguageSetting,
  hostLocale?: string | null
): UiLocale {
  if (setting === 'en') return 'en';
  if (setting === 'ko') return 'ko';
  return resolveUiLocale(hostLocale);
}

export function formatTimeHms(epochMs: number, locale: UiLocale = 'en'): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) {
    return '--:--:--';
  }
  if (locale === 'ko') {
    const totalSecs = Math.floor(epochMs / 1000);
    const kstSecs = ((totalSecs + 9 * 3600) % 86_400 + 86_400) % 86_400;
    const h = Math.floor(kstSecs / 3600);
    const m = Math.floor((kstSecs % 3600) / 60);
    const s = kstSecs % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  try {
    const formatted = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(epochMs));
    if (/^\d{2}:\d{2}:\d{2}$/.test(formatted)) {
      return formatted;
    }
  } catch {
    // Fallback below
  }
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export type CharacterTextSpec = {
  displayName: string;
  shortName: string;
  roleHint: string;
};

export const CHARACTER_TEXTS: Readonly<Record<UiLocale, Readonly<Record<CharacterId, CharacterTextSpec>>>> =
  Object.freeze({
    en: Object.freeze({
      ddochi: { displayName: 'Ddochi', shortName: 'Ddochi', roleHint: 'Coordinator' },
      security: {
        displayName: 'Security',
        shortName: 'Security',
        roleHint: 'Auth · Security · Patch',
      },
      iac: { displayName: 'IaC', shortName: 'IaC', roleHint: 'Infra Code · Refactor' },
      cloud_ops: {
        displayName: 'Cloud Ops',
        shortName: 'Cloud Ops',
        roleHint: 'Clusters · Deploy · Observability',
      },
      cost: { displayName: 'Cost', shortName: 'Cost', roleHint: 'Cloud Cost · Optimization' },
      internal_tools: {
        displayName: 'Internal Tools',
        shortName: 'Internal Tools',
        roleHint: 'Internal Tools · Automation',
      },
      personal_assist: {
        displayName: 'Personal Assist',
        shortName: 'Personal Assist',
        roleHint: 'Dev Env · Knowledge',
      },
      cve: { displayName: 'CVE', shortName: 'CVE', roleHint: 'Vulnerability Exposure' },
      doc_review: {
        displayName: 'Doc Review',
        shortName: 'Doc Review',
        roleHint: 'Design & Doc Review',
      },
      bot_world: {
        displayName: 'Bot World',
        shortName: 'Bot World',
        roleHint: 'Bot World Monitor',
      },
      worker_helper: { displayName: 'Worker', shortName: 'Worker', roleHint: 'Sub-Worker' },
    }),
    ko: Object.freeze({
      ddochi: { displayName: '또치 캐릭터', shortName: '또치', roleHint: '전체 조율' },
      security: { displayName: '보안 캐릭터', shortName: '보안', roleHint: '인증·보안·패치' },
      iac: { displayName: 'IaC 캐릭터', shortName: 'IaC', roleHint: '인프라 코드·재편' },
      cloud_ops: {
        displayName: '클라우드 운영 캐릭터',
        shortName: '클라우드 운영',
        roleHint: '클러스터·배포·관측',
      },
      cost: { displayName: '비용 캐릭터', shortName: '비용', roleHint: '클라우드 비용·절감' },
      internal_tools: {
        displayName: '사내 도구 캐릭터',
        shortName: '사내 도구',
        roleHint: '사내 도구·자동화',
      },
      personal_assist: {
        displayName: '업무 보조 캐릭터',
        shortName: '업무 보조',
        roleHint: '개발환경·지식 정리',
      },
      cve: {
        displayName: 'CVE 캐릭터',
        shortName: 'CVE',
        roleHint: '취약점 노출·영향 분석',
      },
      doc_review: {
        displayName: '문서 리뷰 캐릭터',
        shortName: '문서 리뷰',
        roleHint: '설계·문서 사전 검토',
      },
      bot_world: {
        displayName: '봇 월드 캐릭터',
        shortName: '봇 월드',
        roleHint: '가상 사무실 앱 개발',
      },
      worker_helper: { displayName: '워커 도우미', shortName: '도우미', roleHint: '하위 작업 도우미' },
    }),
  });

export type LandmarkKind = 'bossDesk' | 'officeDoor' | 'automationBoard';

export type UiDictionary = {
  appTitlePanel: string;
  appTitleEditor: string;
  themeAriaLabel: string;
  themeShort: Record<ThemeId, string>;
  themeFull: Record<ThemeId, string>;
  landmarks: Record<LandmarkKind, string>;
  redactOn: string;
  redactOff: string;
  refresh: string;
  langToggleText: string;
  langToggleTitle: string;
  connecting: string;
  offline: string;
  connectedBots: (count: number) => string;
  offlineRetry: (secs: number) => string;
  boardHint: string;
  tabDetail: string;
  tabTimeline: string;
  backToLive: string;
  docSynced: string;
  docReadOnly: string;
  live: string;
  replay: string;
  play: string;
  pause: string;
  speedAriaLabel: string;
  scrubberAriaLabel: string;
  eventLog: string;
  stageOverlayLive: string;
  stageOverlayOffline: string;
  stageOverlayHover: (botName: string) => string;
  stageOverlayReplay: (hms: string) => string;
  badgeWorking: string;
  badgeIdle: string;
  badgeWaiting: string;
  badgeBlocked: string;
  badgeNeedsYou: (optionsCount: number) => string;
  badgeError: string;
  badgePaused: string;
  calloutNeedsOwner: (count: number) => string;
  privateLabel: string;
  errorHiddenLabel: string;
  interruptedLabel: string;
  automationDispatchFailedLabel: string;
  workerGeneric: string;
  workerNumbered: (seq: number) => string;
  workerWithProvider: (provider: string) => string;
  botGeneric: string;
  ownerActor: string;
  unknownActor: string;
  automationGeneric: string;
  automationNumbered: (idx: number) => string;
  selectBotTitle: string;
  selectBotDescWithBots: string;
  selectBotDescEmpty: string;
  avatarAlt: (name: string) => string;
  redactSpecialtyHidden: string;
  closeDetailAria: string;
  sectionActiveTask: string;
  needsDecisionPrefix: (prompt: string) => string;
  noActiveTask: string;
  usingToolPrefix: (tool: string) => string;
  sectionSwitchCharacter: string;
  sectionRecentMessages: string;
  noRecentMessages: string;
  msgTypeLabels: Record<string, string>;
  msgTypeDefault: string;
  msgTypeFallback: (typeLabel: string) => string;
  msgRedactedSummary: (botName: string, typeLabel: string) => string;
  sectionOpenItems: string;
  noOpenItems: string;
  itemStatusLabels: Record<string, string>;
  sectionWorkers: string;
  noWorkers: string;
  livenessLabels: Record<'Live' | 'Exited' | 'Unverifiable', string>;
  workerStateLabels: Record<string, string>;
  workerRedactedDetail: (botName: string, stateLabel: string) => string;
  noTaskDetails: string;
  sectionAutomations: string;
  noAutomations: string;
  autoCompletedNoReply: string;
  autoCompleted: string;
  autoFailed: string;
  autoIdle: string;
  autoDisabled: string;
  noEventsRecorded: string;
  recordedEventFallback: string;
  cmdOpenResult: (botCount: number) => string;
  cmdRefreshResult: (botCount: number) => string;
  statusBarOfflineRedacted: string;
  statusBarOffline: string;
  statusBarOfflineTooltipRedacted: string;
  statusBarOfflineTooltip: string;
  statusBarBrand: string;
  statusBarRedactedTag: string;
};

export const UI_STRINGS: Readonly<Record<UiLocale, UiDictionary>> = {
  en: {
    appTitlePanel: 'Bot World',
    appTitleEditor: 'Bot World Office',
    themeAriaLabel: 'Office Theme',
    themeShort: {
      startup_office: 'Startup',
      corporate_office: 'Corporate',
    },
    themeFull: {
      startup_office: 'Startup Office',
      corporate_office: 'Corporate Office',
    },
    landmarks: {
      bossDesk: 'Owner Desk',
      officeDoor: 'Entrance',
      automationBoard: 'Automation Board',
    },
    redactOn: 'Redact ON',
    redactOff: 'Redact OFF',
    refresh: 'Refresh',
    langToggleText: 'EN',
    langToggleTitle: 'Switch language (EN / 한국어)',
    connecting: 'Connecting',
    offline: 'Offline',
    connectedBots: (count) => `Connected · ${count} ${count === 1 ? 'bot' : 'bots'}`,
    offlineRetry: (secs) => `Offline (${secs}s)`,
    boardHint:
      'Open New File → New Bot World Board (.botworld) for the wide office view and 24h timeline scrubber.',
    tabDetail: 'Bot Details',
    tabTimeline: 'Event Timeline',
    backToLive: 'Back to LIVE',
    docSynced: '.botworld synced',
    docReadOnly: 'Read-only board',
    live: 'LIVE',
    replay: 'REPLAY',
    play: '▶ Play',
    pause: '❚❚ Pause',
    speedAriaLabel: 'Playback speed',
    scrubberAriaLabel: '24-hour timeline scrubber',
    eventLog: 'Event Log',
    stageOverlayLive: 'LIVE · Click a bot',
    stageOverlayOffline: 'Waiting offline',
    stageOverlayHover: (botName) => `${botName} · Click for details`,
    stageOverlayReplay: (hms) => `REPLAY · ${hms}`,
    badgeWorking: '▶ Working',
    badgeIdle: '● Idle',
    badgeWaiting: '… Waiting',
    badgeBlocked: '■ Blocked',
    badgeNeedsYou: (optionsCount) => (optionsCount > 0 ? `★ Needs You (${optionsCount})` : '★ Needs You'),
    badgeError: '! Error',
    badgePaused: 'Zzz Paused',
    calloutNeedsOwner: (count) =>
      count > 1 ? `▲ Needs You (${count}) · Owner` : '▲ Needs You · Owner',
    privateLabel: 'Private',
    errorHiddenLabel: 'Error details hidden',
    interruptedLabel: 'Interrupted',
    automationDispatchFailedLabel: 'Automation failed',
    workerGeneric: 'Worker',
    workerNumbered: (seq) => `Worker #${seq}`,
    workerWithProvider: (provider) => `Worker(${provider})`,
    botGeneric: 'Bot',
    ownerActor: 'Owner',
    unknownActor: 'Unknown',
    automationGeneric: 'Automation',
    automationNumbered: (idx) => `Automation #${idx}`,
    selectBotTitle: 'Select a bot',
    selectBotDescWithBots:
      'Click a bot on the office canvas to inspect active tasks, recent requests/replies, open items, sub-workers, and switch among 10 character avatars.',
    selectBotDescEmpty:
      'No bots to display yet. Bots will appear in the office once the Orca runtime connects.',
    avatarAlt: (name) => `${name} character`,
    redactSpecialtyHidden: 'Redact mode active: specialty hidden',
    closeDetailAria: 'Close details',
    sectionActiveTask: 'Active Task (Read-Only)',
    needsDecisionPrefix: (prompt) => `Needs decision: ${prompt}`,
    noActiveTask: 'No active task',
    usingToolPrefix: (tool) => `Tool: ${tool}`,
    sectionSwitchCharacter: 'Switch Character (10)',
    sectionRecentMessages: 'Recent Requests / Replies',
    noRecentMessages: 'No recent requests or replies',
    msgTypeLabels: {
      handoff: 'Handoff',
      question: 'Question',
      worker_done: 'Done',
      escalation: 'Escalation',
      approval_closed: 'Approval',
      status: 'Report/Reply',
    },
    msgTypeDefault: 'Message',
    msgTypeFallback: (typeLabel) => `${typeLabel} message`,
    msgRedactedSummary: (botName, typeLabel) => `${botName} · Private ${typeLabel}`,
    sectionOpenItems: 'Open Items',
    noOpenItems: 'No open items',
    itemStatusLabels: {
      needs_you: 'Needs You',
      in_progress: 'In Progress',
      planned: 'Planned',
      done: 'Done',
      canceled: 'Canceled',
    },
    sectionWorkers: 'Sub-Workers',
    noWorkers: 'No sub-workers',
    livenessLabels: {
      Live: 'Live',
      Exited: 'Exited',
      Unverifiable: 'Unverifiable',
    },
    workerStateLabels: {
      working: 'Working',
      idle: 'Idle',
      blocked: 'Blocked',
      waiting: 'Waiting',
      done: 'Done',
      succeeded: 'Done',
      failed: 'Failed',
      canceled: 'Canceled',
      exited: 'Exited',
      released: 'Released',
    },
    workerRedactedDetail: (botName, stateLabel) => `${botName} · [Private Task] · ${stateLabel}`,
    noTaskDetails: 'No task details',
    sectionAutomations: 'Automations',
    noAutomations: 'No linked automations',
    autoCompletedNoReply: 'Done (No Reply)',
    autoCompleted: 'Done',
    autoFailed: 'Failed',
    autoIdle: 'Idle',
    autoDisabled: 'Disabled',
    noEventsRecorded: 'No events recorded yet.',
    recordedEventFallback: 'Recorded event',
    cmdOpenResult: (botCount) => `Bot World active (${botCount} ${botCount === 1 ? 'bot' : 'bots'})`,
    cmdRefreshResult: (botCount) =>
      `Bot World refreshed (${botCount} ${botCount === 1 ? 'bot' : 'bots'})`,
    statusBarOfflineRedacted: 'Bot World · Redacted · Offline',
    statusBarOffline: 'Bot World (Offline)',
    statusBarOfflineTooltipRedacted: 'Redact mode active · Offline',
    statusBarOfflineTooltip: 'Waiting for Orca runtime connection',
    statusBarBrand: 'Bot World',
    statusBarRedactedTag: 'Redacted',
  },
  ko: {
    appTitlePanel: '봇 월드',
    appTitleEditor: '봇 월드 사무실',
    themeAriaLabel: '사무실 테마',
    themeShort: {
      startup_office: '스타트업',
      corporate_office: '대기업',
    },
    themeFull: {
      startup_office: '스타트업 사무실',
      corporate_office: '대기업 사무실',
    },
    landmarks: {
      bossDesk: '사장님 책상',
      officeDoor: '출입구',
      automationBoard: '자동화 보드',
    },
    redactOn: '가림 ON',
    redactOff: '가림 OFF',
    refresh: '새로고침',
    langToggleText: '한',
    langToggleTitle: '언어 전환 (EN / 한국어)',
    connecting: '연결 중',
    offline: '오프라인',
    connectedBots: (count) => `연결됨 · ${count}봇`,
    offlineRetry: (secs) => `오프라인 (${secs}s)`,
    boardHint: '넓은 전체 사무실 · 24h 스크러버는 새 파일 → 새 봇 월드 보드(.botworld)로 여세요.',
    tabDetail: '봇 상세',
    tabTimeline: '사건 타임라인',
    backToLive: 'LIVE 복귀',
    docSynced: '.botworld 저장 동기화',
    docReadOnly: '읽기 전용 보드',
    live: 'LIVE',
    replay: 'REPLAY',
    play: '▶ 재생',
    pause: '❚❚ 일시정지',
    speedAriaLabel: '재생 배속',
    scrubberAriaLabel: '24시간 타임라인 스크러버',
    eventLog: '사건 로그',
    stageOverlayLive: 'LIVE · 봇 클릭 선택',
    stageOverlayOffline: '오프라인 대기',
    stageOverlayHover: (botName) => `${botName} · 클릭해 상세 보기`,
    stageOverlayReplay: (hms) => `REPLAY · ${hms}`,
    badgeWorking: '▶ 작업 중',
    badgeIdle: '● 대기',
    badgeWaiting: '… 응답',
    badgeBlocked: '■ 차단',
    badgeNeedsYou: (optionsCount) => (optionsCount > 0 ? `★ 결정 (${optionsCount})` : '★ 결정'),
    badgeError: '! 오류',
    badgePaused: 'Zzz 정지',
    calloutNeedsOwner: (count) =>
      count > 1 ? `▲ 결정 대기 (${count}) · 사장님` : '▲ 결정 대기 · 사장님',
    privateLabel: '비공개',
    errorHiddenLabel: '오류 상세 가려짐',
    interruptedLabel: '중단됨',
    automationDispatchFailedLabel: '자동화 실행 전달 실패',
    workerGeneric: '도우미',
    workerNumbered: (seq) => `도우미 #${seq}`,
    workerWithProvider: (provider) => `도우미(${provider})`,
    botGeneric: '봇',
    ownerActor: '사장님',
    unknownActor: '알 수 없음',
    automationGeneric: '정기 자동화',
    automationNumbered: (idx) => `정기 자동화 #${idx}`,
    selectBotTitle: '봇을 선택하세요',
    selectBotDescWithBots:
      '오피스 캔버스에서 봇을 클릭하면 진행 작업, 최근 요청/답변, 열린 항목, 소속 워커와 10종 캐릭터 교체를 볼 수 있습니다.',
    selectBotDescEmpty: '표시할 봇이 없습니다. Orca 런타임이 연결되면 봇들이 사무실에 배치됩니다.',
    avatarAlt: (name) => `${name} 캐릭터`,
    redactSpecialtyHidden: '가림 모드 활성: 세부 분야 숨김',
    closeDetailAria: '상세 닫기',
    sectionActiveTask: '진행 중 작업 (읽기 전용)',
    needsDecisionPrefix: (prompt) => `결정 필요: ${prompt}`,
    noActiveTask: '진행 중인 작업 없음',
    usingToolPrefix: (tool) => `사용 도구: ${tool}`,
    sectionSwitchCharacter: '캐릭터 교체 (10종)',
    sectionRecentMessages: '최근 요청 / 답변',
    noRecentMessages: '최근 요청/답변 없음',
    msgTypeLabels: {
      handoff: '인계',
      question: '질문',
      worker_done: '완료',
      escalation: '개입',
      approval_closed: '승인',
      status: '보고/답변',
    },
    msgTypeDefault: '메시지',
    msgTypeFallback: (typeLabel) => `${typeLabel} 메시지`,
    msgRedactedSummary: (botName, typeLabel) => `${botName} · ${typeLabel} 메시지`,
    sectionOpenItems: '열린 항목',
    noOpenItems: '열린 항목 없음',
    itemStatusLabels: {
      needs_you: '결정 대기',
      in_progress: '진행 중',
      planned: '예정됨',
      done: '완료',
      canceled: '취소됨',
    },
    sectionWorkers: '소속 워커',
    noWorkers: '소속 워커 없음',
    livenessLabels: {
      Live: '실행 중',
      Exited: '종료',
      Unverifiable: '미확인',
    },
    workerStateLabels: {
      working: '작업 중',
      idle: '대기',
      blocked: '차단됨',
      waiting: '대기 중',
      done: '완료',
      succeeded: '완료',
      failed: '실패',
      canceled: '취소',
      exited: '종료',
      released: '해제',
    },
    workerRedactedDetail: (botName, stateLabel) => `${botName} · 도우미 · ${stateLabel}`,
    noTaskDetails: '세부 작업 없음',
    sectionAutomations: '정기 자동화',
    noAutomations: '연결된 정기 자동화 없음',
    autoCompletedNoReply: '완료 (이상 없음)',
    autoCompleted: '완료',
    autoFailed: '실패',
    autoIdle: '대기',
    autoDisabled: '비활성',
    noEventsRecorded: '아직 기록된 사건이 없습니다.',
    recordedEventFallback: '기록된 사건',
    cmdOpenResult: (botCount) => `봇 월드 활성 (${botCount}개 봇)`,
    cmdRefreshResult: (botCount) => `봇 월드 새로고침 완료 (${botCount}개 봇)`,
    statusBarOfflineRedacted: '봇 월드 · 가림 · 오프라인',
    statusBarOffline: '봇 월드 (오프라인)',
    statusBarOfflineTooltipRedacted: '가림 모드 활성 · 오프라인',
    statusBarOfflineTooltip: 'Orca 런타임 연결 대기 중',
    statusBarBrand: '봇 월드',
    statusBarRedactedTag: '가림',
  },
};

export function tStrings(locale: UiLocale = 'en'): UiDictionary {
  return pickLocale(UI_STRINGS, locale);
}

export function localizeBotErrorMessage(message: string, locale: UiLocale = 'en'): string {
  const s = tStrings(locale);
  const trimmed = message.trim();
  if (trimmed === 'Interrupted' || trimmed === '중단됨') {
    return s.interruptedLabel;
  }
  if (
    trimmed === '자동화 실행 전달 실패' ||
    trimmed === 'Automation dispatch failed' ||
    trimmed === 'Automation failed'
  ) {
    return s.automationDispatchFailedLabel;
  }
  if (trimmed === '오류 상세 가려짐' || trimmed === 'Error details hidden') {
    return s.errorHiddenLabel;
  }
  return message;
}
