import {
  type AtmosphereMode,
  type SoundMode,
  type ThemeId,
  type UiLocale,
  VALID_ATMOSPHERE_MODES,
  VALID_SOUND_MODES,
  VALID_THEME_IDS,
  VALID_WEATHER_MODES,
  type WeatherMode,
} from '../src/types.ts';
import { clearChildren, el } from './dom.ts';
import { tStrings } from './i18n.ts';

export type ShortcutAction =
  | 'toggleTheme'
  | 'toggleRedact'
  | 'toggleLanguage'
  | 'cycleAtmosphere'
  | 'cycleWeather'
  | 'toggleSound'
  | 'toggleDemo'
  | 'toggleReplayPlay'
  | 'toggleReport'
  | 'takePhotoCard'
  | 'toggleZones'
  | 'focusUrgent'
  | 'toggleFollowCam'
  | 'resetCamera'
  | 'focusSearch'
  | 'toggleCollabNetwork'
  | 'toggleHelp'
  | 'closeOrClearSelection';

export type ShortcutEventLike = {
  key?: string;
  target?: EventTarget | null;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
};

export function shouldIgnoreShortcutEvent(
  ev: ShortcutEventLike,
  options?: { modalOpen?: boolean }
): boolean {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) {
    return true;
  }
  const lowerKey = typeof ev.key === 'string' ? ev.key.toLowerCase() : '';
  if (lowerKey === 'escape') {
    return false;
  }
  const target = ev.target as { tagName?: unknown; isContentEditable?: unknown } | null | undefined;
  if (target && typeof target === 'object') {
    if (target.isContentEditable === true) {
      return true;
    }
    if (typeof target.tagName === 'string') {
      const tag = target.tagName.toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        return true;
      }
    }
  }
  if (options?.modalOpen) {
    return lowerKey !== '?' && lowerKey !== 'i';
  }
  return false;
}

export function mapKeyToShortcutAction(
  key: string,
  options?: { isEditor?: boolean; modalOpen?: boolean }
): ShortcutAction | null {
  if (typeof key !== 'string' || key.length === 0) return null;
  const lower = key.toLowerCase();
  if (options?.modalOpen) {
    if (key === '?') return 'toggleHelp';
    if (lower === 'i') return 'toggleReport';
    if (lower === 'escape') return 'closeOrClearSelection';
    return null;
  }
  if (key === '?') return 'toggleHelp';
  if (key === '/') return 'focusSearch';
  if (key === '0') return 'resetCamera';
  if (key === ' ' || key === 'Spacebar') {
    return options?.isEditor ? 'toggleReplayPlay' : null;
  }
  switch (lower) {
    case 't':
      return 'toggleTheme';
    case 'r':
      return 'toggleRedact';
    case 'l':
      return 'toggleLanguage';
    case 'a':
      return 'cycleAtmosphere';
    case 'w':
      return 'cycleWeather';
    case 'm':
      return 'toggleSound';
    case 'd':
      return 'toggleDemo';
    case 'i':
      return 'toggleReport';
    case 'p':
      return 'takePhotoCard';
    case 'z':
      return 'toggleZones';
    case 'n':
      return 'focusUrgent';
    case 'f':
      return 'toggleFollowCam';
    case 'c':
      return 'toggleCollabNetwork';
    case 'escape':
      return 'closeOrClearSelection';
    default:
      return null;
  }
}

export function nextThemeId(current: ThemeId): ThemeId {
  const idx = VALID_THEME_IDS.indexOf(current);
  if (idx < 0) return VALID_THEME_IDS[0];
  return VALID_THEME_IDS[(idx + 1) % VALID_THEME_IDS.length];
}

export function nextAtmosphereMode(current: AtmosphereMode): AtmosphereMode {
  const idx = VALID_ATMOSPHERE_MODES.indexOf(current);
  if (idx < 0) return 'auto';
  return VALID_ATMOSPHERE_MODES[(idx + 1) % VALID_ATMOSPHERE_MODES.length];
}

export function atmosphereIcon(mode: AtmosphereMode): string {
  switch (mode) {
    case 'auto':
      return '◐';
    case 'day':
      return '☀';
    case 'sunset':
      return '🌇';
    case 'night':
      return '🌙';
  }
}

export function nextWeatherMode(current: WeatherMode): WeatherMode {
  const idx = VALID_WEATHER_MODES.indexOf(current);
  if (idx < 0) return 'auto';
  return VALID_WEATHER_MODES[(idx + 1) % VALID_WEATHER_MODES.length];
}

export function weatherIcon(mode: WeatherMode): string {
  switch (mode) {
    case 'auto':
      return '🌦';
    case 'clear':
      return '🌤';
    case 'rain':
      return '🌧';
    case 'snow':
      return '❄';
    case 'starlight':
      return '✨';
  }
}

export function nextSoundMode(current: SoundMode): SoundMode {
  const idx = VALID_SOUND_MODES.indexOf(current);
  if (idx < 0) return 'off';
  return VALID_SOUND_MODES[(idx + 1) % VALID_SOUND_MODES.length];
}

export function soundIcon(mode: SoundMode): string {
  switch (mode) {
    case 'off':
      return '🔇';
    case 'chimes':
      return '🔔';
    case 'ambient':
      return '🎵';
  }
}

export function renderShortcutsModal(
  container: HTMLElement,
  options: {
    open: boolean;
    locale: UiLocale;
    isEditor: boolean;
    onClose: () => void;
  }
): void {
  clearChildren(container);
  container.classList.toggle('bw-hidden', !options.open);
  if (!options.open) {
    return;
  }
  const s = tStrings(options.locale);

  const rows: Array<{ keyLabel: string; description: string }> = [
    { keyLabel: 'N', description: s.shortcutFocusUrgent },
    { keyLabel: 'F', description: s.shortcutToggleFollow },
    { keyLabel: '0', description: s.shortcutResetCamera },
    { keyLabel: '/', description: s.shortcutFocusSearch },
    { keyLabel: 'C', description: s.shortcutToggleCollab },
    { keyLabel: 'T', description: s.shortcutToggleTheme },
    { keyLabel: 'R', description: s.shortcutToggleRedact },
    { keyLabel: 'L', description: s.shortcutSwitchLanguage },
    { keyLabel: 'A', description: s.shortcutCycleAtmosphere },
    { keyLabel: 'W', description: s.shortcutCycleWeather },
    { keyLabel: 'M', description: s.shortcutToggleSound },
    { keyLabel: 'D', description: s.shortcutToggleDemo },
    { keyLabel: 'I', description: s.shortcutToggleReport },
    { keyLabel: 'P', description: s.shortcutTakePhotoCard },
    { keyLabel: 'Z', description: s.shortcutToggleZones },
  ];
  if (options.isEditor) {
    rows.push({ keyLabel: 'Space', description: s.shortcutTogglePlay });
  }
  rows.push(
    { keyLabel: 'Esc', description: s.shortcutClearOrClose },
    { keyLabel: '?', description: s.shortcutShowHelp }
  );

  const listEl = el(
    'div',
    { className: 'bw-shortcuts-list' },
    ...rows.map((r) =>
      el(
        'div',
        { className: 'bw-shortcut-row' },
        el('kbd', { className: 'bw-kbd' }, r.keyLabel),
        el('span', { className: 'bw-shortcut-desc' }, r.description)
      )
    )
  );

  const dialog = el(
    'div',
    {
      className: 'bw-modal-dialog',
      role: 'dialog',
      ariaLabel: s.shortcutsTitle,
      onClick: (ev) => {
        ev.stopPropagation();
      },
    },
    el(
      'div',
      { className: 'bw-modal-header' },
      el(
        'div',
        null,
        el('div', { className: 'bw-modal-title' }, s.shortcutsTitle),
        el('div', { className: 'bw-modal-subtitle' }, s.shortcutsSubtitle)
      ),
      el(
        'button',
        {
          type: 'button',
          className: 'bw-btn bw-btn-ghost',
          ariaLabel: s.shortcutsClose,
          onClick: options.onClose,
        },
        '✕'
      )
    ),
    listEl
  );

  container.appendChild(dialog);
}
