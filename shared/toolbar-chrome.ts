import {
  type AtmosphereMode,
  type SoundMode,
  type ThemeId,
  type UiLocale,
  VALID_THEME_IDS,
  type ViewMode,
  type WeatherMode,
  isValidThemeId,
} from '../src/types.ts';
import { el } from './dom.ts';
import { tStrings } from './i18n.ts';
import {
  atmosphereIconName,
  setButtonContent,
  soundIconName,
  svgIcon,
  weatherIconName,
} from './icons.ts';
import { setTooltip } from './tooltip.ts';

export type ToolbarMode = 'panel' | 'editor';

export type ToolbarSyncState = {
  mode: ToolbarMode;
  locale: UiLocale;
  themeId: ThemeId;
  atmosphereMode: AtmosphereMode;
  weatherMode: WeatherMode;
  soundMode: SoundMode;
  viewMode: ViewMode;
  redactMode: boolean;
  demoMode: boolean;
  roaming: boolean;
  showCollabNetwork: boolean;
  zonesActive: boolean;
  creatorOpen: boolean;
  reportOpen: boolean;
  shortcutsOpen: boolean;
  connected: boolean;
  retryAfterSecs: number | null;
  botCount: number;
  docReadOnly?: boolean;
};

export type ToolbarChromeHandlers = {
  onSelectTheme: (themeId: ThemeId) => void;
  onToggleViewMode: () => void;
  onToggleRoam: () => void;
  onToggleBroadcast: () => void;
  onCycleAtmosphere: () => void;
  onCycleWeather: () => void;
  onCycleSound: () => void;
  onFocusSpotlight: () => void;
  onToggleCollab: () => void;
  onToggleZones: () => void;
  onToggleCreatorStudio: () => void;
  onTakePhoto: () => void;
  onToggleReport: () => void;
  onToggleRedact: () => void;
  onToggleLanguage: () => void;
  onToggleDemo: () => void;
  onToggleHelp: () => void;
  onRefresh: () => void;
};

export type ToolbarChrome = {
  mode: ToolbarMode;
  root: HTMLElement;
  titleEl: HTMLElement;
  connPill: HTMLElement;
  docSyncPill: HTMLElement | null;
  themeSelect: HTMLSelectElement;
  themeOptions: Map<ThemeId, HTMLOptionElement>;
  viewModeBtn: HTMLButtonElement;
  roamBtn: HTMLButtonElement;
  broadcastBtn: HTMLButtonElement;
  atmoBtn: HTMLButtonElement;
  weatherBtn: HTMLButtonElement;
  soundBtn: HTMLButtonElement;
  focusBtn: HTMLButtonElement;
  collabBtn: HTMLButtonElement;
  zonesBtn: HTMLButtonElement;
  studioBtn: HTMLButtonElement;
  photoBtn: HTMLButtonElement;
  reportBtn: HTMLButtonElement;
  redactBtn: HTMLButtonElement;
  langBtn: HTMLButtonElement;
  demoBtn: HTMLButtonElement;
  helpBtn: HTMLButtonElement;
  refreshBtn: HTMLButtonElement;
};

export function createToolbarChrome(
  mode: ToolbarMode,
  initialLocale: UiLocale,
  handlers: ToolbarChromeHandlers
): ToolbarChrome {
  const s = tStrings(initialLocale);
  const isPanel = mode === 'panel';

  const titleEl = el(
    'span',
    {
      className: isPanel
        ? 'bw-title bw-tb-fixed bw-tb-w-title-panel'
        : 'bw-title bw-tb-fixed bw-tb-w-title-editor',
    },
    isPanel ? s.appTitlePanel : s.appTitleEditor
  );

  const connPill = el(
    'span',
    {
      className: isPanel
        ? 'bw-status-pill bw-tb-fixed bw-tb-w-conn-panel'
        : 'bw-status-pill bw-tb-fixed bw-tb-w-conn-editor',
    },
    s.connecting
  );

  const docSyncPill = isPanel
    ? null
    : el('span', { className: 'bw-chip bw-tb-fixed bw-tb-w-docsync' }, s.docSynced);

  const themeOptions = new Map<ThemeId, HTMLOptionElement>();
  const themeSelect = el('select', {
    className: isPanel
      ? 'bw-select bw-tb-fixed bw-tb-w-theme-panel'
      : 'bw-select bw-tb-fixed bw-tb-w-theme-editor',
    ariaLabel: s.themeAriaLabel,
    tooltip: s.tipThemeSelect,
    tooltipKbd: 'T',
    onChange: () => {
      const val = themeSelect.value;
      if (isValidThemeId(val)) {
        handlers.onSelectTheme(val);
      }
    },
  }) as HTMLSelectElement;

  for (const tid of VALID_THEME_IDS) {
    const opt = el(
      'option',
      { value: tid, selected: tid === 'startup_office' },
      isPanel ? s.themeShort[tid] : s.themeFull[tid]
    ) as HTMLOptionElement;
    themeOptions.set(tid, opt);
    themeSelect.appendChild(opt);
  }

  const fixedBtnClass = (slotClass: string) =>
    isPanel ? 'bw-btn bw-icon-btn' : `bw-btn bw-tb-fixed ${slotClass}`;
  const iconBtnClass = 'bw-btn bw-icon-btn';

  const viewModeBtn = el(
    'button',
    {
      type: 'button',
      className: isPanel
        ? 'bw-btn bw-tb-fixed bw-tb-w-view-panel'
        : 'bw-btn bw-tb-fixed bw-tb-w-view',
      tooltip: s.tipPetMode,
      tooltipKbd: 'G',
      ariaLabel: s.viewModeToggleTitle('office'),
      onClick: () => handlers.onToggleViewMode(),
    },
    svgIcon('paw'),
    el('span', { className: 'bw-btn-label' }, s.viewModePetButton)
  ) as HTMLButtonElement;

  const roamBtn = el(
    'button',
    {
      type: 'button',
      className: iconBtnClass,
      tooltip: s.tipRoam,
      tooltipKbd: 'V',
      ariaLabel: s.roamButtonTitle,
      onClick: () => handlers.onToggleRoam(),
    },
    svgIcon('walk')
  ) as HTMLButtonElement;

  const broadcastBtn = el(
    'button',
    {
      type: 'button',
      className: iconBtnClass,
      tooltip: s.tipStream,
      tooltipKbd: 'B',
      ariaLabel: s.broadcastButtonTitle,
      onClick: () => handlers.onToggleBroadcast(),
    },
    svgIcon('tv')
  ) as HTMLButtonElement;

  const atmoBtn = el(
    'button',
    {
      type: 'button',
      className: fixedBtnClass('bw-tb-w-atmo'),
      ariaLabel: s.atmosphereAriaLabel,
      tooltip: s.tipAtmosphere(s.atmosphereModes.auto),
      tooltipKbd: 'A',
      onClick: () => handlers.onCycleAtmosphere(),
    },
    svgIcon(atmosphereIconName('auto')),
    ...(isPanel ? [] : [el('span', { className: 'bw-btn-label' }, s.atmosphereModes.auto)])
  ) as HTMLButtonElement;

  const weatherBtn = el(
    'button',
    {
      type: 'button',
      className: fixedBtnClass('bw-tb-w-weather'),
      ariaLabel: s.weatherAriaLabel,
      tooltip: s.tipWeather(s.weatherModes.auto),
      tooltipKbd: 'W',
      onClick: () => handlers.onCycleWeather(),
    },
    svgIcon(weatherIconName('auto')),
    ...(isPanel ? [] : [el('span', { className: 'bw-btn-label' }, s.weatherModes.auto)])
  ) as HTMLButtonElement;

  const soundBtn = el(
    'button',
    {
      type: 'button',
      className: fixedBtnClass('bw-tb-w-sound'),
      ariaLabel: s.soundAriaLabel,
      tooltip: s.tipSound(s.soundModes.off),
      tooltipKbd: 'M',
      onClick: () => handlers.onCycleSound(),
    },
    svgIcon(soundIconName('off')),
    ...(isPanel ? [] : [el('span', { className: 'bw-btn-label' }, s.soundModes.off)])
  ) as HTMLButtonElement;

  const focusBtn = el(
    'button',
    {
      type: 'button',
      className: iconBtnClass,
      tooltip: s.tipFocus,
      tooltipKbd: 'N',
      ariaLabel: s.focusButtonTitle,
      onClick: () => handlers.onFocusSpotlight(),
    },
    svgIcon('crosshair')
  ) as HTMLButtonElement;

  const collabBtn = el(
    'button',
    {
      type: 'button',
      className: iconBtnClass,
      tooltip: s.tipCollab,
      tooltipKbd: 'C',
      ariaLabel: s.collabButtonTitle,
      onClick: () => handlers.onToggleCollab(),
    },
    svgIcon('network')
  ) as HTMLButtonElement;

  const zonesBtn = el(
    'button',
    {
      type: 'button',
      className: iconBtnClass,
      tooltip: s.tipZones,
      tooltipKbd: 'Z',
      ariaLabel: s.zonesButtonTitle,
      onClick: () => handlers.onToggleZones(),
    },
    svgIcon('map')
  ) as HTMLButtonElement;

  const studioBtn = el(
    'button',
    {
      type: 'button',
      className: iconBtnClass,
      tooltip: s.tipStudio,
      tooltipKbd: 'U',
      ariaLabel: s.studioButtonTitle,
      onClick: () => handlers.onToggleCreatorStudio(),
    },
    svgIcon('palette')
  ) as HTMLButtonElement;

  const photoBtn = el(
    'button',
    {
      type: 'button',
      className: iconBtnClass,
      tooltip: s.tipPhoto,
      tooltipKbd: 'P',
      ariaLabel: s.photoButtonTitle,
      onClick: () => handlers.onTakePhoto(),
    },
    svgIcon('camera')
  ) as HTMLButtonElement;

  const reportBtn = el(
    'button',
    {
      type: 'button',
      className: iconBtnClass,
      tooltip: s.tipReport,
      tooltipKbd: 'I',
      ariaLabel: s.reportButtonTitle,
      onClick: () => handlers.onToggleReport(),
    },
    svgIcon('bar-chart')
  ) as HTMLButtonElement;

  const redactBtn = el(
    'button',
    {
      type: 'button',
      className: fixedBtnClass('bw-tb-w-redact'),
      tooltip: s.tipRedact,
      tooltipKbd: 'R',
      ariaLabel: s.redactToggleTitle,
      onClick: () => handlers.onToggleRedact(),
    },
    svgIcon('eye'),
    ...(isPanel ? [] : [el('span', { className: 'bw-btn-label' }, s.redactOff)])
  ) as HTMLButtonElement;

  const langBtn = el(
    'button',
    {
      type: 'button',
      className: fixedBtnClass('bw-tb-w-lang'),
      tooltip: s.tipLanguage,
      tooltipKbd: 'L',
      ariaLabel: s.langToggleTitle,
      onClick: () => handlers.onToggleLanguage(),
    },
    svgIcon('globe'),
    ...(isPanel ? [] : [el('span', { className: 'bw-btn-label' }, s.langToggleText)])
  ) as HTMLButtonElement;

  const demoBtn = el(
    'button',
    {
      type: 'button',
      className: isPanel
        ? 'bw-btn bw-tb-fixed bw-tb-w-demo-panel'
        : 'bw-btn bw-tb-fixed bw-tb-w-demo',
      tooltip: s.tipDemo,
      tooltipKbd: 'D',
      ariaLabel: s.demoToggleTitle,
      onClick: () => handlers.onToggleDemo(),
    },
    svgIcon('play-circle'),
    el('span', { className: 'bw-btn-label' }, s.demoButton)
  ) as HTMLButtonElement;

  const helpBtn = el(
    'button',
    {
      type: 'button',
      className: iconBtnClass,
      tooltip: s.tipShortcuts,
      tooltipKbd: '?',
      ariaLabel: s.shortcutsButtonTitle,
      onClick: () => handlers.onToggleHelp(),
    },
    svgIcon('help-circle')
  ) as HTMLButtonElement;

  const refreshBtn = el(
    'button',
    {
      type: 'button',
      className: iconBtnClass,
      tooltip: s.tipRefresh,
      ariaLabel: s.refresh,
      onClick: () => handlers.onRefresh(),
    },
    svgIcon('refresh-cw')
  ) as HTMLButtonElement;

  const root = isPanel
    ? el(
        'div',
        { className: 'bw-toolbar bw-toolbar-panel' },
        el(
          'div',
          { className: 'bw-toolbar-row bw-toolbar-row-1' },
          el('div', { className: 'bw-toolbar-group bw-toolbar-group-left' }, titleEl, connPill),
          el(
            'div',
            { className: 'bw-toolbar-group bw-toolbar-group-right' },
            themeSelect,
            viewModeBtn,
            demoBtn
          )
        ),
        el(
          'div',
          { className: 'bw-toolbar-row bw-toolbar-row-2' },
          roamBtn,
          broadcastBtn,
          el('span', { className: 'bw-toolbar-sep' }),
          atmoBtn,
          weatherBtn,
          soundBtn,
          el('span', { className: 'bw-toolbar-sep' }),
          focusBtn,
          collabBtn,
          zonesBtn,
          studioBtn,
          photoBtn,
          reportBtn,
          el('span', { className: 'bw-toolbar-sep' }),
          redactBtn,
          langBtn,
          helpBtn,
          refreshBtn
        )
      )
    : el(
        'div',
        { className: 'bw-toolbar bw-toolbar-editor' },
        el(
          'div',
          { className: 'bw-toolbar-group bw-toolbar-group-left' },
          titleEl,
          connPill,
          docSyncPill
        ),
        el(
          'div',
          { className: 'bw-toolbar-group bw-toolbar-group-right' },
          themeSelect,
          viewModeBtn,
          roamBtn,
          broadcastBtn,
          el('span', { className: 'bw-toolbar-sep' }),
          atmoBtn,
          weatherBtn,
          soundBtn,
          el('span', { className: 'bw-toolbar-sep' }),
          focusBtn,
          collabBtn,
          zonesBtn,
          studioBtn,
          photoBtn,
          reportBtn,
          el('span', { className: 'bw-toolbar-sep' }),
          redactBtn,
          langBtn,
          demoBtn,
          helpBtn,
          refreshBtn
        )
      );

  return {
    mode,
    root,
    titleEl,
    connPill,
    docSyncPill,
    themeSelect,
    themeOptions,
    viewModeBtn,
    roamBtn,
    broadcastBtn,
    atmoBtn,
    weatherBtn,
    soundBtn,
    focusBtn,
    collabBtn,
    zonesBtn,
    studioBtn,
    photoBtn,
    reportBtn,
    redactBtn,
    langBtn,
    demoBtn,
    helpBtn,
    refreshBtn,
  };
}

export function syncToolbarChrome(chrome: ToolbarChrome, st: ToolbarSyncState): void {
  const s = tStrings(st.locale);
  const isPanel = chrome.mode === 'panel';
  const atmoLabel = s.atmosphereModes[st.atmosphereMode];
  const weatherLabel = s.weatherModes[st.weatherMode];
  const soundLabel = s.soundModes[st.soundMode];

  if (typeof document !== 'undefined') {
    document.documentElement.lang = st.locale;
    document.title = isPanel ? s.appTitlePanel : s.appTitleEditor;
  }
  chrome.titleEl.textContent = isPanel ? s.appTitlePanel : s.appTitleEditor;

  for (const [tid, opt] of chrome.themeOptions.entries()) {
    opt.textContent = isPanel ? s.themeShort[tid] : s.themeFull[tid];
  }
  chrome.themeSelect.value = st.themeId;
  chrome.themeSelect.setAttribute('aria-label', s.themeAriaLabel);
  setTooltip(chrome.themeSelect, s.tipThemeSelect, 'T');

  if (st.demoMode) {
    chrome.connPill.textContent = s.demoModeBadge(st.botCount);
  } else if (st.connected) {
    chrome.connPill.textContent = s.connectedBots(st.botCount);
  } else {
    chrome.connPill.textContent = st.retryAfterSecs
      ? s.offlineRetry(st.retryAfterSecs)
      : s.offline;
  }
  chrome.connPill.classList.toggle('bw-status-demo', st.demoMode);
  chrome.connPill.classList.toggle('bw-status-online', !st.demoMode && st.connected);
  chrome.connPill.classList.toggle('bw-status-offline', !st.demoMode && !st.connected);

  if (chrome.docSyncPill) {
    chrome.docSyncPill.textContent =
      st.demoMode || st.docReadOnly ? s.docReadOnly : s.docSynced;
  }

  setButtonContent(
    chrome.viewModeBtn,
    st.viewMode === 'pet' ? 'building' : 'paw',
    st.viewMode === 'pet' ? s.viewModeOfficeButton : s.viewModePetButton
  );
  setTooltip(
    chrome.viewModeBtn,
    st.viewMode === 'pet' ? s.tipOfficeMode : s.tipPetMode,
    'G'
  );
  chrome.viewModeBtn.setAttribute('aria-label', s.viewModeToggleTitle(st.viewMode));
  chrome.viewModeBtn.classList.toggle('bw-btn-active', st.viewMode === 'pet');

  setButtonContent(
    chrome.demoBtn,
    'play-circle',
    st.demoMode ? s.exitDemoOffice : s.demoButton
  );
  setTooltip(chrome.demoBtn, s.tipDemo, 'D');
  chrome.demoBtn.setAttribute('aria-label', s.demoToggleTitle);
  chrome.demoBtn.classList.toggle('bw-btn-active', st.demoMode);

  setButtonContent(chrome.roamBtn, 'walk');
  setTooltip(chrome.roamBtn, s.tipRoam, 'V');
  chrome.roamBtn.setAttribute('aria-label', s.roamButtonTitle);
  chrome.roamBtn.classList.toggle('bw-btn-active', st.roaming && st.viewMode === 'office');

  setButtonContent(chrome.broadcastBtn, 'tv');
  setTooltip(chrome.broadcastBtn, s.tipStream, 'B');
  chrome.broadcastBtn.setAttribute('aria-label', s.broadcastButtonTitle);
  chrome.broadcastBtn.classList.toggle('bw-btn-active', st.viewMode === 'broadcast');

  setButtonContent(
    chrome.atmoBtn,
    atmosphereIconName(st.atmosphereMode),
    isPanel ? undefined : atmoLabel
  );
  setTooltip(chrome.atmoBtn, s.tipAtmosphere(atmoLabel), 'A');
  chrome.atmoBtn.setAttribute('aria-label', `${s.atmosphereAriaLabel}: ${atmoLabel}`);
  chrome.atmoBtn.classList.toggle('bw-btn-active', st.atmosphereMode !== 'auto');

  setButtonContent(
    chrome.weatherBtn,
    weatherIconName(st.weatherMode),
    isPanel ? undefined : weatherLabel
  );
  setTooltip(chrome.weatherBtn, s.tipWeather(weatherLabel), 'W');
  chrome.weatherBtn.setAttribute('aria-label', `${s.weatherAriaLabel}: ${weatherLabel}`);
  chrome.weatherBtn.classList.toggle('bw-btn-active', st.weatherMode !== 'auto');

  setButtonContent(
    chrome.soundBtn,
    soundIconName(st.soundMode),
    isPanel ? undefined : soundLabel
  );
  setTooltip(chrome.soundBtn, s.tipSound(soundLabel), 'M');
  chrome.soundBtn.setAttribute('aria-label', `${s.soundAriaLabel}: ${soundLabel}`);
  chrome.soundBtn.classList.toggle('bw-btn-active', st.soundMode !== 'off');

  setButtonContent(chrome.focusBtn, 'crosshair');
  setTooltip(chrome.focusBtn, s.tipFocus, 'N');
  chrome.focusBtn.setAttribute('aria-label', s.focusButtonTitle);

  setButtonContent(chrome.collabBtn, 'network');
  setTooltip(chrome.collabBtn, s.tipCollab, 'C');
  chrome.collabBtn.setAttribute('aria-label', s.collabButtonTitle);
  chrome.collabBtn.classList.toggle('bw-btn-active', st.showCollabNetwork);

  setButtonContent(chrome.zonesBtn, 'map');
  setTooltip(chrome.zonesBtn, s.tipZones, 'Z');
  chrome.zonesBtn.setAttribute('aria-label', s.zonesButtonTitle);
  chrome.zonesBtn.classList.toggle('bw-btn-active', st.zonesActive);

  setButtonContent(chrome.studioBtn, 'palette');
  setTooltip(chrome.studioBtn, s.tipStudio, 'U');
  chrome.studioBtn.setAttribute('aria-label', s.studioButtonTitle);
  chrome.studioBtn.classList.toggle('bw-btn-active', st.creatorOpen);

  setButtonContent(chrome.photoBtn, 'camera');
  setTooltip(chrome.photoBtn, s.tipPhoto, 'P');
  chrome.photoBtn.setAttribute('aria-label', s.photoButtonTitle);

  setButtonContent(chrome.reportBtn, 'bar-chart');
  setTooltip(chrome.reportBtn, s.tipReport, 'I');
  chrome.reportBtn.setAttribute('aria-label', s.reportButtonTitle);
  chrome.reportBtn.classList.toggle('bw-btn-active', st.reportOpen);

  setButtonContent(
    chrome.redactBtn,
    st.redactMode ? 'eye-off' : 'eye',
    isPanel ? undefined : st.redactMode ? s.redactOn : s.redactOff
  );
  setTooltip(
    chrome.redactBtn,
    isPanel
      ? `${st.redactMode ? s.redactOn : s.redactOff} · ${s.tipRedact}`
      : s.tipRedact,
    'R'
  );
  chrome.redactBtn.setAttribute('aria-label', s.redactToggleTitle);
  chrome.redactBtn.classList.toggle('bw-btn-warn', st.redactMode);

  setButtonContent(chrome.langBtn, 'globe', isPanel ? undefined : s.langToggleText);
  setTooltip(chrome.langBtn, s.tipLanguage, 'L');
  chrome.langBtn.setAttribute('aria-label', s.langToggleTitle);
  chrome.langBtn.classList.toggle('bw-btn-active', isPanel && st.locale === 'ko');

  setButtonContent(chrome.helpBtn, 'help-circle');
  setTooltip(chrome.helpBtn, s.tipShortcuts, '?');
  chrome.helpBtn.setAttribute('aria-label', s.shortcutsButtonTitle);
  chrome.helpBtn.classList.toggle('bw-btn-active', st.shortcutsOpen);

  setButtonContent(chrome.refreshBtn, 'refresh-cw');
  setTooltip(chrome.refreshBtn, s.tipRefresh);
  chrome.refreshBtn.setAttribute('aria-label', s.refresh);
}

export function watchDocumentVisibility(
  onVisibilityChange: (visible: boolean) => void
): { isVisible: () => boolean; dispose: () => void } {
  let visible = typeof document !== 'undefined' ? !document.hidden : true;
  const handleVisibility = () => {
    const next = typeof document !== 'undefined' ? !document.hidden : true;
    if (next === visible) return;
    visible = next;
    onVisibilityChange(visible);
  };
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', handleVisibility);
  }
  return {
    isVisible: () => visible,
    dispose: () => {
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', handleVisibility);
      }
    },
  };
}
