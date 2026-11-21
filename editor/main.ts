import { diffSnapshots } from '../src/events.ts';
import '../src/protocol.ts';
import { scrubAll } from '../src/redact.ts';
import { formatTimeHms } from '../src/timeline.ts';
import {
  type BotWorldDocumentData,
  type BotWorldStatePayload,
  type CharacterId,
  DEFAULT_BOTWORLD_DOCUMENT,
  type LanguageSetting,
  type ThemeId,
  type UiLocale,
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
import { effectiveLocale, getHostLocale, resolveUiLocale, tStrings } from '../shared/i18n.ts';
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

const initialLocale = resolveUiLocale(getHostLocale());
const initialStrings = tStrings(initialLocale);

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
    locale: initialLocale,
    languageSetting: 'auto',
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

function currentLocale(): UiLocale {
  return effectiveLocale(state.payload.languageSetting, getHostLocale());
}

// Toolbar
const titleEl = el('span', { className: 'bw-title' }, initialStrings.appTitleEditor);
const startupBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-seg-btn',
    onClick: () => void switchTheme('startup_office').catch(() => {}),
  },
  initialStrings.themeFull.startup_office
);
const corpBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-seg-btn',
    onClick: () => void switchTheme('corporate_office').catch(() => {}),
  },
  initialStrings.themeFull.corporate_office
);
const themeSeg = el(
  'div',
  { className: 'bw-seg', role: 'group', ariaLabel: initialStrings.themeAriaLabel },
  startupBtn,
  corpBtn
);

const redactBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn',
    onClick: () => void toggleRedact().catch(() => {}),
  },
  initialStrings.redactOff
);

const langBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn',
    title: initialStrings.langToggleTitle,
    ariaLabel: initialStrings.langToggleTitle,
    onClick: () => void toggleLanguage().catch(() => {}),
  },
  initialStrings.langToggleText
);

const refreshBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn',
    onClick: () => void triggerRefresh().catch(() => {}),
  },
  initialStrings.refresh
);

const connPill = el('span', { className: 'bw-status-pill' }, initialStrings.connecting);
const docSyncPill = el('span', { className: 'bw-chip' }, initialStrings.docSynced);

const toolbar = el(
  'div',
  { className: 'bw-toolbar' },
  el(
    'div',
    { className: 'bw-toolbar-group' },
    titleEl,
    connPill,
    docSyncPill
  ),
  el('div', { className: 'bw-toolbar-group' }, themeSeg, redactBtn, langBtn, refreshBtn)
);

// Main 2-column area
const canvasEl = el('canvas', { className: 'bw-stage-canvas' }) as HTMLCanvasElement;
const stageOverlayNote = el('div', { className: 'bw-stage-overlay-note' }, initialStrings.live);
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
      const locale = currentLocale();
      const theme = getThemeConfig(activeThemeId(), locale);
      replay.togglePlay(
        state.payload.keyframes,
        state.payload.events,
        state.payload.snapshot,
        theme,
        locale
      );
      syncReplayLoop();
      renderUi();
    },
  },
  initialStrings.play
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
  initialStrings.live
);

const speedButtons = new Map<ReplaySpeed, HTMLButtonElement>();
const speedSeg = el('div', {
  className: 'bw-seg',
  role: 'group',
  ariaLabel: initialStrings.speedAriaLabel,
});
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
  ariaLabel: initialStrings.scrubberAriaLabel,
  onInput: () => {
    const frac = Number(scrubber.value) / 1000;
    const locale = currentLocale();
    const theme = getThemeConfig(activeThemeId(), locale);
    replay.seekFraction(
      frac,
      state.payload.keyframes,
      state.payload.events,
      state.payload.snapshot,
      theme,
      locale
    );
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
  initialStrings.eventLog
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
  const locale = currentLocale();
  const s = tStrings(locale);
  const snap = currentDisplayedSnapshot();
  if (replay.isReplay) {
    stageOverlayNote.textContent = s.stageOverlayReplay(formatTimeHms(replay.cursorMs, locale));
    return;
  }
  const hid = state.hoveredBotId;
  if (hid && isSafeKey(hid) && Object.hasOwn(snap.bots, hid)) {
    stageOverlayNote.textContent = s.stageOverlayHover(scrubAll(snap.bots[hid].name));
    return;
  }
  stageOverlayNote.textContent = snap.runtime.connected ? s.stageOverlayLive : s.stageOverlayOffline;
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

function syncChromeLocale(locale: UiLocale): void {
  const s = tStrings(locale);
  document.documentElement.lang = locale;
  document.title = s.appTitleEditor;
  titleEl.textContent = s.appTitleEditor;
  startupBtn.textContent = s.themeFull.startup_office;
  corpBtn.textContent = s.themeFull.corporate_office;
  themeSeg.setAttribute('aria-label', s.themeAriaLabel);
  langBtn.textContent = s.langToggleText;
  langBtn.title = s.langToggleTitle;
  langBtn.setAttribute('aria-label', s.langToggleTitle);
  refreshBtn.textContent = s.refresh;
  liveBtn.textContent = s.live;
  speedSeg.setAttribute('aria-label', s.speedAriaLabel);
  scrubber.setAttribute('aria-label', s.scrubberAriaLabel);
  drawerToggleBtn.textContent = s.eventLog;
}

function renderToolbarOnly(
  themeId: ThemeId,
  redactMode: boolean,
  snap: WorldSnapshot,
  locale: UiLocale
): void {
  const s = tStrings(locale);
  startupBtn.className =
    themeId === 'startup_office' ? 'bw-seg-btn bw-seg-btn-active' : 'bw-seg-btn';
  corpBtn.className =
    themeId === 'corporate_office' ? 'bw-seg-btn bw-seg-btn-active' : 'bw-seg-btn';

  redactBtn.textContent = redactMode ? s.redactOn : s.redactOff;
  redactBtn.className = redactMode ? 'bw-btn bw-btn-warn' : 'bw-btn';

  if (snap.runtime.connected) {
    connPill.textContent = s.connectedBots(Object.keys(snap.bots).length);
    connPill.className = 'bw-status-pill bw-status-online';
  } else {
    connPill.textContent = snap.runtime.retryAfterSecs
      ? s.offlineRetry(snap.runtime.retryAfterSecs)
      : s.offline;
    connPill.className = 'bw-status-pill bw-status-offline';
  }

  docSyncPill.textContent = docSession?.readOnly ? s.docReadOnly : s.docSynced;
}

function renderTimelineControlsOnly(snap: WorldSnapshot, locale: UiLocale): void {
  const s = tStrings(locale);
  liveBtn.className = !replay.isReplay ? 'bw-btn bw-btn-active' : 'bw-btn';
  playBtn.textContent = replay.isReplay && replay.isPlaying ? s.pause : s.play;
  for (const [spd, btn] of speedButtons.entries()) {
    btn.className = replay.speed === spd ? 'bw-seg-btn bw-seg-btn-active' : 'bw-seg-btn';
  }

  const frac = replay.progressFraction(state.payload.keyframes, state.payload.events);
  scrubber.value = String(Math.round(frac * 1000));
  const displayTs = replay.isReplay ? replay.cursorMs : snap.capturedAt;
  timeLabel.textContent = `${replay.isReplay ? s.replay : s.live} ${formatTimeHms(displayTs, locale)}`;

  drawerToggleBtn.className = state.eventsDrawerOpen ? 'bw-btn bw-btn-active' : 'bw-btn';
  eventsDrawer.classList.toggle('bw-hidden', !state.eventsDrawerOpen);
}

function renderStageFrame(
  themeId: ThemeId,
  redactMode: boolean,
  appearances: Record<string, CharacterId>,
  snap: WorldSnapshot,
  selectedId: string | null,
  locale: UiLocale
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
    locale,
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
let lastDetailLocale: UiLocale | null = null;
let lastDetailAppearancesJson = '';

let lastEventsRef: BotWorldStatePayload['events'] | null = null;
let lastEventsRedact: boolean | null = null;
let lastEventsLocale: UiLocale | null = null;
let lastEventsDrawerOpen: boolean | null = null;

function renderSidePanelsIfNeeded(
  snap: WorldSnapshot,
  selectedId: string | null,
  redactMode: boolean,
  appearances: Record<string, CharacterId>,
  locale: UiLocale,
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
    locale !== lastDetailLocale ||
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
    lastDetailLocale = locale;
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
      locale,
      onSelectCharacter: (botId, charId) => void setBotAppearance(botId, charId).catch(() => {}),
    });
  }

  if (state.eventsDrawerOpen) {
    const eventsChanged =
      force ||
      state.payload.events !== lastEventsRef ||
      redactMode !== lastEventsRedact ||
      locale !== lastEventsLocale ||
      lastEventsDrawerOpen !== true;

    if (eventsChanged) {
      lastEventsRef = state.payload.events;
      lastEventsRedact = redactMode;
      lastEventsLocale = locale;
      lastEventsDrawerOpen = true;
      renderEventTimelineList(eventsDrawer, {
        events: state.payload.events,
        redactMode,
        limit: 120,
        locale,
        onJumpToTime: (ts) => {
          const curLocale = currentLocale();
          replay.seekTo(
            ts,
            state.payload.keyframes,
            state.payload.events,
            state.payload.snapshot,
            getThemeConfig(activeThemeId(), curLocale),
            curLocale
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
        const locale = currentLocale();
        replay.step(
          dtSecs,
          state.payload.keyframes,
          state.payload.events,
          state.payload.snapshot,
          getThemeConfig(themeId, locale),
          locale
        );
        const snap = currentDisplayedSnapshot();
        const redactMode = activeRedactMode();
        const appearances = mergedAppearances();
        const selectedId = resolveSelectedBotId(snap);
        renderTimelineControlsOnly(snap, locale);
        renderStageFrame(themeId, redactMode, appearances, snap, selectedId, locale);
        renderSidePanelsIfNeeded(snap, selectedId, redactMode, appearances, locale, false);
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
  const locale = currentLocale();
  const themeId = activeThemeId();
  const redactMode = activeRedactMode();
  const appearances = mergedAppearances();
  const snap = currentDisplayedSnapshot();
  const selectedId = resolveSelectedBotId(snap);

  syncChromeLocale(locale);
  renderToolbarOnly(themeId, redactMode, snap, locale);
  renderTimelineControlsOnly(snap, locale);
  renderStageFrame(themeId, redactMode, appearances, snap, selectedId, locale);
  renderSidePanelsIfNeeded(snap, selectedId, redactMode, appearances, locale, forceSidePanels);
}

function applyIncomingPayload(nextPayload: BotWorldStatePayload): void {
  const locale = effectiveLocale(nextPayload.languageSetting, getHostLocale());
  const theme = getThemeConfig(activeThemeId(), locale);
  const hadPrev = Object.keys(prevLiveSnapshot.bots).length > 0;
  if (hadPrev && nextPayload.snapshot.initialSyncComplete) {
    const newEvents = diffSnapshots(prevLiveSnapshot, nextPayload.snapshot, false, locale);
    if (newEvents.length > 0) {
      liveMotion.enqueueEvents(newEvents, nextPayload.snapshot, theme, locale);
    }
  }
  prevLiveSnapshot = nextPayload.snapshot;
  state.payload = nextPayload;
  if (replay.isReplay) {
    replay.resyncSnapshot(nextPayload.keyframes, nextPayload.snapshot, theme, locale);
  }
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
      const fresh = await orca.plugin.request('botWorld.getState', { locale: getHostLocale() });
      applyIncomingPayload(fresh);
    }
  } catch {
    // Ignore
  }
}

async function toggleLanguage(): Promise<void> {
  const nextLanguage: LanguageSetting = currentLocale() === 'ko' ? 'en' : 'ko';
  try {
    const res = await orca.plugin.request('botWorld.setLanguage', {
      language: nextLanguage,
      hostLocale: getHostLocale(),
    });
    state.payload = {
      ...state.payload,
      languageSetting: res.languageSetting,
      locale: res.locale,
    };
    renderUi(true);
    const fresh = await orca.plugin.request('botWorld.getState', { locale: getHostLocale() });
    applyIncomingPayload(fresh);
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
    const next = await orca.plugin.request('botWorld.refresh', { locale: getHostLocale() });
    applyIncomingPayload(next);
  } catch {
    // Keep existing state when refresh fails
  } finally {
    refreshBtn.disabled = false;
  }
}

async function boot(): Promise<void> {
  renderUi(true);
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

    let initial = await orca.plugin.request('botWorld.getState', { locale: getHostLocale() });
    // Only turn ON worker redactMode when document requests it; never auto-disable global redactMode=true
    if (state.docData.redactMode && !initial.redactMode) {
      await orca.plugin.request('botWorld.setRedactMode', { redactMode: true });
      initial = await orca.plugin.request('botWorld.getState', { locale: getHostLocale() });
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
