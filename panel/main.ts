import { diffSnapshots } from '../src/events.ts';
import '../src/protocol.ts';
import { scrubAll } from '../src/redact.ts';
import { formatTimeHms } from '../src/timeline.ts';
import {
  type AtmosphereMode,
  type BotWorldStatePayload,
  type CharacterId,
  type LanguageSetting,
  type PetToyKind,
  type SoundMode,
  type TeamZone,
  type ThemeId,
  type UiLocale,
  VALID_THEME_IDS,
  type ViewMode,
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
  renderBotQuickPills,
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
  getBotRedactedAlias,
  isFilterActive,
} from '../shared/filter.ts';
import { effectiveLocale, getHostLocale, resolveUiLocale, tStrings } from '../shared/i18n.ts';
import { MilestoneTracker, MotionDirector, ReplayController } from '../shared/motion.ts';
import { computeOfficeBadges } from '../shared/office-badges.ts';
import {
  buildOfficeReport,
  formatReportMarkdown,
  renderOfficeReportModal,
} from '../shared/office-report.ts';
import { PetTerrariumRenderer } from '../shared/pet-terrarium.ts';
import { capturePhotoCard } from '../shared/photo-card.ts';
import { QuickSendBar } from '../shared/quick-send.ts';
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

type PanelTab = 'detail' | 'timeline';

const root = document.getElementById('app');
if (!root) {
  throw new Error('Missing #app container');
}

const initialLocale = resolveUiLocale(getHostLocale());
const initialStrings = tStrings(initialLocale);

const state: {
  payload: BotWorldStatePayload;
  selectedBotId: string | null;
  hoveredBotId: string | null;
  activeTab: PanelTab;
  shortcutsOpen: boolean;
  reportOpen: boolean;
  zonesOpen: boolean;
  reportCopied: boolean;
  selectionCleared: boolean;
  filterPreset: StatusFilterPreset;
  searchQuery: string;
  showCollabNetwork: boolean;
  zones: TeamZone[];
  showZones: boolean;
} = {
  payload: {
    snapshot: createEmptySnapshot(),
    events: [],
    keyframes: [],
    activeTheme: 'startup_office',
    atmosphereMode: 'auto',
    weatherMode: 'auto',
    soundMode: 'off',
    viewMode: 'office',
    allowQuickSend: false,
    redactMode: false,
    botAppearances: {},
    pollIntervalSec: 5,
    locale: initialLocale,
    languageSetting: 'auto',
    weeklyTrend: [],
  },
  selectedBotId: null,
  hoveredBotId: null,
  activeTab: 'detail',
  shortcutsOpen: false,
  reportOpen: false,
  zonesOpen: false,
  reportCopied: false,
  selectionCleared: false,
  filterPreset: 'all',
  searchQuery: '',
  showCollabNetwork: false,
  zones: [],
  showZones: true,
};

const liveMotion = new MotionDirector();
const replay = new ReplayController();
const timelapse = new TimelapseController();
const soundscape = new SoundscapeEngine();
const liveMilestones = new MilestoneTracker();
const demoMilestones = new MilestoneTracker();
let prevLiveSnapshot: WorldSnapshot = createEmptySnapshot();
let livePayload: BotWorldStatePayload = state.payload;
let reportCopiedTimer: number | null = null;
let followNoticeTimer: number | null = null;
let followNoticeActive = false;
let stageToastTimer: number | null = null;
let timelapseTimerId: number | null = null;
let lastTimelapseTickMs = 0;

let demoSession: DemoOfficeSession | null = null;
let demoTimerId: number | null = null;
let demoThemeId: ThemeId = 'startup_office';
let demoAtmosphereMode: AtmosphereMode = 'auto';
let demoWeatherMode: WeatherMode = 'auto';
let demoSoundMode: SoundMode = 'off';
let demoViewMode: ViewMode = 'office';
let demoRedactMode = false;
let demoLanguageSetting: LanguageSetting = 'auto';
let demoAppearances: Record<string, CharacterId> = {};
let demoZones: TeamZone[] = [];
let demoShowZones = true;
let quickSending = false;
const demoReplyTimers = new Set<number>();

function isDemoMode(): boolean {
  return demoSession !== null;
}

function currentLocale(): UiLocale {
  const setting = isDemoMode() ? demoLanguageSetting : state.payload.languageSetting;
  return effectiveLocale(setting, getHostLocale());
}

// Build static shell DOM safely
const titleEl = el('span', { className: 'bw-title' }, initialStrings.appTitlePanel);
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
    initialStrings.themeShort[tid]
  ) as HTMLOptionElement;
  themeOptions.set(tid, opt);
  themeSelect.appendChild(opt);
}

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

const viewModeBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn',
    title: initialStrings.viewModeToggleTitle('office'),
    ariaLabel: initialStrings.viewModeToggleTitle('office'),
    onClick: () => void toggleViewMode().catch(() => {}),
  },
  `🐾 ${initialStrings.viewModePetButton}`
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
  '🎯'
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
  '🕸'
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
  '🗺'
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
  '📸'
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

const toolbar = el(
  'div',
  { className: 'bw-toolbar' },
  el('div', { className: 'bw-toolbar-group' }, titleEl, connPill),
  el(
    'div',
    { className: 'bw-toolbar-group' },
    themeSelect,
    viewModeBtn,
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

const boardHintText = el('span', null, initialStrings.boardHint);
const boardHint = el('div', { className: 'bw-hint-banner' }, boardHintText);

const canvasEl = el('canvas', { className: 'bw-stage-canvas' }) as HTMLCanvasElement;
const petCanvasEl = el('canvas', { className: 'bw-stage-canvas bw-hidden' }) as HTMLCanvasElement;
const stageOverlayNote = el('div', { className: 'bw-stage-overlay-note' }, initialStrings.live);
const stageToast = el('div', { className: 'bw-stage-toast bw-hidden' });
const petCoffeeBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-pet-action-btn',
    title: initialStrings.petActionCoffeeTitle,
    onClick: () => handleDropPetToy('coffee'),
  },
  `☕ ${initialStrings.petActionCoffee}`
);
const petBallBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-pet-action-btn',
    title: initialStrings.petActionBallTitle,
    onClick: () => handleDropPetToy('ball'),
  },
  `🎾 ${initialStrings.petActionBall}`
);
const petTreatBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-pet-action-btn',
    title: initialStrings.petActionTreatTitle,
    onClick: () => handleDropPetToy('treat'),
  },
  `🍪 ${initialStrings.petActionTreat}`
);
const petActionStrip = el(
  'div',
  { className: 'bw-pet-action-strip bw-hidden' },
  petCoffeeBtn,
  petBallBtn,
  petTreatBtn
);
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
    ariaLabel: initialStrings.followButtonTitle,
    onClick: () => toggleFollowCam(),
  },
  '📌'
);
const cameraHud = el(
  'div',
  { className: 'bw-camera-hud bw-camera-hud-compact' },
  zoomOutBtn,
  zoomResetBtn,
  zoomInBtn,
  followHudBtn
);
const stageWrap = el(
  'div',
  { className: 'bw-stage-wrap-panel' },
  canvasEl,
  petCanvasEl,
  stageOverlayNote,
  stageToast,
  cameraHud,
  petActionStrip
);

const quickSendBar = new QuickSendBar({
  compact: true,
  onSelectBot: (botId) => {
    state.selectionCleared = false;
    state.selectedBotId = botId;
    state.activeTab = 'detail';
    renderUi();
  },
  onSend: (botId, message) => void handleQuickSend(botId, message).catch(() => {}),
});

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
  { className: 'bw-filter-bar bw-filter-bar-compact' },
  filterChipsWrap,
  el('div', { className: 'bw-filter-search-wrap' }, filterMatchPill, searchInput, searchClearBtn)
);

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
  initialStrings.tabDetail
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
  initialStrings.tabTimeline
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
const backToLiveBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn bw-btn-warn bw-hidden',
    onClick: () => {
      timelapse.stop();
      syncTimelapseLoop();
      replay.returnToLive();
      renderUi();
    },
  },
  initialStrings.backToLive
);
const subTabs = el('div', { className: 'bw-subtabs' }, tabDetailBtn, tabTimelineBtn, timelapseBtn, backToLiveBtn);

const lowerContent = el('div', { className: 'bw-detail-root' });
const mainArea = el(
  'div',
  { className: 'bw-panel-main' },
  stageWrap,
  quickSendBar.root,
  filterBar,
  botStrip,
  subTabs,
  lowerContent
);
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
root.appendChild(boardHint);
root.appendChild(mainArea);
root.appendChild(shortcutsBackdrop);
root.appendChild(reportBackdrop);
root.appendChild(zonesBackdrop);

const renderer = new StageRenderer(canvasEl, {
  onSelectBot: (botId) => {
    state.selectionCleared = false;
    state.selectedBotId = botId;
    state.activeTab = 'detail';
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
  onCameraChange: () => {
    updateCameraHud(currentLocale());
  },
});

const petRenderer = new PetTerrariumRenderer(petCanvasEl, {
  onSelectAndPet: (botId) => {
    state.selectionCleared = false;
    state.selectedBotId = botId;
    state.activeTab = 'detail';
    soundscape.playCue('task_done', { suppressed: false });
    renderUi();
  },
  onHoverBot: (botId) => {
    if (state.hoveredBotId !== botId) {
      state.hoveredBotId = botId;
      updateStageOverlayLabel();
    }
  },
});

function activeViewMode(): ViewMode {
  if (isDemoMode()) return demoViewMode;
  return state.payload.viewMode ?? 'office';
}

function isPetMode(): boolean {
  return activeViewMode() === 'pet';
}

function handleDropPetToy(kind: PetToyKind): void {
  petRenderer.engine.dropToy(kind);
  soundscape.playCue('handoff', { suppressed: false });
  petRenderer.renderNow();
}

function activeAtmosphereMode(): AtmosphereMode {
  if (isDemoMode()) return demoAtmosphereMode;
  return state.payload.atmosphereMode ?? 'auto';
}

function activeWeatherMode(): WeatherMode {
  if (isDemoMode()) return demoWeatherMode;
  return state.payload.weatherMode ?? 'auto';
}

function activeSoundMode(): SoundMode {
  if (isDemoMode()) return demoSoundMode;
  return state.payload.soundMode ?? 'off';
}

function activeZones(): TeamZone[] {
  if (isDemoMode()) return demoZones;
  return state.zones;
}

function activeShowZones(): boolean {
  if (isDemoMode()) return demoShowZones;
  return state.showZones;
}

function setZonesState(nextZones: TeamZone[], nextShow?: boolean): void {
  if (isDemoMode()) {
    demoZones = nextZones;
    if (nextShow !== undefined) demoShowZones = nextShow;
  } else {
    state.zones = nextZones;
    if (nextShow !== undefined) state.showZones = nextShow;
  }
  renderUi();
}

function toggleZonesVisibility(): void {
  const nextShow = !activeShowZones();
  if (isDemoMode()) {
    demoShowZones = nextShow;
  } else {
    state.showZones = nextShow;
  }
  renderUi();
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
  if (isPetMode()) {
    petRenderer.renderNow();
  } else {
    renderer.renderNow();
  }
  const locale = currentLocale();
  const s = tStrings(locale);
  const snap = currentDisplayedSnapshot();
  const timestampMs = replay.isReplay
    ? replay.cursorMs
    : snap.capturedAt > 0
      ? snap.capturedAt
      : Date.now();
  const res = await capturePhotoCard(isPetMode() ? petCanvasEl : canvasEl, {
    snapshot: snap,
    events: state.payload.events,
    themeId: state.payload.activeTheme,
    atmosphereMode: activeAtmosphereMode(),
    weatherMode: activeWeatherMode(),
    redactMode: state.payload.redactMode,
    locale,
    timestampMs,
  });
  if (res.ok) {
    showStageToast(s.photoSavedToast);
  }
}

function renderShortcutsHelp(): void {
  renderShortcutsModal(shortcutsBackdrop, {
    open: state.shortcutsOpen,
    locale: currentLocale(),
    isEditor: false,
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
  const redactMode = state.payload.redactMode;
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
  const redactMode = state.payload.redactMode;
  const locale = currentLocale();
  const demoMode = isDemoMode();
  const nextKey = zonesModalRenderKey({
    open,
    zones,
    showZones,
    redactMode,
    locale,
    demoMode,
    persisted: false,
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
    persisted: false,
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

function syncTimelapseLoop(): void {
  if (timelapse.active) {
    if (timelapseTimerId === null) {
      lastTimelapseTickMs = performance.now();
      const tick = (nowMs: number) => {
        if (!timelapse.active) {
          timelapseTimerId = null;
          return;
        }
        const dtMs = Math.max(0, Math.min(250, nowMs - lastTimelapseTickMs));
        const dtSecs = dtMs / 1000;
        lastTimelapseTickMs = nowMs;
        const locale = currentLocale();
        const theme = getThemeConfig(state.payload.activeTheme, locale);
        const stepRes = timelapse.advance(dtMs);
        replay.advanceToTimestamp(
          stepRes.cursorMs,
          dtSecs,
          state.payload.keyframes,
          state.payload.events,
          state.payload.snapshot,
          theme,
          locale
        );
        const displayTs = replay.isReplay
          ? replay.cursorMs
          : state.payload.snapshot.capturedAt || Date.now();
        const phase = resolveAtmospherePhase(activeAtmosphereMode(), displayTs);
        const wKind = resolveWeatherKind(activeWeatherMode(), phase, state.payload.activeTheme);
        renderer.weather.step(dtSecs, wKind, theme.designSize);
        renderUi();
        if (timelapse.active) {
          timelapseTimerId = requestAnimationFrame(tick);
        } else {
          timelapseTimerId = null;
        }
      };
      timelapseTimerId = requestAnimationFrame(tick);
    }
  } else if (timelapseTimerId !== null) {
    cancelAnimationFrame(timelapseTimerId);
    timelapseTimerId = null;
  }
}

function toggleTimelapse(): void {
  if (timelapse.active) {
    timelapse.stop();
    syncTimelapseLoop();
    renderUi();
    return;
  }
  const locale = currentLocale();
  const theme = getThemeConfig(state.payload.activeTheme, locale);
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
    locale
  );
  syncTimelapseLoop();
  renderUi();
}

function currentDisplayedSnapshot(): WorldSnapshot {
  return replay.isReplay ? replay.snapshot : state.payload.snapshot;
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
  if (state.hoveredBotId && isSafeKey(state.hoveredBotId) && Object.hasOwn(snap.bots, state.hoveredBotId)) {
    const hoverName = state.payload.redactMode
      ? getBotRedactedAlias(state.hoveredBotId, snap, locale)
      : scrubAll(snap.bots[state.hoveredBotId].name);
    stageOverlayNote.textContent = s.stageOverlayHover(hoverName);
    return;
  }
  if (isPetMode()) {
    stageOverlayNote.textContent = s.petOverlayHint;
    return;
  }
  stageOverlayNote.textContent = snap.runtime.connected ? s.stageOverlayLive : s.stageOverlayOffline;
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
  followHudBtn.title = s.followButtonTitle;
  followHudBtn.setAttribute('aria-label', s.followButtonTitle);
  followHudBtn.className = following ? 'bw-hud-btn bw-hud-btn-active' : 'bw-hud-btn';
}

function cycleFocusSpotlight(): void {
  const snap = currentDisplayedSnapshot();
  const locale = currentLocale();
  const activeFilter = isFilterActive(state.filterPreset, state.searchQuery)
    ? filterBotIds(snap, {
        preset: state.filterPreset,
        query: state.searchQuery,
        redactMode: state.payload.redactMode,
        locale,
      })
    : undefined;
  const currentId = renderer.camera.spotlightBotId ?? state.selectedBotId;
  const nextId = pickNextFocusBotId(snap, currentId, activeFilter);
  if (!nextId) return;
  state.selectionCleared = false;
  state.selectedBotId = nextId;
  state.activeTab = 'detail';
  renderUi();
  renderer.focusBot(nextId);
}

function toggleFollowCam(): void {
  const snap = currentDisplayedSnapshot();
  const locale = currentLocale();
  const activeFilter = isFilterActive(state.filterPreset, state.searchQuery)
    ? filterBotIds(snap, {
        preset: state.filterPreset,
        query: state.searchQuery,
        redactMode: state.payload.redactMode,
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

  const targetId = resolveFollowTargetBotId(snap, state.selectedBotId, activeFilter);
  if (!targetId) {
    showFollowNoMatchNotice();
    renderUi();
    return;
  }
  if (targetId !== state.selectedBotId) {
    state.selectionCleared = false;
    state.selectedBotId = targetId;
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
  document.title = s.appTitlePanel;
  titleEl.textContent = s.appTitlePanel;
  for (const [tid, opt] of themeOptions.entries()) {
    opt.textContent = s.themeShort[tid];
  }
  themeSelect.setAttribute('aria-label', s.themeAriaLabel);
  themeSelect.title = s.themeToggleTitle;
  atmoBtn.textContent = `${atmosphereIcon(atmoMode)} ${atmoLabel}`;
  atmoBtn.title = s.atmosphereToggleTitle(atmoLabel);
  atmoBtn.className = atmoMode !== 'auto' ? 'bw-btn bw-btn-active' : 'bw-btn';
  weatherBtn.textContent = `${weatherIcon(wMode)} ${wLabel}`;
  weatherBtn.title = s.weatherToggleTitle(wLabel);
  weatherBtn.className = wMode !== 'auto' ? 'bw-btn bw-btn-active' : 'bw-btn';
  soundBtn.textContent = `${soundIcon(sndMode)} ${sndLabel}`;
  soundBtn.title = s.soundToggleTitle(sndLabel);
  soundBtn.className = sndMode !== 'off' ? 'bw-btn bw-btn-active' : 'bw-btn';
  const vMode = activeViewMode();
  viewModeBtn.textContent = vMode === 'pet' ? `🏢 ${s.viewModeOfficeButton}` : `🐾 ${s.viewModePetButton}`;
  viewModeBtn.title = s.viewModeToggleTitle(vMode);
  viewModeBtn.setAttribute('aria-label', s.viewModeToggleTitle(vMode));
  viewModeBtn.className = vMode === 'pet' ? 'bw-btn bw-btn-active' : 'bw-btn';
  petCoffeeBtn.textContent = `☕ ${s.petActionCoffee}`;
  petCoffeeBtn.title = s.petActionCoffeeTitle;
  petBallBtn.textContent = `🎾 ${s.petActionBall}`;
  petBallBtn.title = s.petActionBallTitle;
  petTreatBtn.textContent = `🍪 ${s.petActionTreat}`;
  petTreatBtn.title = s.petActionTreatTitle;
  focusBtn.title = s.focusButtonTitle;
  focusBtn.setAttribute('aria-label', s.focusButtonTitle);
  collabBtn.title = s.collabButtonTitle;
  collabBtn.setAttribute('aria-label', s.collabButtonTitle);
  collabBtn.className = state.showCollabNetwork ? 'bw-btn bw-btn-active' : 'bw-btn';
  zonesBtn.title = s.zonesButtonTitle;
  zonesBtn.setAttribute('aria-label', s.zonesButtonTitle);
  zonesBtn.className =
    state.zonesOpen || (activeShowZones() && activeZones().length > 0)
      ? 'bw-btn bw-btn-active'
      : 'bw-btn';
  photoBtn.title = s.photoButtonTitle;
  photoBtn.setAttribute('aria-label', s.photoButtonTitle);
  timelapseBtn.textContent = timelapse.active
    ? `⏱ ${timelapse.formatProgress()}`
    : `⏱ ${s.timelapseButton}`;
  timelapseBtn.title = s.timelapseButtonTitle;
  timelapseBtn.setAttribute('aria-label', s.timelapseButtonTitle);
  timelapseBtn.className = timelapse.active ? 'bw-btn bw-btn-active' : 'bw-btn';
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
  refreshBtn.textContent = s.refresh;
  boardHintText.textContent = isDemoMode() ? s.demoModeHint : s.boardHint;
  tabDetailBtn.textContent = s.tabDetail;
  tabTimelineBtn.textContent = s.tabTimeline;
  backToLiveBtn.textContent = s.backToLive;
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

function syncDemoTick(advance: boolean): void {
  if (!demoSession) return;
  const generatedCount = advance ? demoSession.tick().length : 0;
  const nextPayload = buildDemoPayload();
  if (!nextPayload) return;
  const locale = currentLocale();
  const theme = getThemeConfig(nextPayload.activeTheme, locale);
  if (advance && generatedCount > 0 && !replay.isReplay) {
    const newEvents = nextPayload.events.slice(-generatedCount).map((r) => r.event);
    liveMotion.enqueueEvents(newEvents, nextPayload.snapshot, theme, locale);
    petRenderer.engine.onEvents(newEvents, locale);
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
    replay.resyncSnapshot(nextPayload.keyframes, nextPayload.snapshot, theme, locale);
  }
  renderUi();
}

function enterDemoMode(): void {
  if (isDemoMode()) return;
  state.selectionCleared = false;
  demoThemeId = state.payload.activeTheme;
  demoAtmosphereMode = state.payload.atmosphereMode ?? 'auto';
  demoWeatherMode = state.payload.weatherMode ?? 'auto';
  demoSoundMode = livePayload.soundMode ?? 'off';
  demoViewMode = livePayload.viewMode ?? 'office';
  demoRedactMode = state.payload.redactMode;
  demoLanguageSetting = state.payload.languageSetting;
  demoAppearances = {};
  demoZones = state.zones.map((z) => ({ ...z }));
  demoShowZones = state.showZones;
  demoSession = createDemoOfficeSession();
  timelapse.stop();
  syncTimelapseLoop();
  replay.returnToLive();
  liveMotion.clearTransients();
  const initialDemo = buildDemoPayload();
  if (initialDemo) {
    state.payload = initialDemo;
    state.selectedBotId = initialDemo.snapshot.botOrder[0] ?? null;
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
  renderUi();
}

function clearDemoReplyTimers(): void {
  for (const tid of demoReplyTimers) {
    clearTimeout(tid);
  }
  demoReplyTimers.clear();
}

function exitDemoMode(): void {
  clearDemoReplyTimers();
  if (demoTimerId !== null) {
    clearInterval(demoTimerId);
    demoTimerId = null;
  }
  state.selectionCleared = false;
  demoSession = null;
  demoZones = [];
  demoShowZones = true;
  demoMilestones.reset();
  timelapse.stop();
  syncTimelapseLoop();
  replay.returnToLive();
  liveMotion.clearTransients();
  state.payload = livePayload;
  soundscape.setMode(livePayload.soundMode ?? 'off', { fromUserGesture: false });
  liveMilestones.seedBaseline(
    livePayload.events,
    livePayload.snapshot.capturedAt || Date.now()
  );
  state.selectedBotId = null;
  renderUi();
  void triggerRefresh().catch(() => {});
}

function renderUi(): void {
  const { activeTheme, redactMode, botAppearances, events } = state.payload;
  const locale = currentLocale();
  const s = tStrings(locale);
  const snap = currentDisplayedSnapshot();
  const botCount = Object.keys(snap.bots).length;

  syncChromeLocale(locale);

  themeSelect.value = activeTheme;

  redactBtn.textContent = redactMode ? s.redactOn : s.redactOff;
  redactBtn.className = redactMode ? 'bw-btn bw-btn-warn' : 'bw-btn';

  if (isDemoMode()) {
    connPill.textContent = s.demoModeBadge(botCount);
    connPill.className = 'bw-status-pill bw-status-demo';
  } else if (snap.runtime.connected) {
    connPill.textContent = s.connectedBots(botCount);
    connPill.className = 'bw-status-pill bw-status-online';
  } else {
    connPill.textContent = snap.runtime.retryAfterSecs
      ? s.offlineRetry(snap.runtime.retryAfterSecs)
      : s.offline;
    connPill.className = 'bw-status-pill bw-status-offline';
  }

  backToLiveBtn.classList.toggle('bw-hidden', !replay.isReplay);
  tabDetailBtn.className = state.activeTab === 'detail' ? 'bw-btn bw-btn-active' : 'bw-btn';
  tabTimelineBtn.className = state.activeTab === 'timeline' ? 'bw-btn bw-btn-active' : 'bw-btn';

  // Ensure selectedBotId points to an existing bot or first bot unless explicitly cleared
  if (state.selectedBotId && !Object.hasOwn(snap.bots, state.selectedBotId)) {
    state.selectedBotId = null;
  }
  if (!state.selectedBotId && !state.selectionCleared) {
    const firstId = snap.botOrder.find((id) => Object.hasOwn(snap.bots, id)) ?? Object.keys(snap.bots)[0];
    state.selectedBotId = firstId ?? null;
  }

  updateStageOverlayLabel();

  const displayTimestampMs = replay.isReplay
    ? replay.cursorMs
    : snap.capturedAt > 0
      ? snap.capturedAt
      : Date.now();

  const counts = countFilterPresets(snap);
  for (const preset of STATUS_FILTER_PRESETS) {
    const btn = filterChipButtons.get(preset);
    if (!btn) continue;
    btn.textContent = `${s.filterPresetLabels[preset]} (${counts[preset]})`;
    btn.className =
      state.filterPreset === preset ? 'bw-filter-chip bw-filter-chip-active' : 'bw-filter-chip';
  }
  searchClearBtn.classList.toggle('bw-hidden', state.searchQuery.length === 0);
  let filterMatchedBotIds: ReadonlySet<string> | null = null;
  if (isFilterActive(state.filterPreset, state.searchQuery)) {
    const matched = filterBotIds(snap, {
      preset: state.filterPreset,
      query: state.searchQuery,
      redactMode,
      locale,
    });
    filterMatchedBotIds = matched;
    filterMatchPill.textContent = s.filterMatchCount(matched.size, counts.all);
    filterMatchPill.classList.remove('bw-hidden');
  } else {
    filterMatchPill.classList.add('bw-hidden');
  }

  const collabEdges = state.showCollabNetwork
    ? buildCollabNetwork(events, snap, { nowMs: displayTimestampMs })
    : [];
  const badgeSummary = computeOfficeBadges(events, snap, {
    nowMs: displayTimestampMs,
    redactMode,
    locale,
  });

  const atmoMode = activeAtmosphereMode();
  const wMode = activeWeatherMode();
  const phase = resolveAtmospherePhase(atmoMode, displayTimestampMs);
  const wKind = resolveWeatherKind(wMode, phase, activeTheme);
  soundscape.updateAmbientContext(wKind, phase, activeTheme);

  const petActive = isPetMode();
  canvasEl.classList.toggle('bw-hidden', petActive);
  petCanvasEl.classList.toggle('bw-hidden', !petActive);
  cameraHud.classList.toggle('bw-hidden', petActive);
  petActionStrip.classList.toggle('bw-hidden', !petActive);
  stageOverlayNote.classList.toggle('bw-stage-overlay-note-pet', petActive);
  stageWrap.classList.toggle('bw-stage-pet-mode', petActive);
  petRenderer.setActive(petActive);
  petRenderer.update({
    snapshot: snap,
    themeId: activeTheme,
    atmosphereMode: atmoMode,
    weatherMode: wMode,
    displayTimestampMs,
    selectedBotId: state.selectedBotId,
    redactMode,
    botAppearances,
    locale,
    filterMatchedBotIds,
  });

  quickSendBar.update({
    snapshot: snap,
    selectedBotId: state.selectedBotId,
    redactMode,
    allowQuickSend: Boolean(state.payload.allowQuickSend),
    demoMode: isDemoMode(),
    locale,
    sending: quickSending,
  });

  if (!petActive) {
    renderer.update({
      snapshot: snap,
      themeId: activeTheme,
      atmosphereMode: atmoMode,
      weatherMode: wMode,
      displayTimestampMs,
      selectedBotId: state.selectedBotId,
      redactMode,
      botAppearances,
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

  botStrip.hidden = botCount === 0;
  renderBotQuickPills(botStrip, {
    snapshot: snap,
    selectedBotId: state.selectedBotId,
    onSelectBot: (botId) => {
      state.selectionCleared = false;
      state.selectedBotId = botId;
      state.activeTab = 'detail';
      if (renderer.camera.followBotId && renderer.camera.followBotId !== botId) {
        renderer.camera.setFollowBot(botId);
      }
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
      locale,
      botCount,
      badges: selectedBot ? (badgeSummary.badgesByBot[selectedBot.id] ?? []) : [],
      onStartDemo: isDemoMode() ? undefined : enterDemoMode,
      onSelectCharacter: (botId, charId) => void setBotAppearance(botId, charId).catch(() => {}),
      onFocusTerminal: (terminalId) => void focusTerminal(terminalId).catch(() => {}),
      onOpenWorkspace: (workspaceId) => void openWorkspace(workspaceId).catch(() => {}),
    });
  } else {
    clearChildren(lowerContent);
    const listWrap = el('div', { className: 'bw-detail-body' });
    renderEventTimelineList(listWrap, {
      events,
      redactMode,
      limit: 60,
      locale,
      onJumpToTime: (ts) => {
        timelapse.stop();
        syncTimelapseLoop();
        const curLocale = currentLocale();
        const theme = getThemeConfig(state.payload.activeTheme, curLocale);
        replay.seekTo(
          ts,
          state.payload.keyframes,
          state.payload.events,
          state.payload.snapshot,
          theme,
          curLocale
        );
        renderUi();
      },
    });
    lowerContent.appendChild(listWrap);
  }
  renderShortcutsHelp();
  renderReportModal();
  renderZonesManager();
}

function applyIncomingPayload(nextPayload: BotWorldStatePayload): void {
  livePayload = nextPayload;
  if (isDemoMode()) {
    return;
  }
  soundscape.setMode(nextPayload.soundMode ?? 'off', { fromUserGesture: false });
  const locale = effectiveLocale(nextPayload.languageSetting, getHostLocale());
  const theme = getThemeConfig(nextPayload.activeTheme, locale);
  const nowMs = nextPayload.snapshot.capturedAt > 0 ? nextPayload.snapshot.capturedAt : Date.now();
  const hadPrev = Object.keys(prevLiveSnapshot.bots).length > 0;
  if (!liveMilestones.isSeeded() || !hadPrev || !nextPayload.snapshot.initialSyncComplete) {
    liveMilestones.seedBaseline(nextPayload.events, nowMs);
  } else {
    const newEvents = diffSnapshots(prevLiveSnapshot, nextPayload.snapshot, false, locale);
    if (newEvents.length > 0) {
      liveMotion.enqueueEvents(newEvents, nextPayload.snapshot, theme, locale);
      petRenderer.engine.onEvents(newEvents, locale);
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
    replay.resyncSnapshot(nextPayload.keyframes, nextPayload.snapshot, theme, locale);
  }
  renderUi();
}

async function switchTheme(themeId: ThemeId): Promise<void> {
  if (isDemoMode()) {
    demoThemeId = themeId;
    syncDemoTick(false);
    return;
  }
  try {
    const res = await orca.plugin.request('botWorld.setTheme', { themeId });
    state.payload = { ...state.payload, activeTheme: res.themeId };
    livePayload = state.payload;
    renderUi();
  } catch {
    // Ignore RPC failure
  }
}

async function cycleAtmosphere(): Promise<void> {
  const nextMode = nextAtmosphereMode(activeAtmosphereMode());
  if (isDemoMode()) {
    demoAtmosphereMode = nextMode;
    syncDemoTick(false);
    return;
  }
  try {
    const res = await orca.plugin.request('botWorld.setAtmosphereMode', {
      atmosphereMode: nextMode,
    });
    state.payload = { ...state.payload, atmosphereMode: res.atmosphereMode };
    livePayload = state.payload;
    renderUi();
  } catch {
    // Ignore RPC failure
  }
}

async function cycleWeather(): Promise<void> {
  const nextMode = nextWeatherMode(activeWeatherMode());
  if (isDemoMode()) {
    demoWeatherMode = nextMode;
    syncDemoTick(false);
    return;
  }
  try {
    const res = await orca.plugin.request('botWorld.setWeatherMode', {
      weatherMode: nextMode,
    });
    state.payload = { ...state.payload, weatherMode: res.weatherMode };
    livePayload = state.payload;
    renderUi();
  } catch {
    // Ignore RPC failure
  }
}

async function cycleSound(fromUserGesture = false): Promise<void> {
  const nextMode = nextSoundMode(activeSoundMode());
  soundscape.setMode(nextMode, { fromUserGesture });
  if (isDemoMode()) {
    demoSoundMode = nextMode;
    syncDemoTick(false);
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
    // Keep local sound mode even if worker RPC fails
  }
}

async function toggleViewMode(): Promise<void> {
  const nextMode: ViewMode = activeViewMode() === 'pet' ? 'office' : 'pet';
  if (isDemoMode()) {
    demoViewMode = nextMode;
    syncDemoTick(false);
    return;
  }
  state.payload = { ...state.payload, viewMode: nextMode };
  livePayload = state.payload;
  renderUi();
  try {
    const res = await orca.plugin.request('botWorld.setViewMode', { viewMode: nextMode });
    state.payload = { ...state.payload, viewMode: res.viewMode };
    livePayload = state.payload;
    renderUi();
  } catch {
    // Keep local view mode even if worker RPC fails
  }
}

async function focusTerminal(terminalId: string): Promise<void> {
  const s = tStrings(currentLocale());
  if (isDemoMode()) {
    showStageToast(s.demoTeleportTerminalToast);
    return;
  }
  try {
    const res = await orca.plugin.request('botWorld.focusTerminal', { terminalId });
    if (!res.ok || !res.focused) {
      showStageToast(s.teleportFailedToast(res.reason));
    }
  } catch {
    showStageToast(s.teleportFailedToast());
  }
}

async function openWorkspace(workspaceId: string): Promise<void> {
  const s = tStrings(currentLocale());
  if (isDemoMode()) {
    showStageToast(s.demoTeleportWorkspaceToast);
    return;
  }
  try {
    const res = await orca.plugin.request('botWorld.openWorkspace', { workspaceId });
    if (!res.ok || !res.opened) {
      showStageToast(s.teleportFailedToast(res.reason));
    }
  } catch {
    showStageToast(s.teleportFailedToast());
  }
}

async function handleQuickSend(botId: string, message: string): Promise<void> {
  const locale = currentLocale();
  const s = tStrings(locale);
  const redactMode = state.payload.redactMode;
  const theme = getThemeConfig(state.payload.activeTheme, locale);

  if (isDemoMode() && demoSession) {
    const res = demoSession.sendQuickMessage(botId, message);
    if (!res) return;
    quickSendBar.clearInput();
    const snap = currentDisplayedSnapshot();
    liveMotion.launchQuickMessageCourier(botId, snap, theme, message, redactMode);
    petRenderer.engine.dropQuickMessageLetter(botId, locale);
    soundscape.playCue('handoff', { suppressed: false });
    const targetDisplay = redactMode
      ? getBotRedactedAlias(botId, snap, locale)
      : scrubAll(res.botName);
    showStageToast(s.quickSendSentToast(targetDisplay));
    syncDemoTick(false);

    const timerId = window.setTimeout(() => {
      demoReplyTimers.delete(timerId);
      if (!demoSession) return;
      const replyEv = demoSession.receiveQuickMessageReply(botId, currentLocale());
      if (replyEv) {
        const nextPayload = buildDemoPayload();
        if (nextPayload) {
          const curLocale = currentLocale();
          const curTheme = getThemeConfig(demoThemeId, curLocale);
          liveMotion.enqueueEvents([replyEv], nextPayload.snapshot, curTheme, curLocale);
          soundscape.playCue('handoff', { suppressed: false });
          state.payload = nextPayload;
          renderUi();
        }
      }
    }, 1200);
    demoReplyTimers.add(timerId);
    return;
  }

  if (!state.payload.allowQuickSend) {
    showStageToast(s.quickSendDisabledError);
    return;
  }

  quickSending = true;
  renderUi();
  try {
    const res = await orca.plugin.request('botWorld.sendQuickMessage', { botId, message });
    if (res.ok) {
      quickSendBar.clearInput();
      const snap = currentDisplayedSnapshot();
      liveMotion.launchQuickMessageCourier(botId, snap, theme, message, redactMode);
      petRenderer.engine.dropQuickMessageLetter(botId, locale);
      soundscape.playCue('handoff', { suppressed: false });
      const targetDisplay = redactMode
        ? getBotRedactedAlias(botId, snap, locale)
        : scrubAll(res.botName);
      showStageToast(s.quickSendSentToast(targetDisplay));
      const fresh = await orca.plugin.request('botWorld.getState', { locale: getHostLocale() });
      applyIncomingPayload(fresh);
    } else {
      showStageToast(s.quickSendFailedToast(res.error));
    }
  } catch {
    showStageToast(s.quickSendFailedToast('request failed'));
  } finally {
    quickSending = false;
    renderUi();
  }
}

async function toggleRedact(): Promise<void> {
  if (isDemoMode()) {
    demoRedactMode = !demoRedactMode;
    syncDemoTick(false);
    return;
  }
  try {
    const res = await orca.plugin.request('botWorld.setRedactMode', {
      redactMode: !state.payload.redactMode,
    });
    state.payload = { ...state.payload, redactMode: res.redactMode };
    livePayload = state.payload;
    renderUi();
    if (res.redactMode) {
      const fresh = await orca.plugin.request('botWorld.getState', { locale: getHostLocale() });
      applyIncomingPayload(fresh);
    }
  } catch {
    // Ignore RPC failure
  }
}

async function toggleLanguage(): Promise<void> {
  const nextLanguage: LanguageSetting = currentLocale() === 'ko' ? 'en' : 'ko';
  if (isDemoMode()) {
    demoLanguageSetting = nextLanguage;
    syncDemoTick(false);
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
    renderUi();
    const fresh = await orca.plugin.request('botWorld.getState', { locale: getHostLocale() });
    applyIncomingPayload(fresh);
  } catch {
    // Ignore RPC failure
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
    syncDemoTick(false);
    return;
  }
  try {
    const res = await orca.plugin.request('botWorld.setBotAppearance', { botId, characterId });
    state.payload = { ...state.payload, botAppearances: res.botAppearances };
    livePayload = state.payload;
    renderUi();
  } catch {
    // Ignore RPC failure
  }
}

async function triggerRefresh(): Promise<void> {
  if (isDemoMode()) {
    syncDemoTick(true);
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
  renderUi();
  try {
    orca.on('theme', ({ colorScheme }) => {
      document.documentElement.classList.toggle('light', colorScheme === 'light');
    });

    orca.plugin.on('botWorld.stateUpdated', (payload) => {
      applyIncomingPayload(payload);
    });

    const initial = await orca.plugin.request('botWorld.getState', { locale: getHostLocale() });
    applyIncomingPayload(initial);
  } catch {
    renderUi();
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
      const wKind = resolveWeatherKind(activeWeatherMode(), phase, state.payload.activeTheme);
      soundscape.updateAmbientContext(wKind, phase, state.payload.activeTheme);
    }
  }
};

const handleKeyDown = (ev: KeyboardEvent): void => {
  handleGestureUnlock();
  const modalOpen = state.shortcutsOpen || state.reportOpen || state.zonesOpen;
  if (shouldIgnoreShortcutEvent(ev, { modalOpen })) return;
  const action = mapKeyToShortcutAction(ev.key, { isEditor: false, modalOpen });
  if (!action) return;
  switch (action) {
    case 'toggleTheme': {
      void switchTheme(nextThemeId(state.payload.activeTheme)).catch(() => {});
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
    case 'toggleViewMode':
      void toggleViewMode().catch(() => {});
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
        syncTimelapseLoop();
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
        state.selectedBotId = null;
        renderUi();
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
  clearDemoReplyTimers();
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
  if (timelapseTimerId !== null) {
    cancelAnimationFrame(timelapseTimerId);
    timelapseTimerId = null;
  }
  timelapse.stop();
  window.removeEventListener('keydown', handleKeyDown);
  window.removeEventListener('pointerdown', handleGestureUnlock);
  soundscape.dispose();
  petRenderer.dispose();
  renderer.dispose();
}

window.addEventListener('beforeunload', cleanup);
window.addEventListener('pagehide', cleanup);

void boot().catch(() => {});
