import { diffSnapshots } from '../src/events.ts';
import '../src/protocol.ts';
import { scrubAll } from '../src/redact.ts';
import { formatTimeHms } from '../src/timeline.ts';
import {
  type BotWorldStatePayload,
  type CharacterId,
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
  renderBotQuickPills,
  renderEventTimelineList,
} from '../shared/bot-detail-view.ts';
import { clearChildren, el } from '../shared/dom.ts';
import { effectiveLocale, getHostLocale, resolveUiLocale, tStrings } from '../shared/i18n.ts';
import { MotionDirector, ReplayController } from '../shared/motion.ts';
import { StageRenderer } from '../shared/stage-renderer.ts';

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
  selectedBotId: null,
  hoveredBotId: null,
  activeTab: 'detail',
};

const liveMotion = new MotionDirector();
const replay = new ReplayController();
let prevLiveSnapshot: WorldSnapshot = createEmptySnapshot();

function currentLocale(): UiLocale {
  return effectiveLocale(state.payload.languageSetting, getHostLocale());
}

// Build static shell DOM safely
const titleEl = el('span', { className: 'bw-title' }, initialStrings.appTitlePanel);
const startupBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-seg-btn',
    onClick: () => void switchTheme('startup_office').catch(() => {}),
  },
  initialStrings.themeShort.startup_office
);
const corpBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-seg-btn',
    onClick: () => void switchTheme('corporate_office').catch(() => {}),
  },
  initialStrings.themeShort.corporate_office
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

const toolbar = el(
  'div',
  { className: 'bw-toolbar' },
  el('div', { className: 'bw-toolbar-group' }, titleEl, connPill),
  el('div', { className: 'bw-toolbar-group' }, themeSeg, redactBtn, langBtn, refreshBtn)
);

const boardHintText = el('span', null, initialStrings.boardHint);
const boardHint = el('div', { className: 'bw-hint-banner' }, boardHintText);

const canvasEl = el('canvas', { className: 'bw-stage-canvas' }) as HTMLCanvasElement;
const stageOverlayNote = el('div', { className: 'bw-stage-overlay-note' }, initialStrings.live);
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
  initialStrings.backToLive
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
  const locale = currentLocale();
  const s = tStrings(locale);
  const snap = currentDisplayedSnapshot();
  if (replay.isReplay) {
    stageOverlayNote.textContent = s.stageOverlayReplay(formatTimeHms(replay.cursorMs, locale));
    return;
  }
  if (state.hoveredBotId && isSafeKey(state.hoveredBotId) && Object.hasOwn(snap.bots, state.hoveredBotId)) {
    const b = snap.bots[state.hoveredBotId];
    stageOverlayNote.textContent = s.stageOverlayHover(scrubAll(b.name));
    return;
  }
  stageOverlayNote.textContent = snap.runtime.connected ? s.stageOverlayLive : s.stageOverlayOffline;
}

function syncChromeLocale(locale: UiLocale): void {
  const s = tStrings(locale);
  document.documentElement.lang = locale;
  document.title = s.appTitlePanel;
  titleEl.textContent = s.appTitlePanel;
  startupBtn.textContent = s.themeShort.startup_office;
  corpBtn.textContent = s.themeShort.corporate_office;
  themeSeg.setAttribute('aria-label', s.themeAriaLabel);
  langBtn.textContent = s.langToggleText;
  langBtn.title = s.langToggleTitle;
  langBtn.setAttribute('aria-label', s.langToggleTitle);
  refreshBtn.textContent = s.refresh;
  boardHintText.textContent = s.boardHint;
  tabDetailBtn.textContent = s.tabDetail;
  tabTimelineBtn.textContent = s.tabTimeline;
  backToLiveBtn.textContent = s.backToLive;
}

function renderUi(): void {
  const { activeTheme, redactMode, botAppearances, events } = state.payload;
  const locale = currentLocale();
  const s = tStrings(locale);
  const snap = currentDisplayedSnapshot();

  syncChromeLocale(locale);

  startupBtn.className =
    activeTheme === 'startup_office' ? 'bw-seg-btn bw-seg-btn-active' : 'bw-seg-btn';
  corpBtn.className =
    activeTheme === 'corporate_office' ? 'bw-seg-btn bw-seg-btn-active' : 'bw-seg-btn';

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
    locale,
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
      locale,
      onSelectCharacter: (botId, charId) => void setBotAppearance(botId, charId).catch(() => {}),
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
}

function applyIncomingPayload(nextPayload: BotWorldStatePayload): void {
  const locale = effectiveLocale(nextPayload.languageSetting, getHostLocale());
  const theme = getThemeConfig(nextPayload.activeTheme, locale);
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
      const fresh = await orca.plugin.request('botWorld.getState', { locale: getHostLocale() });
      applyIncomingPayload(fresh);
    }
  } catch {
    // Ignore RPC failure
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
    renderUi();
    const fresh = await orca.plugin.request('botWorld.getState', { locale: getHostLocale() });
    applyIncomingPayload(fresh);
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

window.addEventListener('beforeunload', () => {
  renderer.dispose();
});

void boot().catch(() => {});
