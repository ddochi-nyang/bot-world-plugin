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
  type DeskCoordinate,
  type LanguageSetting,
  type SoundMode,
  type TeamZone,
  type ThemeId,
  type UiLocale,
  VALID_THEME_IDS,
  type WeatherMode,
  type WorldSnapshot,
  type ZoneColor,
  createEmptySnapshot,
  isSafeKey,
  isValidThemeId,
} from '../src/types.ts';
import { getThemeConfig } from '../shared/assets-catalog.ts';
import {
  renderBotDetail,
  renderEventTimelineList,
} from '../shared/bot-detail-view.ts';
import {
  CAMERA_ZOOM_STEP,
  pickNextFocusBotId,
  resolveFollowTargetBotId,
} from '../shared/camera.ts';
import { buildCollabNetwork } from '../shared/collab-network.ts';
import { type DemoOfficeSession, createDemoOfficeSession } from '../shared/demo-office.ts';
import { clearChildren, el } from '../shared/dom.ts';
import {
  STATUS_FILTER_PRESETS,
  type StatusFilterPreset,
  countFilterPresets,
  filterBotIds,
  isFilterActive,
} from '../shared/filter.ts';
import { effectiveLocale, getHostLocale, resolveUiLocale, tStrings } from '../shared/i18n.ts';
import {
  MilestoneTracker,
  MotionDirector,
  REPLAY_SPEEDS,
  ReplayController,
  type ReplaySpeed,
} from '../shared/motion.ts';
import { computeOfficeBadges } from '../shared/office-badges.ts';
import {
  buildOfficeReport,
  formatReportMarkdown,
  renderOfficeReportModal,
} from '../shared/office-report.ts';
import { capturePhotoCard } from '../shared/photo-card.ts';
import {
  atmosphereIcon,
  mapKeyToShortcutAction,
  nextAtmosphereMode,
  nextSoundMode,
  nextThemeId,
  nextWeatherMode,
  renderShortcutsModal,
  shouldIgnoreShortcutEvent,
  soundIcon,
  weatherIcon,
} from '../shared/shortcuts.ts';
import { SoundscapeEngine } from '../shared/soundscape.ts';
import { StageRenderer, resolveAtmospherePhase } from '../shared/stage-renderer.ts';
import { TimelapseController } from '../shared/timelapse.ts';
import { resolveWeatherKind } from '../shared/weather.ts';
import {
  cloneStarterTeamZones,
  createNextZonePlacement,
  renderZonesModal,
  zonesModalRenderKey,
} from '../shared/zones.ts';
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
  reportOpen: boolean;
  zonesOpen: boolean;
  reportCopied: boolean;
  selectionCleared: boolean;
  filterPreset: StatusFilterPreset;
  searchQuery: string;
  showCollabNetwork: boolean;
} = {
  payload: {
    snapshot: createEmptySnapshot(),
    events: [],
    keyframes: [],
    activeTheme: 'startup_office',
    atmosphereMode: 'auto',
    weatherMode: 'auto',
    soundMode: 'off',
    redactMode: false,
    botAppearances: {},
    pollIntervalSec: 5,
    locale: initialLocale,
    languageSetting: 'auto',
    weeklyTrend: [],
  },
  docData: {
    ...DEFAULT_BOTWORLD_DOCUMENT,
    botAppearances: {},
    customDeskPositions: {},
    zones: [],
    showZones: true,
  },
  hoveredBotId: null,
  eventsDrawerOpen: true,
  shortcutsOpen: false,
  reportOpen: false,
  zonesOpen: false,
  reportCopied: false,
  selectionCleared: false,
  filterPreset: 'all',
  searchQuery: '',
  showCollabNetwork: false,
};

let docSession: Awaited<ReturnType<typeof startBotWorldDocSession>> | null = null;
const liveMotion = new MotionDirector();
const replay = new ReplayController();
const timelapse = new TimelapseController();
const soundscape = new SoundscapeEngine();
const liveMilestones = new MilestoneTracker();
const demoMilestones = new MilestoneTracker();
let prevLiveSnapshot: WorldSnapshot = createEmptySnapshot();
let livePayload: BotWorldStatePayload = state.payload;
let replayTimerId: number | null = null;
let lastReplayTickMs = 0;
let reportCopiedTimer: number | null = null;
let followNoticeTimer: number | null = null;
let followNoticeActive = false;
let stageToastTimer: number | null = null;

let demoSession: DemoOfficeSession | null = null;
let demoTimerId: number | null = null;
let demoThemeId: ThemeId = 'startup_office';
let demoAtmosphereMode: AtmosphereMode = 'auto';
let demoWeatherMode: WeatherMode = 'auto';
let demoSoundMode: SoundMode = 'off';
let demoRedactMode = false;
let demoLanguageSetting: LanguageSetting = 'auto';
let demoAppearances: Record<string, CharacterId> = {};
let demoCustomPositions: Record<string, DeskCoordinate> = {};
let demoZones: TeamZone[] = [];
let demoShowZones = true;
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
const themeOptions = new Map<ThemeId, HTMLOptionElement>();
const themeSelect = el('select', {
  className: 'bw-select',
  ariaLabel: initialStrings.themeAriaLabel,
  title: initialStrings.themeToggleTitle,
  onChange: () => {
    const val = themeSelect.value;
    if (isValidThemeId(val)) {
      void switchTheme(val).catch(() => {});
    }
  },
}) as HTMLSelectElement;
for (const tid of VALID_THEME_IDS) {
  const opt = el(
    'option',
    { value: tid, selected: tid === 'startup_office' },
    initialStrings.themeFull[tid]
  ) as HTMLOptionElement;
  themeOptions.set(tid, opt);
  themeSelect.appendChild(opt);
}

const resetSeatsBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn bw-hidden',
    title: initialStrings.resetSeatsTitle,
    onClick: () => resetCustomSeats(),
  },
  initialStrings.resetSeats
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

const weatherBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn',
    ariaLabel: initialStrings.weatherAriaLabel,
    onClick: () => void cycleWeather().catch(() => {}),
  },
  `${weatherIcon('auto')} ${initialStrings.weatherModes.auto}`
);

const soundBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn',
    ariaLabel: initialStrings.soundAriaLabel,
    onClick: () => void cycleSound(true).catch(() => {}),
  },
  `${soundIcon('off')} ${initialStrings.soundModes.off}`
);

const focusBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn',
    title: initialStrings.focusButtonTitle,
    ariaLabel: initialStrings.focusButtonTitle,
    onClick: () => cycleFocusSpotlight(),
  },
  `🎯 ${initialStrings.focusButton}`
);

const collabBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn',
    title: initialStrings.collabButtonTitle,
    ariaLabel: initialStrings.collabButtonTitle,
    onClick: () => {
      state.showCollabNetwork = !state.showCollabNetwork;
      renderUi();
    },
  },
  `🕸 ${initialStrings.collabButton}`
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

const reportBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn',
    title: initialStrings.reportButtonTitle,
    ariaLabel: initialStrings.reportButtonTitle,
    onClick: () => toggleReportModal(),
  },
  initialStrings.reportButton
);

const zonesBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn',
    title: initialStrings.zonesButtonTitle,
    ariaLabel: initialStrings.zonesButtonTitle,
    onClick: () => toggleZonesModal(),
  },
  `🗺 ${initialStrings.zonesButton}`
);

const photoBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn',
    title: initialStrings.photoButtonTitle,
    ariaLabel: initialStrings.photoButtonTitle,
    onClick: () => void triggerPhotoCardSnapshot().catch(() => {}),
  },
  `📸 ${initialStrings.photoButton}`
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
      if (state.shortcutsOpen) {
        state.reportOpen = false;
        state.zonesOpen = false;
        renderReportModal();
        renderZonesManager();
      }
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
    themeSelect,
    resetSeatsBtn,
    atmoBtn,
    weatherBtn,
    soundBtn,
    focusBtn,
    collabBtn,
    zonesBtn,
    photoBtn,
    redactBtn,
    langBtn,
    demoBtn,
    reportBtn,
    helpBtn,
    refreshBtn
  )
);

// Filter & Search bar
const filterChipButtons = new Map<StatusFilterPreset, HTMLButtonElement>();
const filterChipsWrap = el('div', { className: 'bw-filter-chips' });
for (const preset of STATUS_FILTER_PRESETS) {
  const btn = el(
    'button',
    {
      type: 'button',
      className: preset === 'all' ? 'bw-filter-chip bw-filter-chip-active' : 'bw-filter-chip',
      onClick: () => {
        state.filterPreset = preset;
        renderUi();
      },
    },
    `${initialStrings.filterPresetLabels[preset]} (0)`
  ) as HTMLButtonElement;
  filterChipButtons.set(preset, btn);
  filterChipsWrap.appendChild(btn);
}

const searchInput = el('input', {
  type: 'text',
  className: 'bw-search-input',
  placeholder: initialStrings.searchPlaceholder,
  ariaLabel: initialStrings.searchPlaceholder,
  onInput: () => {
    state.searchQuery = searchInput.value;
    renderUi();
  },
}) as HTMLInputElement;

const searchClearBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn bw-btn-ghost bw-hidden',
    title: initialStrings.searchClearTitle,
    ariaLabel: initialStrings.searchClearTitle,
    onClick: () => {
      state.searchQuery = '';
      searchInput.value = '';
      renderUi();
    },
  },
  '✕'
) as HTMLButtonElement;

const filterMatchPill = el('span', { className: 'bw-filter-match-pill bw-hidden' }, '0/0');
const filterBar = el(
  'div',
  { className: 'bw-filter-bar' },
  filterChipsWrap,
  el('div', { className: 'bw-filter-search-wrap' }, filterMatchPill, searchInput, searchClearBtn)
);

// Main 2-column area
const canvasEl = el('canvas', { className: 'bw-stage-canvas' }) as HTMLCanvasElement;
const stageOverlayNote = el('div', { className: 'bw-stage-overlay-note' }, initialStrings.live);
const stageToast = el('div', { className: 'bw-stage-toast bw-hidden' });
const zoomOutBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-hud-btn',
    title: initialStrings.zoomOutTitle,
    ariaLabel: initialStrings.zoomOutTitle,
    onClick: () => renderer.zoomBy(-CAMERA_ZOOM_STEP),
  },
  '−'
);
const zoomResetBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-hud-btn',
    title: initialStrings.zoomResetTitle(100),
    onClick: () => renderer.resetCamera(),
  },
  '100%'
);
const zoomInBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-hud-btn',
    title: initialStrings.zoomInTitle,
    ariaLabel: initialStrings.zoomInTitle,
    onClick: () => renderer.zoomBy(CAMERA_ZOOM_STEP),
  },
  '+'
);
const followHudBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-hud-btn',
    title: initialStrings.followButtonTitle,
    onClick: () => toggleFollowCam(),
  },
  `📌 ${initialStrings.followButton}`
);
const cameraHud = el(
  'div',
  { className: 'bw-camera-hud' },
  zoomOutBtn,
  zoomResetBtn,
  zoomInBtn,
  followHudBtn
);
const stageWrap = el(
  'div',
  { className: 'bw-stage-wrap-editor' },
  canvasEl,
  stageOverlayNote,
  stageToast,
  cameraHud
);
const detailSidebar = el('div', { className: 'bw-editor-sidebar' });
const editorBody = el('div', { className: 'bw-editor-body' }, stageWrap, detailSidebar);

// Bottom 24h timeline bar
const playBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn',
    onClick: () => {
      timelapse.stop();
      const locale = currentLocale();
      const theme = getThemeConfig(activeThemeId(), locale);
      replay.togglePlay(
        state.payload.keyframes,
        state.payload.events,
        state.payload.snapshot,
        theme,
        locale,
        activeCustomPositions()
      );
      syncReplayLoop();
      renderUi();
    },
  },
  initialStrings.play
);

const timelapseBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn',
    title: initialStrings.timelapseButtonTitle,
    ariaLabel: initialStrings.timelapseButtonTitle,
    onClick: () => toggleTimelapse(),
  },
  `⏱ ${initialStrings.timelapseButton}`
);

const liveBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn bw-btn-active',
    onClick: () => {
      timelapse.stop();
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
    timelapse.stop();
    const frac = Number(scrubber.value) / 1000;
    const locale = currentLocale();
    const theme = getThemeConfig(activeThemeId(), locale);
    replay.seekFraction(
      frac,
      state.payload.keyframes,
      state.payload.events,
      state.payload.snapshot,
      theme,
      locale,
      activeCustomPositions()
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
  timelapseBtn,
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
    syncChromeLocale(currentLocale());
  },
});
const reportBackdrop = el('div', {
  className: 'bw-modal-backdrop bw-hidden',
  onClick: () => {
    state.reportOpen = false;
    renderReportModal();
    syncChromeLocale(currentLocale());
  },
});
const zonesBackdrop = el('div', {
  className: 'bw-modal-backdrop bw-hidden',
  onClick: () => {
    state.zonesOpen = false;
    renderZonesManager();
    syncChromeLocale(currentLocale());
  },
});

root.appendChild(toolbar);
root.appendChild(filterBar);
root.appendChild(demoHintBanner);
root.appendChild(editorBody);
root.appendChild(timelineBar);
root.appendChild(shortcutsBackdrop);
root.appendChild(reportBackdrop);
root.appendChild(zonesBackdrop);

const renderer = new StageRenderer(canvasEl, {
  onSelectBot: (botId) => {
    state.selectionCleared = false;
    if (isDemoMode()) {
      demoSelectedBotId = botId;
    } else {
      updateDocumentPrefs({ selectedBotId: botId });
    }
    if (renderer.camera.followBotId && renderer.camera.followBotId !== botId) {
      renderer.camera.setFollowBot(botId);
    }
    renderUi();
  },
  onHoverBot: (botId) => {
    if (state.hoveredBotId !== botId) {
      state.hoveredBotId = botId;
      updateStageOverlayLabel();
    }
  },
  onMoveBot: (botId, pos) => {
    if (!isSafeKey(botId)) return;
    if (isDemoMode()) {
      demoCustomPositions = { ...demoCustomPositions, [botId]: pos };
    } else {
      const nextPositions = { ...(state.docData.customDeskPositions ?? {}) };
      Object.defineProperty(nextPositions, botId, {
        value: pos,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      updateDocumentPrefs({ customDeskPositions: nextPositions });
    }
    renderUi();
  },
  onCameraChange: () => {
    updateCameraHud(currentLocale());
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

function activeWeatherMode(): WeatherMode {
  if (isDemoMode()) return demoWeatherMode;
  return state.docData.weatherMode ?? state.payload.weatherMode ?? 'auto';
}

function activeSoundMode(): SoundMode {
  if (isDemoMode()) return demoSoundMode;
  return state.payload.soundMode ?? 'off';
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

function activeCustomPositions(): Record<string, DeskCoordinate> {
  if (isDemoMode()) return demoCustomPositions;
  return state.docData.customDeskPositions ?? {};
}

function activeZones(): TeamZone[] {
  if (isDemoMode()) return demoZones;
  return state.docData.zones ?? [];
}

function activeShowZones(): boolean {
  if (isDemoMode()) return demoShowZones;
  return state.docData.showZones !== false;
}

function setZonesState(nextZones: TeamZone[], nextShow?: boolean): void {
  if (isDemoMode()) {
    demoZones = nextZones;
    if (nextShow !== undefined) demoShowZones = nextShow;
  } else {
    updateDocumentPrefs({
      zones: nextZones,
      ...(nextShow !== undefined ? { showZones: nextShow } : {}),
    });
  }
  renderUi();
}

function toggleZonesVisibility(): void {
  const nextShow = !activeShowZones();
  if (isDemoMode()) {
    demoShowZones = nextShow;
  } else {
    updateDocumentPrefs({ showZones: nextShow });
  }
  renderUi();
}

function resetCustomSeats(): void {
  if (isDemoMode()) {
    demoCustomPositions = {};
  } else {
    updateDocumentPrefs({ customDeskPositions: {} });
  }
  renderUi();
}

function currentDisplayedSnapshot(): WorldSnapshot {
  return replay.isReplay ? replay.snapshot : state.payload.snapshot;
}

function updateDocumentPrefs(patch: Partial<BotWorldDocumentData>): void {
  const next: BotWorldDocumentData = {
    version: 1,
    themeId: patch.themeId ?? state.docData.themeId,
    atmosphereMode: patch.atmosphereMode ?? state.docData.atmosphereMode ?? 'auto',
    weatherMode: patch.weatherMode ?? state.docData.weatherMode ?? 'auto',
    redactMode: patch.redactMode ?? state.docData.redactMode,
    selectedBotId:
      patch.selectedBotId !== undefined ? patch.selectedBotId : state.docData.selectedBotId,
    botAppearances: patch.botAppearances ?? { ...state.docData.botAppearances },
    customDeskPositions:
      patch.customDeskPositions ?? { ...(state.docData.customDeskPositions ?? {}) },
    zones: patch.zones ?? [...(state.docData.zones ?? [])],
    showZones: patch.showZones !== undefined ? patch.showZones : (state.docData.showZones !== false),
  };
  state.docData = next;
  if (docSession && !docSession.readOnly) {
    docSession.change(next);
  }
}

function showStageToast(message: string): void {
  stageToast.textContent = message;
  stageToast.classList.remove('bw-hidden');
  if (stageToastTimer !== null) {
    clearTimeout(stageToastTimer);
  }
  stageToastTimer = window.setTimeout(() => {
    stageToast.classList.add('bw-hidden');
    stageToastTimer = null;
  }, 2200);
}

async function triggerPhotoCardSnapshot(): Promise<void> {
  renderer.renderNow();
  const locale = currentLocale();
  const s = tStrings(locale);
  const snap = currentDisplayedSnapshot();
  const timestampMs = replay.isReplay
    ? replay.cursorMs
    : snap.capturedAt > 0
      ? snap.capturedAt
      : Date.now();
  const res = await capturePhotoCard(canvasEl, {
    snapshot: snap,
    events: state.payload.events,
    themeId: activeThemeId(),
    atmosphereMode: activeAtmosphereMode(),
    weatherMode: activeWeatherMode(),
    redactMode: activeRedactMode(),
    locale,
    timestampMs,
  });
  if (res.ok) {
    showStageToast(s.photoSavedToast);
  }
}

function showFollowNoMatchNotice(): void {
  followNoticeActive = true;
  if (followNoticeTimer !== null) {
    clearTimeout(followNoticeTimer);
  }
  updateStageOverlayLabel();
  followNoticeTimer = window.setTimeout(() => {
    followNoticeActive = false;
    followNoticeTimer = null;
    updateStageOverlayLabel();
  }, 2400);
}

function updateStageOverlayLabel(): void {
  const locale = currentLocale();
  const s = tStrings(locale);
  if (followNoticeActive) {
    stageOverlayNote.textContent = s.followNoMatchNotice;
    return;
  }
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
      syncChromeLocale(currentLocale());
    },
  });
}

async function copyReportMarkdown(text: string): Promise<void> {
  let ok = false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch {
    ok = false;
  }
  if (!ok && typeof document !== 'undefined' && typeof document.execCommand === 'function') {
    let ta: HTMLTextAreaElement | null = null;
    try {
      ta = document.createElement('textarea');
      ta.value = text;
      ta.className = 'bw-sr-only';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    } finally {
      if (ta && ta.parentNode) {
        document.body.removeChild(ta);
      }
    }
  }
  if (ok) {
    state.reportCopied = true;
    renderReportModal();
    if (reportCopiedTimer !== null) {
      clearTimeout(reportCopiedTimer);
    }
    reportCopiedTimer = window.setTimeout(() => {
      state.reportCopied = false;
      reportCopiedTimer = null;
      if (state.reportOpen) {
        renderReportModal();
      }
    }, 1800);
  }
}

function renderReportModal(): void {
  if (!state.reportOpen) {
    clearChildren(reportBackdrop);
    reportBackdrop.classList.add('bw-hidden');
    return;
  }
  const locale = currentLocale();
  const redactMode = activeRedactMode();
  const report = buildOfficeReport(state.payload.events, state.payload.snapshot, {
    redactMode,
    locale,
    weeklyTrend: state.payload.weeklyTrend,
  });
  renderOfficeReportModal(reportBackdrop, {
    open: state.reportOpen,
    report,
    redactMode,
    locale,
    copied: state.reportCopied,
    onCopyMarkdown: () => {
      const md = formatReportMarkdown(report, { redactMode, locale });
      void copyReportMarkdown(md).catch(() => {});
    },
    onClose: () => {
      state.reportOpen = false;
      renderReportModal();
      syncChromeLocale(currentLocale());
    },
  });
}

function toggleReportModal(): void {
  state.reportOpen = !state.reportOpen;
  if (state.reportOpen) {
    state.shortcutsOpen = false;
    state.zonesOpen = false;
    state.reportCopied = false;
    renderShortcutsHelp();
    renderZonesManager();
  }
  renderReportModal();
  syncChromeLocale(currentLocale());
}

let lastZonesModalKey: string | null = null;

function renderZonesManager(): void {
  const open = state.zonesOpen;
  const zones = activeZones();
  const showZones = activeShowZones();
  const redactMode = activeRedactMode();
  const locale = currentLocale();
  const demoMode = isDemoMode();
  const nextKey = zonesModalRenderKey({
    open,
    zones,
    showZones,
    redactMode,
    locale,
    demoMode,
    persisted: true,
  });
  if (nextKey === lastZonesModalKey) {
    return;
  }
  lastZonesModalKey = nextKey;
  renderZonesModal(zonesBackdrop, {
    open,
    zones,
    showZones,
    redactMode,
    locale,
    persisted: true,
    onToggleShowZones: () => toggleZonesVisibility(),
    onLoadStarterPreset: () => setZonesState(cloneStarterTeamZones(), true),
    onAddZone: (label: string, color: ZoneColor) => {
      const current = activeZones();
      const next = createNextZonePlacement(current, label, color);
      if (next) {
        setZonesState([...current, next], true);
      }
    },
    onDeleteZone: (zoneId: string) => {
      setZonesState(activeZones().filter((z) => z.id !== zoneId));
    },
    onClearZones: () => setZonesState([]),
    onClose: () => {
      state.zonesOpen = false;
      renderZonesManager();
      syncChromeLocale(currentLocale());
    },
  });
}

function toggleZonesModal(): void {
  state.zonesOpen = !state.zonesOpen;
  if (state.zonesOpen) {
    state.shortcutsOpen = false;
    state.reportOpen = false;
    renderShortcutsHelp();
    renderReportModal();
  }
  renderZonesManager();
  syncChromeLocale(currentLocale());
}

function toggleTimelapse(): void {
  if (timelapse.active) {
    timelapse.stop();
    syncReplayLoop();
    renderUi();
    return;
  }
  const locale = currentLocale();
  const theme = getThemeConfig(activeThemeId(), locale);
  const bounds = replay.timeBounds(state.payload.keyframes, state.payload.events);
  const fallbackMs =
    state.payload.snapshot.capturedAt > 0 ? state.payload.snapshot.capturedAt : Date.now();
  const start = timelapse.start(bounds, fallbackMs);
  replay.isPlaying = false;
  replay.seekTo(
    start.cursorMs,
    state.payload.keyframes,
    state.payload.events,
    state.payload.snapshot,
    theme,
    locale,
    activeCustomPositions()
  );
  syncReplayLoop();
  renderUi();
}

function updateCameraHud(locale: UiLocale): void {
  const s = tStrings(locale);
  const pct = renderer.camera.zoomPercent();
  zoomResetBtn.textContent = `${pct}%`;
  zoomResetBtn.title = s.zoomResetTitle(pct);
  zoomResetBtn.className = renderer.camera.isZoomed() ? 'bw-hud-btn bw-hud-btn-active' : 'bw-hud-btn';
  zoomOutBtn.title = s.zoomOutTitle;
  zoomOutBtn.setAttribute('aria-label', s.zoomOutTitle);
  zoomInBtn.title = s.zoomInTitle;
  zoomInBtn.setAttribute('aria-label', s.zoomInTitle);
  const following = renderer.camera.followBotId !== null;
  followHudBtn.textContent = `📌 ${following ? s.followButtonActive : s.followButton}`;
  followHudBtn.title = s.followButtonTitle;
  followHudBtn.className = following ? 'bw-hud-btn bw-hud-btn-active' : 'bw-hud-btn';
}

function cycleFocusSpotlight(): void {
  const snap = currentDisplayedSnapshot();
  const locale = currentLocale();
  const redactMode = activeRedactMode();
  const activeFilter = isFilterActive(state.filterPreset, state.searchQuery)
    ? filterBotIds(snap, {
        preset: state.filterPreset,
        query: state.searchQuery,
        redactMode,
        locale,
      })
    : undefined;
  const currentId = renderer.camera.spotlightBotId ?? resolveSelectedBotId(snap);
  const nextId = pickNextFocusBotId(snap, currentId, activeFilter);
  if (!nextId) return;
  state.selectionCleared = false;
  if (isDemoMode()) {
    demoSelectedBotId = nextId;
  } else {
    updateDocumentPrefs({ selectedBotId: nextId });
  }
  renderUi();
  renderer.focusBot(nextId);
}

function toggleFollowCam(): void {
  const snap = currentDisplayedSnapshot();
  const locale = currentLocale();
  const redactMode = activeRedactMode();
  const activeFilter = isFilterActive(state.filterPreset, state.searchQuery)
    ? filterBotIds(snap, {
        preset: state.filterPreset,
        query: state.searchQuery,
        redactMode,
        locale,
      })
    : null;

  const currentFollow = renderer.camera.followBotId;
  if (currentFollow !== null) {
    if (activeFilter && activeFilter.size === 0) {
      renderer.camera.releaseFollow();
      showFollowNoMatchNotice();
      renderUi();
      return;
    }
    if (!activeFilter || activeFilter.has(currentFollow)) {
      renderer.toggleFollow(currentFollow);
      renderUi();
      return;
    }
  }

  const selectedId = resolveSelectedBotId(snap);
  const targetId = resolveFollowTargetBotId(snap, selectedId, activeFilter);
  if (!targetId) {
    showFollowNoMatchNotice();
    renderUi();
    return;
  }
  if (targetId !== selectedId) {
    state.selectionCleared = false;
    if (isDemoMode()) {
      demoSelectedBotId = targetId;
    } else {
      updateDocumentPrefs({ selectedBotId: targetId });
    }
  }
  renderer.toggleFollow(targetId);
  renderUi();
}

function syncChromeLocale(locale: UiLocale): void {
  const s = tStrings(locale);
  const atmoMode = activeAtmosphereMode();
  const atmoLabel = s.atmosphereModes[atmoMode];
  const wMode = activeWeatherMode();
  const wLabel = s.weatherModes[wMode];
  const sndMode = activeSoundMode();
  const sndLabel = s.soundModes[sndMode];
  document.documentElement.lang = locale;
  document.title = s.appTitleEditor;
  titleEl.textContent = s.appTitleEditor;
  for (const [tid, opt] of themeOptions.entries()) {
    opt.textContent = s.themeFull[tid];
  }
  themeSelect.setAttribute('aria-label', s.themeAriaLabel);
  themeSelect.title = s.themeToggleTitle;
  resetSeatsBtn.textContent = s.resetSeats;
  resetSeatsBtn.title = s.resetSeatsTitle;
  atmoBtn.textContent = `${atmosphereIcon(atmoMode)} ${atmoLabel}`;
  atmoBtn.title = s.atmosphereToggleTitle(atmoLabel);
  atmoBtn.className = atmoMode !== 'auto' ? 'bw-btn bw-btn-active' : 'bw-btn';
  weatherBtn.textContent = `${weatherIcon(wMode)} ${wLabel}`;
  weatherBtn.title = s.weatherToggleTitle(wLabel);
  weatherBtn.className = wMode !== 'auto' ? 'bw-btn bw-btn-active' : 'bw-btn';
  soundBtn.textContent = `${soundIcon(sndMode)} ${sndLabel}`;
  soundBtn.title = s.soundToggleTitle(sndLabel);
  soundBtn.className = sndMode !== 'off' ? 'bw-btn bw-btn-active' : 'bw-btn';
  focusBtn.textContent = `🎯 ${s.focusButton}`;
  focusBtn.title = s.focusButtonTitle;
  focusBtn.setAttribute('aria-label', s.focusButtonTitle);
  collabBtn.textContent = `🕸 ${s.collabButton}`;
  collabBtn.title = s.collabButtonTitle;
  collabBtn.setAttribute('aria-label', s.collabButtonTitle);
  collabBtn.className = state.showCollabNetwork ? 'bw-btn bw-btn-active' : 'bw-btn';
  zonesBtn.textContent = `🗺 ${s.zonesButton}`;
  zonesBtn.title = s.zonesButtonTitle;
  zonesBtn.setAttribute('aria-label', s.zonesButtonTitle);
  zonesBtn.className =
    state.zonesOpen || (activeShowZones() && activeZones().length > 0)
      ? 'bw-btn bw-btn-active'
      : 'bw-btn';
  photoBtn.textContent = `📸 ${s.photoButton}`;
  photoBtn.title = s.photoButtonTitle;
  photoBtn.setAttribute('aria-label', s.photoButtonTitle);
  redactBtn.title = s.redactToggleTitle;
  langBtn.textContent = s.langToggleText;
  langBtn.title = `${s.langToggleTitle} [L]`;
  langBtn.setAttribute('aria-label', s.langToggleTitle);
  demoBtn.textContent = isDemoMode() ? s.exitDemoOffice : s.demoButton;
  demoBtn.title = s.demoToggleTitle;
  demoBtn.className = isDemoMode() ? 'bw-btn bw-btn-active' : 'bw-btn';
  reportBtn.textContent = s.reportButton;
  reportBtn.title = s.reportButtonTitle;
  reportBtn.setAttribute('aria-label', s.reportButtonTitle);
  reportBtn.className = state.reportOpen ? 'bw-btn bw-btn-active' : 'bw-btn';
  helpBtn.title = s.shortcutsButtonTitle;
  helpBtn.setAttribute('aria-label', s.shortcutsButtonTitle);
  helpBtn.className = state.shortcutsOpen ? 'bw-btn bw-btn-active' : 'bw-btn';
  searchInput.placeholder = s.searchPlaceholder;
  searchInput.setAttribute('aria-label', s.searchPlaceholder);
  searchClearBtn.title = s.searchClearTitle;
  searchClearBtn.setAttribute('aria-label', s.searchClearTitle);
  updateCameraHud(locale);
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
  themeSelect.value = themeId;
  const hasCustomSeats = Object.keys(activeCustomPositions()).length > 0;
  resetSeatsBtn.classList.toggle('bw-hidden', !hasCustomSeats);

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
  timelapseBtn.textContent = timelapse.active
    ? `⏱ ${timelapse.formatProgress()}`
    : `⏱ ${s.timelapseButton}`;
  timelapseBtn.title = s.timelapseButtonTitle;
  timelapseBtn.setAttribute('aria-label', s.timelapseButtonTitle);
  timelapseBtn.className = timelapse.active ? 'bw-btn bw-btn-active' : 'bw-btn';
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

function renderFilterBarOnly(
  snap: WorldSnapshot,
  redactMode: boolean,
  locale: UiLocale
): ReadonlySet<string> | null {
  const s = tStrings(locale);
  const counts = countFilterPresets(snap);
  for (const preset of STATUS_FILTER_PRESETS) {
    const btn = filterChipButtons.get(preset);
    if (!btn) continue;
    btn.textContent = `${s.filterPresetLabels[preset]} (${counts[preset]})`;
    btn.className =
      state.filterPreset === preset ? 'bw-filter-chip bw-filter-chip-active' : 'bw-filter-chip';
  }
  searchClearBtn.classList.toggle('bw-hidden', state.searchQuery.length === 0);
  if (isFilterActive(state.filterPreset, state.searchQuery)) {
    const matched = filterBotIds(snap, {
      preset: state.filterPreset,
      query: state.searchQuery,
      redactMode,
      locale,
    });
    filterMatchPill.textContent = s.filterMatchCount(matched.size, counts.all);
    filterMatchPill.classList.remove('bw-hidden');
    return matched;
  }
  filterMatchPill.classList.add('bw-hidden');
  return null;
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
  const filterMatchedBotIds = renderFilterBarOnly(snap, redactMode, locale);
  const collabEdges = state.showCollabNetwork
    ? buildCollabNetwork(state.payload.events, snap, { nowMs: displayTimestampMs })
    : [];
  const badgeSummary = computeOfficeBadges(state.payload.events, snap, {
    nowMs: displayTimestampMs,
    redactMode,
    locale,
  });
  updateStageOverlayLabel();
  const atmoMode = activeAtmosphereMode();
  const wMode = activeWeatherMode();
  const phase = resolveAtmospherePhase(atmoMode, displayTimestampMs);
  const wKind = resolveWeatherKind(wMode, phase, themeId);
  soundscape.updateAmbientContext(wKind, phase, themeId);
  renderer.update({
    snapshot: snap,
    themeId,
    atmosphereMode: atmoMode,
    weatherMode: wMode,
    displayTimestampMs,
    selectedBotId: selectedId,
    redactMode,
    botAppearances: appearances,
    customDeskPositions: activeCustomPositions(),
    motion: replay.isReplay ? replay.motion : liveMotion,
    replay,
    locale,
    filterMatchedBotIds,
    showCollabNetwork: state.showCollabNetwork,
    collabEdges,
    mvpBotId: badgeSummary.mvpBotId,
    zones: activeZones(),
    showZones: activeShowZones(),
    timelapseActive: timelapse.active,
  });
}

let lastDetailDemoMode: boolean | null = null;
let lastDetailBotsRef: WorldSnapshot['bots'] | null = null;
let lastDetailWorkersRef: WorldSnapshot['workers'] | null = null;
let lastDetailItemsRef: WorldSnapshot['items'] | null = null;
let lastDetailAutosRef: WorldSnapshot['automations'] | null = null;
let lastDetailMsgsRef: WorldSnapshot['recentMessages'] | null = null;
let lastDetailEventsRef: BotWorldStatePayload['events'] | null = null;
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
    state.payload.events !== lastDetailEventsRef ||
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
    lastDetailEventsRef = state.payload.events;
    lastDetailConnected = snap.runtime.connected;
    lastDetailSelectedId = selectedId;
    lastDetailRedact = redactMode;
    lastDetailLocale = locale;
    lastDetailAppearancesJson = appearancesJson;

    const selectedBot =
      selectedId && isSafeKey(selectedId) && Object.hasOwn(snap.bots, selectedId)
        ? snap.bots[selectedId]
        : null;
    const badgeSummary = computeOfficeBadges(state.payload.events, snap, {
      redactMode,
      locale,
    });

    renderBotDetail(detailSidebar, {
      snapshot: snap,
      bot: selectedBot,
      redactMode,
      botAppearances: appearances,
      locale,
      botCount: Object.keys(snap.bots).length,
      badges: selectedBot ? (badgeSummary.badgesByBot[selectedBot.id] ?? []) : [],
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
          timelapse.stop();
          const curLocale = currentLocale();
          replay.seekTo(
            ts,
            state.payload.keyframes,
            state.payload.events,
            state.payload.snapshot,
            getThemeConfig(activeThemeId(), curLocale),
            curLocale,
            activeCustomPositions()
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
  if ((replay.isReplay && replay.isPlaying) || timelapse.active) {
    if (replayTimerId === null) {
      lastReplayTickMs = performance.now();
      const tick = (nowMs: number) => {
        if ((!replay.isReplay || !replay.isPlaying) && !timelapse.active) {
          replayTimerId = null;
          return;
        }
        const dtMs = Math.max(0, Math.min(250, nowMs - lastReplayTickMs));
        const dtSecs = dtMs / 1000;
        lastReplayTickMs = nowMs;
        const themeId = activeThemeId();
        const locale = currentLocale();
        const theme = getThemeConfig(themeId, locale);

        if (timelapse.active) {
          const stepRes = timelapse.advance(dtMs);
          replay.advanceToTimestamp(
            stepRes.cursorMs,
            dtSecs,
            state.payload.keyframes,
            state.payload.events,
            state.payload.snapshot,
            theme,
            locale,
            activeCustomPositions()
          );
          const displayTs = replay.isReplay
            ? replay.cursorMs
            : state.payload.snapshot.capturedAt || Date.now();
          const phase = resolveAtmospherePhase(activeAtmosphereMode(), displayTs);
          const wKind = resolveWeatherKind(activeWeatherMode(), phase, themeId);
          renderer.weather.step(dtSecs, wKind, theme.designSize);
        } else {
          replay.step(
            dtSecs,
            state.payload.keyframes,
            state.payload.events,
            state.payload.snapshot,
            theme,
            locale,
            activeCustomPositions()
          );
        }
        const snap = currentDisplayedSnapshot();
        const redactMode = activeRedactMode();
        const appearances = mergedAppearances();
        const selectedId = resolveSelectedBotId(snap);
        renderTimelineControlsOnly(snap, locale);
        renderStageFrame(themeId, redactMode, appearances, snap, selectedId, locale);
        renderSidePanelsIfNeeded(snap, selectedId, redactMode, appearances, locale, false);
        if (replay.isPlaying || timelapse.active) {
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
  renderReportModal();
  renderZonesManager();
}

function buildDemoPayload(): BotWorldStatePayload | null {
  if (!demoSession) return null;
  return demoSession.getPayload({
    themeId: demoThemeId,
    atmosphereMode: demoAtmosphereMode,
    weatherMode: demoWeatherMode,
    soundMode: demoSoundMode,
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
  if (advance && generatedCount > 0 && !replay.isReplay) {
    const newEvents = nextPayload.events.slice(-generatedCount).map((r) => r.event);
    liveMotion.enqueueEvents(newEvents, nextPayload.snapshot, theme, locale, activeCustomPositions());
    const crossed = demoMilestones.evaluateNewEvents(
      newEvents,
      nextPayload.snapshot.capturedAt || Date.now()
    );
    if (crossed !== null) {
      liveMotion.triggerMilestone(crossed, [theme.designSize[0] * 0.5, theme.designSize[1] * 0.24]);
      soundscape.playMilestoneCue({ suppressed: false });
    }
    soundscape.playEvents(newEvents, { suppressed: false });
  }
  state.payload = nextPayload;
  if (replay.isReplay) {
    replay.resyncSnapshot(
      nextPayload.keyframes,
      nextPayload.snapshot,
      theme,
      locale,
      activeCustomPositions()
    );
  }
  renderUi(forceSidePanels);
}

function enterDemoMode(): void {
  if (isDemoMode()) return;
  state.selectionCleared = false;
  demoThemeId = state.docData.themeId ?? livePayload.activeTheme;
  demoAtmosphereMode = state.docData.atmosphereMode ?? livePayload.atmosphereMode ?? 'auto';
  demoWeatherMode = state.docData.weatherMode ?? livePayload.weatherMode ?? 'auto';
  demoSoundMode = livePayload.soundMode ?? 'off';
  demoRedactMode = Boolean(livePayload.redactMode) || Boolean(state.docData.redactMode);
  demoLanguageSetting = livePayload.languageSetting;
  demoAppearances = {};
  demoCustomPositions = {};
  demoZones = (state.docData.zones ?? []).map((z) => ({ ...z }));
  demoShowZones = state.docData.showZones !== false;
  demoSelectedBotId = null;
  demoSession = createDemoOfficeSession();
  timelapse.stop();
  replay.returnToLive();
  liveMotion.clearTransients();
  syncReplayLoop();
  const initialDemo = buildDemoPayload();
  if (initialDemo) {
    state.payload = initialDemo;
    demoSelectedBotId = initialDemo.snapshot.botOrder[0] ?? null;
    demoMilestones.seedBaseline(
      initialDemo.events,
      initialDemo.snapshot.capturedAt || Date.now()
    );
  } else {
    demoMilestones.reset();
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
  demoCustomPositions = {};
  demoZones = [];
  demoShowZones = true;
  demoSelectedBotId = null;
  demoMilestones.reset();
  timelapse.stop();
  replay.returnToLive();
  liveMotion.clearTransients();
  syncReplayLoop();
  state.payload = livePayload;
  soundscape.setMode(livePayload.soundMode ?? 'off', { fromUserGesture: false });
  liveMilestones.seedBaseline(
    livePayload.events,
    livePayload.snapshot.capturedAt || Date.now()
  );
  renderUi(true);
  void triggerRefresh().catch(() => {});
}

function applyIncomingPayload(nextPayload: BotWorldStatePayload): void {
  livePayload = nextPayload;
  if (isDemoMode()) {
    return;
  }
  soundscape.setMode(nextPayload.soundMode ?? 'off', { fromUserGesture: false });
  const locale = effectiveLocale(nextPayload.languageSetting, getHostLocale());
  const theme = getThemeConfig(activeThemeId(), locale);
  const nowMs = nextPayload.snapshot.capturedAt > 0 ? nextPayload.snapshot.capturedAt : Date.now();
  const hadPrev = Object.keys(prevLiveSnapshot.bots).length > 0;
  if (!liveMilestones.isSeeded() || !hadPrev || !nextPayload.snapshot.initialSyncComplete) {
    liveMilestones.seedBaseline(nextPayload.events, nowMs);
  } else {
    const newEvents = diffSnapshots(prevLiveSnapshot, nextPayload.snapshot, false, locale);
    if (newEvents.length > 0) {
      liveMotion.enqueueEvents(newEvents, nextPayload.snapshot, theme, locale, activeCustomPositions());
      const crossed = liveMilestones.evaluateNewEvents(newEvents, nowMs);
      if (crossed !== null && !replay.isReplay) {
        liveMotion.triggerMilestone(crossed, [
          theme.designSize[0] * 0.5,
          theme.designSize[1] * 0.24,
        ]);
        soundscape.playMilestoneCue({ suppressed: replay.isReplay });
      }
      soundscape.playEvents(newEvents, { suppressed: replay.isReplay });
    }
  }
  prevLiveSnapshot = nextPayload.snapshot;
  state.payload = nextPayload;
  if (replay.isReplay) {
    replay.resyncSnapshot(
      nextPayload.keyframes,
      nextPayload.snapshot,
      theme,
      locale,
      activeCustomPositions()
    );
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

async function cycleWeather(): Promise<void> {
  const nextMode = nextWeatherMode(activeWeatherMode());
  if (isDemoMode()) {
    demoWeatherMode = nextMode;
    syncDemoTick(false, true);
    return;
  }
  updateDocumentPrefs({ weatherMode: nextMode });
  renderUi();
  try {
    const res = await orca.plugin.request('botWorld.setWeatherMode', {
      weatherMode: nextMode,
    });
    state.payload = { ...state.payload, weatherMode: res.weatherMode };
    livePayload = state.payload;
    renderUi();
  } catch {
    // Document change is already persisted locally in .botworld
  }
}

async function cycleSound(fromUserGesture = false): Promise<void> {
  const nextMode = nextSoundMode(activeSoundMode());
  soundscape.setMode(nextMode, { fromUserGesture });
  if (isDemoMode()) {
    demoSoundMode = nextMode;
    syncDemoTick(false, false);
    return;
  }
  state.payload = { ...state.payload, soundMode: nextMode };
  livePayload = state.payload;
  renderUi();
  try {
    const res = await orca.plugin.request('botWorld.setSoundMode', {
      soundMode: nextMode,
    });
    state.payload = { ...state.payload, soundMode: res.soundMode };
    livePayload = state.payload;
    renderUi();
  } catch {
    // Keep local UI sound mode even if worker RPC fails
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

const handleGestureUnlock = (): void => {
  if (activeSoundMode() !== 'off' && !soundscape.isUnlocked()) {
    if (soundscape.unlockFromUserGesture()) {
      const displayTs = replay.isReplay
        ? replay.cursorMs
        : state.payload.snapshot.capturedAt > 0
          ? state.payload.snapshot.capturedAt
          : Date.now();
      const phase = resolveAtmospherePhase(activeAtmosphereMode(), displayTs);
      const wKind = resolveWeatherKind(activeWeatherMode(), phase, activeThemeId());
      soundscape.updateAmbientContext(wKind, phase, activeThemeId());
    }
  }
};

const handleKeyDown = (ev: KeyboardEvent): void => {
  handleGestureUnlock();
  const modalOpen = state.shortcutsOpen || state.reportOpen || state.zonesOpen;
  if (shouldIgnoreShortcutEvent(ev, { modalOpen })) return;
  const action = mapKeyToShortcutAction(ev.key, { isEditor: true, modalOpen });
  if (!action) return;
  switch (action) {
    case 'toggleTheme': {
      void switchTheme(nextThemeId(activeThemeId())).catch(() => {});
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
    case 'cycleWeather':
      void cycleWeather().catch(() => {});
      break;
    case 'toggleSound':
      void cycleSound(true).catch(() => {});
      break;
    case 'toggleDemo':
      if (isDemoMode()) exitDemoMode();
      else enterDemoMode();
      break;
    case 'toggleReplayPlay': {
      ev.preventDefault();
      if (timelapse.active) {
        timelapse.stop();
        replay.isPlaying = false;
        syncReplayLoop();
        renderUi();
        break;
      }
      const locale = currentLocale();
      const theme = getThemeConfig(activeThemeId(), locale);
      replay.togglePlay(
        state.payload.keyframes,
        state.payload.events,
        state.payload.snapshot,
        theme,
        locale,
        activeCustomPositions()
      );
      syncReplayLoop();
      renderUi();
      break;
    }
    case 'toggleReport':
      toggleReportModal();
      break;
    case 'takePhotoCard':
      void triggerPhotoCardSnapshot().catch(() => {});
      break;
    case 'toggleZones':
      toggleZonesVisibility();
      break;
    case 'focusUrgent':
      cycleFocusSpotlight();
      break;
    case 'toggleFollowCam':
      toggleFollowCam();
      break;
    case 'resetCamera':
      renderer.resetCamera();
      break;
    case 'focusSearch':
      ev.preventDefault();
      searchInput.focus();
      searchInput.select();
      break;
    case 'toggleCollabNetwork':
      state.showCollabNetwork = !state.showCollabNetwork;
      renderUi();
      break;
    case 'toggleHelp':
      state.shortcutsOpen = !state.shortcutsOpen;
      if (state.shortcutsOpen) {
        state.reportOpen = false;
        state.zonesOpen = false;
        renderReportModal();
        renderZonesManager();
      }
      renderShortcutsHelp();
      syncChromeLocale(currentLocale());
      break;
    case 'closeOrClearSelection':
      if (typeof document !== 'undefined' && document.activeElement === searchInput) {
        state.searchQuery = '';
        searchInput.value = '';
        searchInput.blur();
        renderUi();
      } else if (state.zonesOpen) {
        state.zonesOpen = false;
        renderZonesManager();
        syncChromeLocale(currentLocale());
      } else if (state.reportOpen) {
        state.reportOpen = false;
        renderReportModal();
        syncChromeLocale(currentLocale());
      } else if (state.shortcutsOpen) {
        state.shortcutsOpen = false;
        renderShortcutsHelp();
        syncChromeLocale(currentLocale());
      } else if (timelapse.active) {
        timelapse.stop();
        syncReplayLoop();
        renderUi();
      } else if (renderer.camera.followBotId !== null) {
        renderer.camera.releaseFollow();
        updateCameraHud(currentLocale());
        renderer.renderNow();
      } else if (isFilterActive(state.filterPreset, state.searchQuery)) {
        state.filterPreset = 'all';
        state.searchQuery = '';
        searchInput.value = '';
        renderUi();
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
window.addEventListener('pointerdown', handleGestureUnlock);

let cleanedUp = false;
function cleanup(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  if (demoTimerId !== null) {
    clearInterval(demoTimerId);
    demoTimerId = null;
  }
  if (reportCopiedTimer !== null) {
    clearTimeout(reportCopiedTimer);
    reportCopiedTimer = null;
  }
  if (followNoticeTimer !== null) {
    clearTimeout(followNoticeTimer);
    followNoticeTimer = null;
  }
  if (stageToastTimer !== null) {
    clearTimeout(stageToastTimer);
    stageToastTimer = null;
  }
  timelapse.stop();
  if (replayTimerId !== null) {
    cancelAnimationFrame(replayTimerId);
    replayTimerId = null;
  }
  window.removeEventListener('keydown', handleKeyDown);
  window.removeEventListener('pointerdown', handleGestureUnlock);
  soundscape.dispose();
  docSession?.dispose();
  renderer.dispose();
}

window.addEventListener('beforeunload', cleanup);
window.addEventListener('pagehide', cleanup);

void boot().catch(() => {});
