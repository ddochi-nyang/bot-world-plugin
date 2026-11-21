import { diffSnapshots } from '../src/events.ts';
import '../src/protocol.ts';
import { formatKstHms } from '../src/timeline.ts';
import {
  type BotWorldDocumentData,
  type BotWorldStatePayload,
  type CharacterId,
  DEFAULT_BOTWORLD_DOCUMENT,
  type ThemeId,
  type WorldSnapshot,
  createEmptySnapshot,
  isSafeKey,
} from '../src/types.ts';
import { getThemeConfig } from '../shared/assets-catalog.ts';
import {
  renderBotDetail,
  renderEventTimelineList,
} from '../shared/bot-detail-view.ts';
import { el } from '../shared/dom.ts';
import {
  MotionDirector,
  REPLAY_SPEEDS,
  ReplayController,
  type ReplaySpeed,
} from '../shared/motion.ts';
import { StageRenderer } from '../shared/stage-renderer.ts';
import { startBotWorldDocSession } from './doc-sync.ts';

const root = document.getElementById('app');
if (!root) {
  throw new Error('Missing #app container');
}

const state: {
  payload: BotWorldStatePayload;
  docData: BotWorldDocumentData;
  hoveredBotId: string | null;
  eventsDrawerOpen: boolean;
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
  docData: {
    ...DEFAULT_BOTWORLD_DOCUMENT,
    botAppearances: {},
  },
  hoveredBotId: null,
  eventsDrawerOpen: true,
};

let docSession: Awaited<ReturnType<typeof startBotWorldDocSession>> | null = null;
const liveMotion = new MotionDirector();
const replay = new ReplayController();
let prevLiveSnapshot: WorldSnapshot = createEmptySnapshot();
let replayTimerId: number | null = null;
let lastReplayTickMs = 0;

// Toolbar
const startupBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-seg-btn',
    onClick: () => void switchTheme('startup_office').catch(() => {}),
  },
  '스타트업 사무실'
);
const corpBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-seg-btn',
    onClick: () => void switchTheme('corporate_office').catch(() => {}),
  },
  '대기업 사무실'
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
const docSyncPill = el('span', { className: 'bw-chip' }, '.botworld 동기화됨');

const toolbar = el(
  'div',
  { className: 'bw-toolbar' },
  el(
    'div',
    { className: 'bw-toolbar-group' },
    el('span', { className: 'bw-title' }, '봇 월드 사무실'),
    connPill,
    docSyncPill
  ),
  el('div', { className: 'bw-toolbar-group' }, themeSeg, redactBtn, refreshBtn)
);

// Main 2-column area
const canvasEl = el('canvas', { className: 'bw-stage-canvas' }) as HTMLCanvasElement;
const stageOverlayNote = el('div', { className: 'bw-stage-overlay-note' }, 'LIVE');
const stageWrap = el('div', { className: 'bw-stage-wrap-editor' }, canvasEl, stageOverlayNote);
const detailSidebar = el('div', { className: 'bw-editor-sidebar' });
const editorBody = el('div', { className: 'bw-editor-body' }, stageWrap, detailSidebar);

// Bottom 24h timeline bar
const playBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn',
    onClick: () => {
      const theme = getThemeConfig(activeThemeId());
      replay.togglePlay(state.payload.keyframes, state.payload.events, state.payload.snapshot, theme);
      syncReplayLoop();
      renderUi();
    },
  },
  '▶ 재생'
);

const liveBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn bw-btn-active',
    onClick: () => {
      replay.returnToLive();
      syncReplayLoop();
      renderUi();
    },
  },
  'LIVE'
);

const speedButtons = new Map<ReplaySpeed, HTMLButtonElement>();
const speedSeg = el('div', { className: 'bw-seg', role: 'group', ariaLabel: '재생 배속' });
for (const spd of REPLAY_SPEEDS) {
  const btn = el(
    'button',
    {
      type: 'button',
      className: spd === 1 ? 'bw-seg-btn bw-seg-btn-active' : 'bw-seg-btn',
      onClick: () => {
        replay.speed = spd;
        renderUi();
      },
    },
    `${spd}x`
  );
  speedButtons.set(spd, btn);
  speedSeg.appendChild(btn);
}

const scrubber = el('input', {
  type: 'range',
  className: 'bw-scrubber',
  min: '0',
  max: '1000',
  step: '1',
  value: '1000',
  ariaLabel: '24시간 타임라인 스크러버',
  onInput: () => {
    const frac = Number(scrubber.value) / 1000;
    const theme = getThemeConfig(activeThemeId());
    replay.seekFraction(frac, state.payload.keyframes, state.payload.events, state.payload.snapshot, theme);
    syncReplayLoop();
    renderUi();
  },
}) as HTMLInputElement;

const timeLabel = el('span', { className: 'bw-time-label' }, '--:--:--');
const drawerToggleBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn',
    onClick: () => {
      state.eventsDrawerOpen = !state.eventsDrawerOpen;
      renderUi();
    },
  },
  '사건 로그'
);

const timelineControls = el(
  'div',
  { className: 'bw-timeline-controls' },
  liveBtn,
  playBtn,
  speedSeg,
  scrubber,
  timeLabel,
  drawerToggleBtn
);
const eventsDrawer = el('div', { className: 'bw-events-drawer' });
const timelineBar = el('div', { className: 'bw-timeline-bar' }, timelineControls, eventsDrawer);

root.appendChild(toolbar);
root.appendChild(editorBody);
root.appendChild(timelineBar);

const renderer = new StageRenderer(canvasEl, {
  onSelectBot: (botId) => {
    updateDocumentPrefs({ selectedBotId: botId });
    renderUi();
  },
  onHoverBot: (botId) => {
    if (state.hoveredBotId !== botId) {
      state.hoveredBotId = botId;
      updateStageOverlayLabel();
    }
  },
});

function activeThemeId(): ThemeId {
  return state.docData.themeId ?? state.payload.activeTheme;
}

function activeRedactMode(): boolean {
  return Boolean(state.payload.redactMode) || Boolean(state.docData.redactMode);
}

function mergedAppearances(): Record<string, CharacterId> {
  return {
    ...state.payload.botAppearances,
    ...state.docData.botAppearances,
  };
}

function currentDisplayedSnapshot(): WorldSnapshot {
  return replay.isReplay ? replay.snapshot : state.payload.snapshot;
}

function updateDocumentPrefs(patch: Partial<BotWorldDocumentData>): void {
  const next: BotWorldDocumentData = {
    version: 1,
    themeId: patch.themeId ?? state.docData.themeId,
    redactMode: patch.redactMode ?? state.docData.redactMode,
    selectedBotId:
      patch.selectedBotId !== undefined ? patch.selectedBotId : state.docData.selectedBotId,
    botAppearances: patch.botAppearances ?? { ...state.docData.botAppearances },
  };
  state.docData = next;
  if (docSession && !docSession.readOnly) {
    docSession.change(next);
  }
}

function updateStageOverlayLabel(): void {
  const snap = currentDisplayedSnapshot();
  if (replay.isReplay) {
    stageOverlayNote.textContent = `REPLAY · ${formatKstHms(replay.cursorMs)}`;
    return;
  }
  const hid = state.hoveredBotId;
  if (hid && isSafeKey(hid) && Object.hasOwn(snap.bots, hid)) {
    stageOverlayNote.textContent = `${snap.bots[hid].name} · 클릭해 상세 보기`;
    return;
  }
  stageOverlayNote.textContent = snap.runtime.connected ? 'LIVE · 봇 클릭 선택' : '오프라인 대기';
}

function resolveSelectedBotId(snap: WorldSnapshot): string | null {
  let selectedId = state.docData.selectedBotId;
  if (selectedId && !Object.hasOwn(snap.bots, selectedId)) {
    selectedId = null;
  }
  if (!selectedId) {
    selectedId =
      snap.botOrder.find((id) => Object.hasOwn(snap.bots, id)) ?? Object.keys(snap.bots)[0] ?? null;
  }
  return selectedId;
}

function renderToolbarOnly(themeId: ThemeId, redactMode: boolean, snap: WorldSnapshot): void {
  startupBtn.className =
    themeId === 'startup_office' ? 'bw-seg-btn bw-seg-btn-active' : 'bw-seg-btn';
  corpBtn.className =
    themeId === 'corporate_office' ? 'bw-seg-btn bw-seg-btn-active' : 'bw-seg-btn';

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

  docSyncPill.textContent = docSession?.readOnly ? '읽기 전용 보드' : '.botworld 저장 동기화';
}

function renderTimelineControlsOnly(snap: WorldSnapshot): void {
  liveBtn.className = !replay.isReplay ? 'bw-btn bw-btn-active' : 'bw-btn';
  playBtn.textContent = replay.isReplay && replay.isPlaying ? '❚❚ 일시정지' : '▶ 재생';
  for (const [spd, btn] of speedButtons.entries()) {
    btn.className = replay.speed === spd ? 'bw-seg-btn bw-seg-btn-active' : 'bw-seg-btn';
  }

  const frac = replay.progressFraction(state.payload.keyframes, state.payload.events);
  scrubber.value = String(Math.round(frac * 1000));
  const displayTs = replay.isReplay ? replay.cursorMs : snap.capturedAt;
  timeLabel.textContent = `${replay.isReplay ? 'REPLAY' : 'LIVE'} ${formatKstHms(displayTs)}`;

  drawerToggleBtn.className = state.eventsDrawerOpen ? 'bw-btn bw-btn-active' : 'bw-btn';
  eventsDrawer.classList.toggle('bw-hidden', !state.eventsDrawerOpen);
}

function renderStageFrame(
  themeId: ThemeId,
  redactMode: boolean,
  appearances: Record<string, CharacterId>,
  snap: WorldSnapshot,
  selectedId: string | null
): void {
  updateStageOverlayLabel();
  renderer.update({
    snapshot: snap,
    themeId,
    selectedBotId: selectedId,
    redactMode,
    botAppearances: appearances,
    motion: replay.isReplay ? replay.motion : liveMotion,
    replay,
  });
}

let lastDetailBotsRef: WorldSnapshot['bots'] | null = null;
let lastDetailWorkersRef: WorldSnapshot['workers'] | null = null;
let lastDetailItemsRef: WorldSnapshot['items'] | null = null;
let lastDetailAutosRef: WorldSnapshot['automations'] | null = null;
let lastDetailMsgsRef: WorldSnapshot['recentMessages'] | null = null;
let lastDetailConnected: boolean | null = null;
let lastDetailSelectedId: string | null | undefined = undefined;
let lastDetailRedact: boolean | null = null;
let lastDetailAppearancesJson = '';

let lastEventsRef: BotWorldStatePayload['events'] | null = null;
let lastEventsRedact: boolean | null = null;
let lastEventsDrawerOpen: boolean | null = null;

function renderSidePanelsIfNeeded(
  snap: WorldSnapshot,
  selectedId: string | null,
  redactMode: boolean,
  appearances: Record<string, CharacterId>,
  force = false
): void {
  const appearancesJson = JSON.stringify(appearances);
  const detailChanged =
    force ||
    snap.bots !== lastDetailBotsRef ||
    snap.workers !== lastDetailWorkersRef ||
    snap.items !== lastDetailItemsRef ||
    snap.automations !== lastDetailAutosRef ||
    snap.recentMessages !== lastDetailMsgsRef ||
    snap.runtime.connected !== lastDetailConnected ||
    selectedId !== lastDetailSelectedId ||
    redactMode !== lastDetailRedact ||
    appearancesJson !== lastDetailAppearancesJson;

  if (detailChanged) {
    lastDetailBotsRef = snap.bots;
    lastDetailWorkersRef = snap.workers;
    lastDetailItemsRef = snap.items;
    lastDetailAutosRef = snap.automations;
    lastDetailMsgsRef = snap.recentMessages;
    lastDetailConnected = snap.runtime.connected;
    lastDetailSelectedId = selectedId;
    lastDetailRedact = redactMode;
    lastDetailAppearancesJson = appearancesJson;

    const selectedBot =
      selectedId && isSafeKey(selectedId) && Object.hasOwn(snap.bots, selectedId)
        ? snap.bots[selectedId]
        : null;

    renderBotDetail(detailSidebar, {
      snapshot: snap,
      bot: selectedBot,
      redactMode,
      botAppearances: appearances,
      onSelectCharacter: (botId, charId) => void setBotAppearance(botId, charId).catch(() => {}),
    });
  }

  if (state.eventsDrawerOpen) {
    const eventsChanged =
      force ||
      state.payload.events !== lastEventsRef ||
      redactMode !== lastEventsRedact ||
      lastEventsDrawerOpen !== true;

    if (eventsChanged) {
      lastEventsRef = state.payload.events;
      lastEventsRedact = redactMode;
      lastEventsDrawerOpen = true;
      renderEventTimelineList(eventsDrawer, {
        events: state.payload.events,
        redactMode,
        limit: 120,
        onJumpToTime: (ts) => {
          replay.seekTo(
            ts,
            state.payload.keyframes,
            state.payload.events,
            state.payload.snapshot,
            getThemeConfig(activeThemeId())
          );
          syncReplayLoop();
          renderUi();
        },
      });
    }
  } else {
    lastEventsDrawerOpen = false;
  }
}

function syncReplayLoop(): void {
  if (replay.isReplay && replay.isPlaying) {
    if (replayTimerId === null) {
      lastReplayTickMs = performance.now();
      const tick = (nowMs: number) => {
        if (!replay.isReplay || !replay.isPlaying) {
          replayTimerId = null;
          return;
        }
        const dtSecs = Math.max(0, Math.min(0.25, (nowMs - lastReplayTickMs) / 1000));
        lastReplayTickMs = nowMs;
        const themeId = activeThemeId();
        replay.step(
          dtSecs,
          state.payload.keyframes,
          state.payload.events,
          state.payload.snapshot,
          getThemeConfig(themeId)
        );
        const snap = currentDisplayedSnapshot();
        const redactMode = activeRedactMode();
        const appearances = mergedAppearances();
        const selectedId = resolveSelectedBotId(snap);
        renderTimelineControlsOnly(snap);
        renderStageFrame(themeId, redactMode, appearances, snap, selectedId);
        renderSidePanelsIfNeeded(snap, selectedId, redactMode, appearances, false);
        if (replay.isPlaying) {
          replayTimerId = requestAnimationFrame(tick);
        } else {
          replayTimerId = null;
        }
      };
      replayTimerId = requestAnimationFrame(tick);
    }
  } else if (replayTimerId !== null) {
    cancelAnimationFrame(replayTimerId);
    replayTimerId = null;
  }
}

function renderUi(forceSidePanels = false): void {
  const themeId = activeThemeId();
  const redactMode = activeRedactMode();
  const appearances = mergedAppearances();
  const snap = currentDisplayedSnapshot();
  const selectedId = resolveSelectedBotId(snap);

  renderToolbarOnly(themeId, redactMode, snap);
  renderTimelineControlsOnly(snap);
  renderStageFrame(themeId, redactMode, appearances, snap, selectedId);
  renderSidePanelsIfNeeded(snap, selectedId, redactMode, appearances, forceSidePanels);
}

function applyIncomingPayload(nextPayload: BotWorldStatePayload): void {
  const theme = getThemeConfig(activeThemeId());
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
  updateDocumentPrefs({ themeId });
  renderUi();
  try {
    const res = await orca.plugin.request('botWorld.setTheme', { themeId });
    state.payload = { ...state.payload, activeTheme: res.themeId };
    renderUi();
  } catch {
    // Document change is already persisted locally in .botworld
  }
}

async function toggleRedact(): Promise<void> {
  const nextRedact = !activeRedactMode();
  updateDocumentPrefs({ redactMode: nextRedact });
  renderUi(true);
  try {
    const res = await orca.plugin.request('botWorld.setRedactMode', { redactMode: nextRedact });
    state.payload = { ...state.payload, redactMode: res.redactMode };
    renderUi(true);
    if (res.redactMode) {
      const fresh = await orca.plugin.request('botWorld.getState');
      applyIncomingPayload(fresh);
    }
  } catch {
    // Ignore
  }
}

async function setBotAppearance(botId: string, characterId: CharacterId): Promise<void> {
  if (!isSafeKey(botId)) return;
  const nextAppearances = { ...state.docData.botAppearances };
  Object.defineProperty(nextAppearances, botId, {
    value: characterId,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  updateDocumentPrefs({ botAppearances: nextAppearances });
  renderUi();
  try {
    const res = await orca.plugin.request('botWorld.setBotAppearance', { botId, characterId });
    state.payload = { ...state.payload, botAppearances: res.botAppearances };
    renderUi();
  } catch {
    // Ignore
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

    docSession = await startBotWorldDocSession();
    state.docData = docSession.value;
    docSession.onReplace((nextDoc) => {
      state.docData = nextDoc;
      renderUi(true);
    });

    let initial = await orca.plugin.request('botWorld.getState');
    // Only turn ON worker redactMode when document requests it; never auto-disable global redactMode=true
    if (state.docData.redactMode && !initial.redactMode) {
      await orca.plugin.request('botWorld.setRedactMode', { redactMode: true });
      initial = await orca.plugin.request('botWorld.getState');
    }

    orca.plugin.on('botWorld.stateUpdated', (payload) => {
      applyIncomingPayload(payload);
    });

    applyIncomingPayload(initial);
  } catch {
    renderUi(true);
  }
}

window.addEventListener('beforeunload', () => {
  if (replayTimerId !== null) cancelAnimationFrame(replayTimerId);
  docSession?.dispose();
  renderer.dispose();
});

void boot().catch(() => {});
