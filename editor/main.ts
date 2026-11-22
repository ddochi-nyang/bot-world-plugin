import { diffSnapshots } from '../src/events.ts';
import '../src/protocol.ts';
import { scrubAll } from '../src/redact.ts';
import { formatTimeHms } from '../src/timeline.ts';
import {
  type AtmosphereMode,
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
import { type DemoOfficeSession, createDemoOfficeSession } from '../shared/demo-office.ts';
import { el } from '../shared/dom.ts';
import { effectiveLocale, getHostLocale, resolveUiLocale, tStrings } from '../shared/i18n.ts';
import {
  MotionDirector,
  REPLAY_SPEEDS,
  ReplayController,
  type ReplaySpeed,
} from '../shared/motion.ts';
import {
  atmosphereIcon,
  mapKeyToShortcutAction,
  nextAtmosphereMode,
  renderShortcutsModal,
  shouldIgnoreShortcutEvent,
} from '../shared/shortcuts.ts';
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
  shortcutsOpen: boolean;
  selectionCleared: boolean;
} = {
  payload: {
    snapshot: createEmptySnapshot(),
    events: [],
    keyframes: [],
    activeTheme: 'startup_office',
    atmosphereMode: 'auto',
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
  shortcutsOpen: false,
  selectionCleared: false,
};

let docSession: Awaited<ReturnType<typeof startBotWorldDocSession>> | null = null;
const liveMotion = new MotionDirector();
const replay = new ReplayController();
let prevLiveSnapshot: WorldSnapshot = createEmptySnapshot();
let livePayload: BotWorldStatePayload = state.payload;
let replayTimerId: number | null = null;
let lastReplayTickMs = 0;

let demoSession: DemoOfficeSession | null = null;
let demoTimerId: number | null = null;
let demoThemeId: ThemeId = 'startup_office';
let demoAtmosphereMode: AtmosphereMode = 'auto';
let demoRedactMode = false;
let demoLanguageSetting: LanguageSetting = 'auto';
let demoAppearances: Record<string, CharacterId> = {};
let demoSelectedBotId: string | null = null;

function isDemoMode(): boolean {
  return demoSession !== null;
}

function currentLocale(): UiLocale {
  const setting = isDemoMode() ? demoLanguageSetting : state.payload.languageSetting;
  return effectiveLocale(setting, getHostLocale());
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

const atmoBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn',
    ariaLabel: initialStrings.atmosphereAriaLabel,
    onClick: () => void cycleAtmosphere().catch(() => {}),
  },
  `${atmosphereIcon('auto')} ${initialStrings.atmosphereModes.auto}`
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
    title: `${initialStrings.langToggleTitle} [L]`,
    ariaLabel: initialStrings.langToggleTitle,
    onClick: () => void toggleLanguage().catch(() => {}),
  },
  initialStrings.langToggleText
);

const demoBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn',
    onClick: () => {
      if (isDemoMode()) {
        exitDemoMode();
      } else {
        enterDemoMode();
      }
    },
  },
  initialStrings.demoButton
);

const helpBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn',
    title: initialStrings.shortcutsButtonTitle,
    ariaLabel: initialStrings.shortcutsButtonTitle,
    onClick: () => {
      state.shortcutsOpen = !state.shortcutsOpen;
      renderShortcutsHelp();
      syncChromeLocale(currentLocale());
    },
  },
  '?'
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
const demoHintText = el('span', null, initialStrings.demoModeHint);
const demoHintBanner = el('div', { className: 'bw-hint-banner bw-hidden' }, demoHintText);

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
  el(
    'div',
    { className: 'bw-toolbar-group' },
    themeSeg,
    atmoBtn,
    redactBtn,
    langBtn,
    demoBtn,
    helpBtn,
    refreshBtn
  )
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
const shortcutsBackdrop = el('div', {
  className: 'bw-modal-backdrop bw-hidden',
  onClick: () => {
    state.shortcutsOpen = false;
    renderShortcutsHelp();
  },
});

root.appendChild(toolbar);
root.appendChild(demoHintBanner);
root.appendChild(editorBody);
root.appendChild(timelineBar);
root.appendChild(shortcutsBackdrop);

const renderer = new StageRenderer(canvasEl, {
  onSelectBot: (botId) => {
    state.selectionCleared = false;
    if (isDemoMode()) {
      demoSelectedBotId = botId;
    } else {
      updateDocumentPrefs({ selectedBotId: botId });
    }
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
  if (isDemoMode()) return demoThemeId;
  return state.docData.themeId ?? state.payload.activeTheme;
}

function activeAtmosphereMode(): AtmosphereMode {
  if (isDemoMode()) return demoAtmosphereMode;
  return state.docData.atmosphereMode ?? state.payload.atmosphereMode ?? 'auto';
}

function activeRedactMode(): boolean {
  if (isDemoMode()) return demoRedactMode;
  return Boolean(state.payload.redactMode) || Boolean(state.docData.redactMode);
}

function mergedAppearances(): Record<string, CharacterId> {
  if (isDemoMode()) return { ...demoAppearances };
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
    atmosphereMode: patch.atmosphereMode ?? state.docData.atmosphereMode ?? 'auto',
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
  if (state.selectionCleared) {
    return null;
  }
  let selectedId = isDemoMode() ? demoSelectedBotId : state.docData.selectedBotId;
  if (selectedId && !Object.hasOwn(snap.bots, selectedId)) {
    selectedId = null;
  }
  if (!selectedId) {
    selectedId =
      snap.botOrder.find((id) => Object.hasOwn(snap.bots, id)) ?? Object.keys(snap.bots)[0] ?? null;
  }
  return selectedId;
}

function renderShortcutsHelp(): void {
  renderShortcutsModal(shortcutsBackdrop, {
    open: state.shortcutsOpen,
    locale: currentLocale(),
    isEditor: true,
    onClose: () => {
      state.shortcutsOpen = false;
      renderShortcutsHelp();
    },
  });
}

function syncChromeLocale(locale: UiLocale): void {
  const s = tStrings(locale);
  const atmoMode = activeAtmosphereMode();
  const atmoLabel = s.atmosphereModes[atmoMode];
  document.documentElement.lang = locale;
  document.title = s.appTitleEditor;
  titleEl.textContent = s.appTitleEditor;
  startupBtn.textContent = s.themeFull.startup_office;
  startupBtn.title = s.themeToggleTitle;
  corpBtn.textContent = s.themeFull.corporate_office;
  corpBtn.title = s.themeToggleTitle;
  themeSeg.setAttribute('aria-label', s.themeAriaLabel);
  atmoBtn.textContent = `${atmosphereIcon(atmoMode)} ${atmoLabel}`;
  atmoBtn.title = s.atmosphereToggleTitle(atmoLabel);
  atmoBtn.className = atmoMode !== 'auto' ? 'bw-btn bw-btn-active' : 'bw-btn';
  redactBtn.title = s.redactToggleTitle;
  langBtn.textContent = s.langToggleText;
  langBtn.title = `${s.langToggleTitle} [L]`;
  langBtn.setAttribute('aria-label', s.langToggleTitle);
  demoBtn.textContent = isDemoMode() ? s.exitDemoOffice : s.demoButton;
  demoBtn.title = s.demoToggleTitle;
  demoBtn.className = isDemoMode() ? 'bw-btn bw-btn-active' : 'bw-btn';
  helpBtn.title = s.shortcutsButtonTitle;
  helpBtn.setAttribute('aria-label', s.shortcutsButtonTitle);
  helpBtn.className = state.shortcutsOpen ? 'bw-btn bw-btn-active' : 'bw-btn';
  demoHintText.textContent = s.demoModeHint;
  demoHintBanner.classList.toggle('bw-hidden', !isDemoMode());
  refreshBtn.textContent = s.refresh;
  liveBtn.textContent = s.live;
  playBtn.title = s.playToggleTitle;
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
  const botCount = Object.keys(snap.bots).length;
  startupBtn.className =
    themeId === 'startup_office' ? 'bw-seg-btn bw-seg-btn-active' : 'bw-seg-btn';
  corpBtn.className =
    themeId === 'corporate_office' ? 'bw-seg-btn bw-seg-btn-active' : 'bw-seg-btn';

  redactBtn.textContent = redactMode ? s.redactOn : s.redactOff;
  redactBtn.className = redactMode ? 'bw-btn bw-btn-warn' : 'bw-btn';

  if (isDemoMode()) {
    connPill.textContent = s.demoModeBadge(botCount);
    connPill.className = 'bw-status-pill bw-status-demo';
    docSyncPill.textContent = s.docReadOnly;
  } else if (snap.runtime.connected) {
    connPill.textContent = s.connectedBots(botCount);
    connPill.className = 'bw-status-pill bw-status-online';
    docSyncPill.textContent = docSession?.readOnly ? s.docReadOnly : s.docSynced;
  } else {
    connPill.textContent = snap.runtime.retryAfterSecs
      ? s.offlineRetry(snap.runtime.retryAfterSecs)
      : s.offline;
    connPill.className = 'bw-status-pill bw-status-offline';
    docSyncPill.textContent = docSession?.readOnly ? s.docReadOnly : s.docSynced;
  }
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
  const displayTimestampMs = replay.isReplay
    ? replay.cursorMs
    : snap.capturedAt > 0
      ? snap.capturedAt
      : Date.now();
  updateStageOverlayLabel();
  renderer.update({
    snapshot: snap,
    themeId,
    atmosphereMode: activeAtmosphereMode(),
    displayTimestampMs,
    selectedBotId: selectedId,
    redactMode,
    botAppearances: appearances,
    motion: replay.isReplay ? replay.motion : liveMotion,
    replay,
    locale,
  });
}

let lastDetailDemoMode: boolean | null = null;
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
  const demoActive = isDemoMode();
  const detailChanged =
    force ||
    demoActive !== lastDetailDemoMode ||
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
    lastDetailDemoMode = demoActive;
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
      botCount: Object.keys(snap.bots).length,
      onStartDemo: demoActive ? undefined : enterDemoMode,
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
  renderShortcutsHelp();
}

function buildDemoPayload(): BotWorldStatePayload | null {
  if (!demoSession) return null;
  return demoSession.getPayload({
    themeId: demoThemeId,
    atmosphereMode: demoAtmosphereMode,
    redactMode: demoRedactMode,
    locale: currentLocale(),
    languageSetting: demoLanguageSetting,
    botAppearances: demoAppearances,
  });
}

function syncDemoTick(advance: boolean, forceSidePanels = false): void {
  if (!demoSession) return;
  const generatedCount = advance ? demoSession.tick().length : 0;
  const nextPayload = buildDemoPayload();
  if (!nextPayload) return;
  const locale = currentLocale();
  const theme = getThemeConfig(demoThemeId, locale);
  if (generatedCount > 0 && !replay.isReplay) {
    const newEvents = nextPayload.events.slice(-generatedCount).map((r) => r.event);
    liveMotion.enqueueEvents(newEvents, nextPayload.snapshot, theme, locale);
  }
  state.payload = nextPayload;
  if (replay.isReplay) {
    replay.resyncSnapshot(nextPayload.keyframes, nextPayload.snapshot, theme, locale);
  }
  renderUi(forceSidePanels);
}

function enterDemoMode(): void {
  if (isDemoMode()) return;
  state.selectionCleared = false;
  demoThemeId = state.docData.themeId ?? livePayload.activeTheme;
  demoAtmosphereMode = state.docData.atmosphereMode ?? livePayload.atmosphereMode ?? 'auto';
  demoRedactMode = Boolean(livePayload.redactMode) || Boolean(state.docData.redactMode);
  demoLanguageSetting = livePayload.languageSetting;
  demoAppearances = {};
  demoSelectedBotId = null;
  demoSession = createDemoOfficeSession();
  replay.returnToLive();
  liveMotion.clearTransients();
  syncReplayLoop();
  const initialDemo = buildDemoPayload();
  if (initialDemo) {
    state.payload = initialDemo;
    demoSelectedBotId = initialDemo.snapshot.botOrder[0] ?? null;
  }
  demoTimerId = window.setInterval(() => {
    if (!demoSession || replay.isReplay) return;
    syncDemoTick(true);
  }, 2600);
  renderUi(true);
}

function exitDemoMode(): void {
  if (demoTimerId !== null) {
    clearInterval(demoTimerId);
    demoTimerId = null;
  }
  state.selectionCleared = false;
  demoSession = null;
  demoSelectedBotId = null;
  replay.returnToLive();
  liveMotion.clearTransients();
  syncReplayLoop();
  state.payload = livePayload;
  renderUi(true);
  void triggerRefresh().catch(() => {});
}

function applyIncomingPayload(nextPayload: BotWorldStatePayload): void {
  livePayload = nextPayload;
  if (isDemoMode()) {
    return;
  }
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
  if (isDemoMode()) {
    demoThemeId = themeId;
    syncDemoTick(false, true);
    return;
  }
  updateDocumentPrefs({ themeId });
  renderUi();
  try {
    const res = await orca.plugin.request('botWorld.setTheme', { themeId });
    state.payload = { ...state.payload, activeTheme: res.themeId };
    livePayload = state.payload;
    renderUi();
  } catch {
    // Document change is already persisted locally in .botworld
  }
}

async function cycleAtmosphere(): Promise<void> {
  const nextMode = nextAtmosphereMode(activeAtmosphereMode());
  if (isDemoMode()) {
    demoAtmosphereMode = nextMode;
    syncDemoTick(false, true);
    return;
  }
  updateDocumentPrefs({ atmosphereMode: nextMode });
  renderUi();
  try {
    const res = await orca.plugin.request('botWorld.setAtmosphereMode', {
      atmosphereMode: nextMode,
    });
    state.payload = { ...state.payload, atmosphereMode: res.atmosphereMode };
    livePayload = state.payload;
    renderUi();
  } catch {
    // Document change is already persisted locally in .botworld
  }
}

async function toggleRedact(): Promise<void> {
  if (isDemoMode()) {
    demoRedactMode = !demoRedactMode;
    syncDemoTick(false, true);
    return;
  }
  const nextRedact = !activeRedactMode();
  updateDocumentPrefs({ redactMode: nextRedact });
  renderUi(true);
  try {
    const res = await orca.plugin.request('botWorld.setRedactMode', { redactMode: nextRedact });
    state.payload = { ...state.payload, redactMode: res.redactMode };
    livePayload = state.payload;
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
  if (isDemoMode()) {
    demoLanguageSetting = nextLanguage;
    syncDemoTick(false, true);
    return;
  }
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
    livePayload = state.payload;
    renderUi(true);
    const fresh = await orca.plugin.request('botWorld.getState', { locale: getHostLocale() });
    applyIncomingPayload(fresh);
  } catch {
    // Ignore
  }
}

async function setBotAppearance(botId: string, characterId: CharacterId): Promise<void> {
  if (!isSafeKey(botId)) return;
  if (isDemoMode()) {
    Object.defineProperty(demoAppearances, botId, {
      value: characterId,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    syncDemoTick(false, true);
    return;
  }
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
    livePayload = state.payload;
    renderUi();
  } catch {
    // Ignore
  }
}

async function triggerRefresh(): Promise<void> {
  if (isDemoMode()) {
    syncDemoTick(true, true);
    return;
  }
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

const handleKeyDown = (ev: KeyboardEvent): void => {
  if (shouldIgnoreShortcutEvent(ev)) return;
  const action = mapKeyToShortcutAction(ev.key, { isEditor: true });
  if (!action) return;
  switch (action) {
    case 'toggleTheme': {
      const nextTheme: ThemeId =
        activeThemeId() === 'startup_office' ? 'corporate_office' : 'startup_office';
      void switchTheme(nextTheme).catch(() => {});
      break;
    }
    case 'toggleRedact':
      void toggleRedact().catch(() => {});
      break;
    case 'toggleLanguage':
      void toggleLanguage().catch(() => {});
      break;
    case 'cycleAtmosphere':
      void cycleAtmosphere().catch(() => {});
      break;
    case 'toggleDemo':
      if (isDemoMode()) exitDemoMode();
      else enterDemoMode();
      break;
    case 'toggleReplayPlay': {
      ev.preventDefault();
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
      break;
    }
    case 'toggleHelp':
      state.shortcutsOpen = !state.shortcutsOpen;
      renderShortcutsHelp();
      syncChromeLocale(currentLocale());
      break;
    case 'closeOrClearSelection':
      if (state.shortcutsOpen) {
        state.shortcutsOpen = false;
        renderShortcutsHelp();
        syncChromeLocale(currentLocale());
      } else {
        state.selectionCleared = true;
        if (isDemoMode()) {
          demoSelectedBotId = null;
        } else {
          updateDocumentPrefs({ selectedBotId: null });
        }
        renderUi(true);
      }
      break;
  }
};

window.addEventListener('keydown', handleKeyDown);

let cleanedUp = false;
function cleanup(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  if (demoTimerId !== null) {
    clearInterval(demoTimerId);
    demoTimerId = null;
  }
  if (replayTimerId !== null) {
    cancelAnimationFrame(replayTimerId);
    replayTimerId = null;
  }
  window.removeEventListener('keydown', handleKeyDown);
  docSession?.dispose();
  renderer.dispose();
}

window.addEventListener('beforeunload', cleanup);
window.addEventListener('pagehide', cleanup);

void boot().catch(() => {});
