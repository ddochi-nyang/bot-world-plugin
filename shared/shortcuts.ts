import {
  type AtmosphereMode,
  type ThemeId,
  type UiLocale,
  VALID_ATMOSPHERE_MODES,
  VALID_THEME_IDS,
} from '../src/types.ts';
import { clearChildren, el } from './dom.ts';
import { tStrings } from './i18n.ts';

export type ShortcutAction =
  | 'toggleTheme'
  | 'toggleRedact'
  | 'toggleLanguage'
  | 'cycleAtmosphere'
  | 'toggleDemo'
  | 'toggleReplayPlay'
  | 'toggleReport'
  | 'toggleHelp'
  | 'closeOrClearSelection';

export type ShortcutEventLike = {
  key?: string;
  target?: EventTarget | null;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
};

export function shouldIgnoreShortcutEvent(ev: ShortcutEventLike): boolean {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) {
    return true;
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
  return false;
}

export function mapKeyToShortcutAction(
  key: string,
  options?: { isEditor?: boolean }
): ShortcutAction | null {
  if (typeof key !== 'string' || key.length === 0) return null;
  if (key === '?') return 'toggleHelp';
  if (key === ' ' || key === 'Spacebar') {
    return options?.isEditor ? 'toggleReplayPlay' : null;
  }
  switch (key.toLowerCase()) {
    case 't':
      return 'toggleTheme';
    case 'r':
      return 'toggleRedact';
    case 'l':
      return 'toggleLanguage';
    case 'a':
      return 'cycleAtmosphere';
    case 'd':
      return 'toggleDemo';
    case 'i':
      return 'toggleReport';
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
    { keyLabel: 'T', description: s.shortcutToggleTheme },
    { keyLabel: 'R', description: s.shortcutToggleRedact },
    { keyLabel: 'L', description: s.shortcutSwitchLanguage },
    { keyLabel: 'A', description: s.shortcutCycleAtmosphere },
    { keyLabel: 'D', description: s.shortcutToggleDemo },
    { keyLabel: 'I', description: s.shortcutToggleReport },
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
