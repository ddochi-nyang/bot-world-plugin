import { scrubAll } from '../src/redact.ts';
import {
  MAX_TEAM_ZONES,
  MAX_ZONE_LABEL_LENGTH,
  type TeamZone,
  type UiLocale,
  VALID_ZONE_COLORS,
  type ZoneColor,
  isValidZoneColor,
  sanitizeTeamZones,
  sanitizeZoneLabel,
  teamZonesEqual,
} from '../src/types.ts';
import { clearChildren, el } from './dom.ts';
import { tStrings } from './i18n.ts';

export {
  MAX_TEAM_ZONES,
  MAX_ZONE_LABEL_LENGTH,
  type TeamZone,
  VALID_ZONE_COLORS,
  type ZoneColor,
  isValidZoneColor,
  sanitizeTeamZones,
  sanitizeZoneLabel,
  teamZonesEqual,
};

export const STARTER_TEAM_ZONES: readonly TeamZone[] = Object.freeze([
  Object.freeze({
    id: 'zone-command',
    label: 'Command & Triage',
    x: 0.36,
    y: 0.16,
    w: 0.34,
    h: 0.34,
    color: 'cyan',
  }),
  Object.freeze({
    id: 'zone-security',
    label: 'Security & Review',
    x: 0.08,
    y: 0.44,
    w: 0.34,
    h: 0.44,
    color: 'amber',
  }),
  Object.freeze({
    id: 'zone-infra',
    label: 'Infra & Platform',
    x: 0.46,
    y: 0.52,
    w: 0.38,
    h: 0.4,
    color: 'violet',
  }),
]);

export function cloneStarterTeamZones(): TeamZone[] {
  return STARTER_TEAM_ZONES.map((z) => ({ ...z }));
}

export type ZoneColorPalette = {
  fill: string;
  border: string;
  pillBg: string;
  pillFg: string;
  swatchHex: string;
};

const ZONE_PALETTES: Readonly<Record<ZoneColor, ZoneColorPalette>> = Object.freeze({
  cyan: {
    fill: 'rgba(56, 189, 248, 0.12)',
    border: 'rgba(56, 189, 248, 0.62)',
    pillBg: 'rgba(12, 74, 110, 0.92)',
    pillFg: '#e0f2fe',
    swatchHex: '#38bdf8',
  },
  amber: {
    fill: 'rgba(251, 191, 36, 0.12)',
    border: 'rgba(251, 191, 36, 0.62)',
    pillBg: 'rgba(120, 53, 15, 0.92)',
    pillFg: '#fef3c7',
    swatchHex: '#fbbf24',
  },
  violet: {
    fill: 'rgba(167, 139, 250, 0.12)',
    border: 'rgba(167, 139, 250, 0.62)',
    pillBg: 'rgba(76, 29, 149, 0.92)',
    pillFg: '#ede9fe',
    swatchHex: '#a78bfa',
  },
  emerald: {
    fill: 'rgba(52, 211, 153, 0.12)',
    border: 'rgba(52, 211, 153, 0.62)',
    pillBg: 'rgba(6, 78, 59, 0.92)',
    pillFg: '#d1fae5',
    swatchHex: '#34d399',
  },
  rose: {
    fill: 'rgba(251, 113, 133, 0.12)',
    border: 'rgba(251, 113, 133, 0.62)',
    pillBg: 'rgba(136, 19, 55, 0.92)',
    pillFg: '#ffe4e6',
    swatchHex: '#fb7185',
  },
});

export function zoneColorPalette(color: ZoneColor): ZoneColorPalette {
  return ZONE_PALETTES[isValidZoneColor(color) ? color : 'cyan'];
}

export function formatZoneDisplayLabel(
  zone: TeamZone,
  index: number,
  redactMode: boolean,
  locale: UiLocale = 'en'
): string {
  const s = tStrings(locale);
  if (redactMode) {
    return s.zoneRedactedLabel(index + 1);
  }
  return scrubAll(sanitizeZoneLabel(zone.label, s.zoneRedactedLabel(index + 1)));
}

export function createNextZonePlacement(
  existing: readonly TeamZone[],
  rawLabel: string,
  color: ZoneColor
): TeamZone | null {
  if (existing.length >= MAX_TEAM_ZONES) return null;
  const idx = existing.length;
  const cols = 3;
  const col = idx % cols;
  const row = Math.floor(idx / cols) % 3;
  const x = Math.round((0.06 + col * 0.3) * 1000) / 1000;
  const y = Math.round((0.14 + row * 0.26) * 1000) / 1000;
  const usedIds = new Set(existing.map((z) => z.id));
  let suffix = idx + 1;
  while (usedIds.has(`zone-${suffix}`)) suffix += 1;
  const sanitized = sanitizeTeamZones([
    {
      id: `zone-${suffix}`,
      label: rawLabel,
      x,
      y,
      w: 0.28,
      h: 0.24,
      color,
    },
  ]);
  return sanitized[0] ?? null;
}

export function zonesModalRenderKey(opts: {
  open: boolean;
  zones: readonly TeamZone[];
  showZones: boolean;
  redactMode: boolean;
  locale: UiLocale;
  demoMode: boolean;
  persisted?: boolean;
  subtitle?: string;
}): string {
  if (!opts.open) return 'closed';
  return JSON.stringify({
    open: true,
    zones: opts.zones,
    showZones: opts.showZones,
    redactMode: opts.redactMode,
    locale: opts.locale,
    demoMode: opts.demoMode,
    persisted: opts.persisted !== false,
    subtitle: opts.subtitle ?? null,
  });
}

export function renderZonesModal(
  backdrop: HTMLElement,
  opts: {
    open: boolean;
    zones: readonly TeamZone[];
    showZones: boolean;
    redactMode: boolean;
    locale: UiLocale;
    persisted?: boolean;
    subtitle?: string;
    onToggleShowZones: () => void;
    onLoadStarterPreset: () => void;
    onAddZone: (label: string, color: ZoneColor) => void;
    onDeleteZone: (zoneId: string) => void;
    onClearZones: () => void;
    onClose: () => void;
  }
): void {
  clearChildren(backdrop);
  backdrop.classList.toggle('bw-hidden', !opts.open);
  if (!opts.open) {
    return;
  }

  const s = tStrings(opts.locale);
  const subtitleText =
    opts.subtitle ??
    (opts.persisted === false ? s.zonesModalPanelSubtitle : s.zonesModalSubtitle);
  const atLimit = opts.zones.length >= MAX_TEAM_ZONES;

  const labelInput = el('input', {
    type: 'text',
    className: 'bw-search-input bw-zone-input',
    maxLength: MAX_ZONE_LABEL_LENGTH,
    placeholder: s.zonesLabelPlaceholder,
    ariaLabel: s.zonesLabelPlaceholder,
  }) as HTMLInputElement;

  const colorSelect = el(
    'select',
    {
      className: 'bw-select',
      ariaLabel: s.zonesColorAriaLabel,
    },
    ...VALID_ZONE_COLORS.map((col) =>
      el('option', { value: col }, s.zoneColorNames[col])
    )
  ) as HTMLSelectElement;

  const submitNewZone = (): void => {
    if (atLimit) return;
    const label = sanitizeZoneLabel(
      labelInput.value,
      s.zoneRedactedLabel(opts.zones.length + 1)
    );
    const color = isValidZoneColor(colorSelect.value) ? colorSelect.value : 'cyan';
    labelInput.value = '';
    opts.onAddZone(label, color);
  };

  labelInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      submitNewZone();
    }
  });

  const addBtn = el(
    'button',
    {
      type: 'button',
      className: 'bw-btn bw-btn-primary',
      onClick: submitNewZone,
    },
    s.zonesAddButton
  ) as HTMLButtonElement;
  addBtn.disabled = atLimit;

  const listEl =
    opts.zones.length === 0
      ? el('div', { className: 'bw-muted-note' }, s.zonesEmptyNote)
      : el(
          'div',
          { className: 'bw-zones-list' },
          ...opts.zones.map((zone, idx) =>
            el(
              'div',
              { className: 'bw-zone-row' },
              el('span', { className: `bw-zone-dot bw-zone-dot-${zone.color}` }),
              el(
                'span',
                { className: 'bw-zone-row-label' },
                formatZoneDisplayLabel(zone, idx, opts.redactMode, opts.locale)
              ),
              el(
                'span',
                { className: 'bw-meta-time' },
                `${Math.round(zone.w * 100)}×${Math.round(zone.h * 100)}%`
              ),
              el(
                'button',
                {
                  type: 'button',
                  className: 'bw-btn bw-btn-ghost',
                  title: s.zonesDeleteTitle,
                  ariaLabel: s.zonesDeleteTitle,
                  onClick: () => opts.onDeleteZone(zone.id),
                },
                '✕'
              )
            )
          )
        );

  const clearBtn = el(
    'button',
    {
      type: 'button',
      className: 'bw-btn',
      onClick: opts.onClearZones,
    },
    s.zonesClearAll
  ) as HTMLButtonElement;
  clearBtn.disabled = opts.zones.length === 0;

  const dialog = el(
    'div',
    {
      className: 'bw-modal-dialog bw-zones-dialog',
      role: 'dialog',
      ariaLabel: s.zonesModalTitle,
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
        el('div', { className: 'bw-modal-title' }, s.zonesModalTitle),
        el('div', { className: 'bw-modal-subtitle' }, subtitleText)
      ),
      el(
        'button',
        {
          type: 'button',
          className: 'bw-btn bw-btn-ghost',
          ariaLabel: s.zonesClose,
          onClick: opts.onClose,
        },
        '✕'
      )
    ),
    el(
      'div',
      { className: 'bw-toolbar-group' },
      el(
        'button',
        {
          type: 'button',
          className: opts.showZones ? 'bw-btn bw-btn-active' : 'bw-btn',
          onClick: opts.onToggleShowZones,
        },
        opts.showZones ? s.zonesVisibleOn : s.zonesVisibleOff
      ),
      el(
        'button',
        {
          type: 'button',
          className: 'bw-btn',
          onClick: opts.onLoadStarterPreset,
        },
        s.zonesLoadPreset
      ),
      clearBtn
    ),
    el(
      'div',
      { className: 'bw-zones-add-row' },
      labelInput,
      colorSelect,
      addBtn
    ),
    atLimit ? el('div', { className: 'bw-muted-note' }, s.zonesLimitNote(MAX_TEAM_ZONES)) : null,
    listEl
  );

  backdrop.appendChild(dialog);
}
