import { diffSnapshots } from '../src/events.ts';
import '../src/protocol.ts';
import { formatKstHms } from '../src/timeline.ts';
import {
  type BotWorldStatePayload,
  type CharacterId,
  type ThemeId,
  type WorldSnapshot,
  createEmptySnapshot,
  isSafeKey,
} from '../src/types.ts';
import { getThemeConfig } from '../shared/assets-catalog.ts';
import {
  renderBotDetail,
  renderBotQuickPills,
  renderEventTimelineList,
} from '../shared/bot-detail-view.ts';
import { clearChildren, el } from '../shared/dom.ts';
import { MotionDirector, ReplayController } from '../shared/motion.ts';
import { StageRenderer } from '../shared/stage-renderer.ts';

type PanelTab = 'detail' | 'timeline';

const root = document.getElementById('app');
if (!root) {
  throw new Error('Missing #app container');
}

const state: {
  payload: BotWorldStatePayload;
  selectedBotId: string | null;
  hoveredBotId: string | null;
  activeTab: PanelTab;
} = {
  payload: {
    snapshot: createEmptySnapshot(),
    events: [],
    keyframes: [],
    activeTheme: 'startup_office',
    redactMode: false,
    botAppearances: {},
    pollIntervalSec: 5,
  },
  selectedBotId: null,
  hoveredBotId: null,
  activeTab: 'detail',
};

const liveMotion = new MotionDirector();
const replay = new ReplayController();
let prevLiveSnapshot: WorldSnapshot = createEmptySnapshot();

// Build static shell DOM safely
const startupBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-seg-btn',
    onClick: () => void switchTheme('startup_office').catch(() => {}),
  },
  '스타트업'
);
const corpBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-seg-btn',
    onClick: () => void switchTheme('corporate_office').catch(() => {}),
  },
  '대기업'
);
const themeSeg = el('div', { className: 'bw-seg', role: 'group', ariaLabel: '사무실 테마' }, startupBtn, corpBtn);

const redactBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn',
    onClick: () => void toggleRedact().catch(() => {}),
  },
  '가림 OFF'
);

const refreshBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn',
    onClick: () => void triggerRefresh().catch(() => {}),
  },
  '새로고침'
);

const connPill = el('span', { className: 'bw-status-pill' }, '연결 중');

const toolbar = el(
  'div',
  { className: 'bw-toolbar' },
  el('div', { className: 'bw-toolbar-group' }, el('span', { className: 'bw-title' }, '봇 월드'), connPill),
  el('div', { className: 'bw-toolbar-group' }, themeSeg, redactBtn, refreshBtn)
);

const boardHint = el(
  'div',
  { className: 'bw-hint-banner' },
  el('span', null, '넓은 전체 사무실 · 24h 스크러버는 새 파일 → 새 봇 월드 보드(.botworld)로 여세요.')
);

const canvasEl = el('canvas', { className: 'bw-stage-canvas' }) as HTMLCanvasElement;
const stageOverlayNote = el('div', { className: 'bw-stage-overlay-note' }, 'LIVE');
const stageWrap = el('div', { className: 'bw-stage-wrap-panel' }, canvasEl, stageOverlayNote);

const botStrip = el('div', { className: 'bw-bot-strip' });

const tabDetailBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn bw-btn-active',
    onClick: () => {
      state.activeTab = 'detail';
      renderUi();
    },
  },
  '봇 상세'
);
const tabTimelineBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn',
    onClick: () => {
      state.activeTab = 'timeline';
      renderUi();
    },
  },
  '사건 타임라인'
);
const backToLiveBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn bw-btn-warn bw-hidden',
    onClick: () => {
      replay.returnToLive();
      renderUi();
    },
  },
  'LIVE 복귀'
);
const subTabs = el('div', { className: 'bw-subtabs' }, tabDetailBtn, tabTimelineBtn, backToLiveBtn);

const lowerContent = el('div', { className: 'bw-detail-root' });
const mainArea = el('div', { className: 'bw-panel-main' }, stageWrap, botStrip, subTabs, lowerContent);

root.appendChild(toolbar);
root.appendChild(boardHint);
root.appendChild(mainArea);

const renderer = new StageRenderer(canvasEl, {
  onSelectBot: (botId) => {
    state.selectedBotId = botId;
    state.activeTab = 'detail';
    renderUi();
  },
  onHoverBot: (botId) => {
    if (state.hoveredBotId !== botId) {
      state.hoveredBotId = botId;
      updateStageOverlayLabel();
    }
  },
});

function currentDisplayedSnapshot(): WorldSnapshot {
  return replay.isReplay ? replay.snapshot : state.payload.snapshot;
}

function updateStageOverlayLabel(): void {
  const snap = currentDisplayedSnapshot();
  if (replay.isReplay) {
    stageOverlayNote.textContent = `REPLAY ${formatKstHms(replay.cursorMs)}`;
    return;
  }
  if (state.hoveredBotId && isSafeKey(state.hoveredBotId) && Object.hasOwn(snap.bots, state.hoveredBotId)) {
    const b = snap.bots[state.hoveredBotId];
    stageOverlayNote.textContent = `${b.name} · 클릭해 상세 보기`;
    return;
  }
  stageOverlayNote.textContent = snap.runtime.connected ? 'LIVE · 봇 클릭 선택' : '오프라인 대기';
}

function renderUi(): void {
  const { activeTheme, redactMode, botAppearances, events } = state.payload;
  const snap = currentDisplayedSnapshot();

  startupBtn.className =
    activeTheme === 'startup_office' ? 'bw-seg-btn bw-seg-btn-active' : 'bw-seg-btn';
  corpBtn.className =
    activeTheme === 'corporate_office' ? 'bw-seg-btn bw-seg-btn-active' : 'bw-seg-btn';

  redactBtn.textContent = redactMode ? '가림 ON' : '가림 OFF';
  redactBtn.className = redactMode ? 'bw-btn bw-btn-warn' : 'bw-btn';

  if (snap.runtime.connected) {
    connPill.textContent = `연결됨 · ${Object.keys(snap.bots).length}봇`;
    connPill.className = 'bw-status-pill bw-status-online';
  } else {
    connPill.textContent = snap.runtime.retryAfterSecs
      ? `오프라인 (${snap.runtime.retryAfterSecs}s)`
      : '오프라인';
    connPill.className = 'bw-status-pill bw-status-offline';
  }

  backToLiveBtn.classList.toggle('bw-hidden', !replay.isReplay);
  tabDetailBtn.className = state.activeTab === 'detail' ? 'bw-btn bw-btn-active' : 'bw-btn';
  tabTimelineBtn.className = state.activeTab === 'timeline' ? 'bw-btn bw-btn-active' : 'bw-btn';

  // Ensure selectedBotId points to an existing bot or first bot
  if (state.selectedBotId && !Object.hasOwn(snap.bots, state.selectedBotId)) {
    state.selectedBotId = null;
  }
  if (!state.selectedBotId) {
    const firstId = snap.botOrder.find((id) => Object.hasOwn(snap.bots, id)) ?? Object.keys(snap.bots)[0];
    state.selectedBotId = firstId ?? null;
  }

  updateStageOverlayLabel();

  renderer.update({
    snapshot: snap,
    themeId: activeTheme,
    selectedBotId: state.selectedBotId,
    redactMode,
    botAppearances,
    motion: replay.isReplay ? replay.motion : liveMotion,
    replay,
  });

  renderBotQuickPills(botStrip, {
    snapshot: snap,
    selectedBotId: state.selectedBotId,
    onSelectBot: (botId) => {
      state.selectedBotId = botId;
      state.activeTab = 'detail';
      renderUi();
    },
  });

  if (state.activeTab === 'detail') {
    const selectedBot =
      state.selectedBotId && isSafeKey(state.selectedBotId) && Object.hasOwn(snap.bots, state.selectedBotId)
        ? snap.bots[state.selectedBotId]
        : null;
    renderBotDetail(lowerContent, {
      snapshot: snap,
      bot: selectedBot,
      redactMode,
      botAppearances,
      onSelectCharacter: (botId, charId) => void setBotAppearance(botId, charId).catch(() => {}),
    });
  } else {
    clearChildren(lowerContent);
    const listWrap = el('div', { className: 'bw-detail-body' });
    renderEventTimelineList(listWrap, {
      events,
      redactMode,
      limit: 60,
      onJumpToTime: (ts) => {
        const theme = getThemeConfig(state.payload.activeTheme);
        replay.seekTo(ts, state.payload.keyframes, state.payload.events, state.payload.snapshot, theme);
        renderUi();
      },
    });
    lowerContent.appendChild(listWrap);
  }
}

function applyIncomingPayload(nextPayload: BotWorldStatePayload): void {
  const theme = getThemeConfig(nextPayload.activeTheme);
  const hadPrev = Object.keys(prevLiveSnapshot.bots).length > 0;
  if (hadPrev && nextPayload.snapshot.initialSyncComplete) {
    const newEvents = diffSnapshots(prevLiveSnapshot, nextPayload.snapshot, false);
    if (newEvents.length > 0) {
      liveMotion.enqueueEvents(newEvents, nextPayload.snapshot, theme);
    }
  }
  prevLiveSnapshot = nextPayload.snapshot;
  state.payload = nextPayload;
  renderUi();
}

async function switchTheme(themeId: ThemeId): Promise<void> {
  try {
    const res = await orca.plugin.request('botWorld.setTheme', { themeId });
    state.payload = { ...state.payload, activeTheme: res.themeId };
    renderUi();
  } catch {
    // Ignore RPC failure
  }
}

async function toggleRedact(): Promise<void> {
  try {
    const res = await orca.plugin.request('botWorld.setRedactMode', {
      redactMode: !state.payload.redactMode,
    });
    state.payload = { ...state.payload, redactMode: res.redactMode };
    renderUi();
    if (res.redactMode) {
      const fresh = await orca.plugin.request('botWorld.getState');
      applyIncomingPayload(fresh);
    }
  } catch {
    // Ignore RPC failure
  }
}

async function setBotAppearance(botId: string, characterId: CharacterId): Promise<void> {
  try {
    const res = await orca.plugin.request('botWorld.setBotAppearance', { botId, characterId });
    state.payload = { ...state.payload, botAppearances: res.botAppearances };
    renderUi();
  } catch {
    // Ignore RPC failure
  }
}

async function triggerRefresh(): Promise<void> {
  refreshBtn.disabled = true;
  try {
    const next = await orca.plugin.request('botWorld.refresh');
    applyIncomingPayload(next);
  } catch {
    // Keep existing state when refresh fails
  } finally {
    refreshBtn.disabled = false;
  }
}

async function boot(): Promise<void> {
  try {
    orca.on('theme', ({ colorScheme }) => {
      document.documentElement.classList.toggle('light', colorScheme === 'light');
    });

    orca.plugin.on('botWorld.stateUpdated', (payload) => {
      applyIncomingPayload(payload);
    });

    const initial = await orca.plugin.request('botWorld.getState');
    applyIncomingPayload(initial);
  } catch {
    renderUi();
  }
}

window.addEventListener('beforeunload', () => {
  renderer.dispose();
});

void boot().catch(() => {});
