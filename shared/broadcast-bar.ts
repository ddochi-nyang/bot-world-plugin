import {
  type BroadcastChromaKey,
  type PetToyKind,
  type UiLocale,
  VALID_BROADCAST_CHROMA_KEYS,
} from '../src/types.ts';
import { el } from './dom.ts';
import { tStrings } from './i18n.ts';
import { svgIcon } from './icons.ts';
import { setTooltip } from './tooltip.ts';

export const BROADCAST_CHROMA_COLORS: Readonly<Record<BroadcastChromaKey, string>> = Object.freeze({
  green: '#00b140',
  blue: '#0047bb',
  black: '#000000',
  charcoal: '#11141b',
});

export function getBroadcastChromaColor(key: BroadcastChromaKey): string {
  return BROADCAST_CHROMA_COLORS[key] ?? BROADCAST_CHROMA_COLORS.green;
}

export class BroadcastBarController {
  readonly root: HTMLDivElement;
  private readonly pill: HTMLDivElement;
  private readonly swatchButtons = new Map<BroadcastChromaKey, HTMLButtonElement>();
  private readonly redactBtn: HTMLButtonElement;
  private readonly coffeeBtn: HTMLButtonElement;
  private readonly ballBtn: HTMLButtonElement;
  private readonly treatBtn: HTMLButtonElement;
  private readonly exitBtn: HTMLButtonElement;

  private hoverRevealTimer: ReturnType<typeof setTimeout> | null = null;
  private lastChromaKey: BroadcastChromaKey = 'green';
  private lastRedactMode = false;
  private lastLocale: UiLocale | null = null;

  constructor(options: {
    onSelectChroma: (key: BroadcastChromaKey) => void;
    onToggleRedact: () => void;
    onDropToy: (kind: PetToyKind) => void;
    onExit: () => void;
  }) {
    this.pill = el('div', {
      className: 'bw-broadcast-pill',
      role: 'toolbar',
    }) as HTMLDivElement;

    for (const key of VALID_BROADCAST_CHROMA_KEYS) {
      const btn = el('button', {
        type: 'button',
        className: `bw-chroma-swatch bw-chroma-swatch-${key}`,
        onClick: () => options.onSelectChroma(key),
      }) as HTMLButtonElement;
      this.swatchButtons.set(key, btn);
      this.pill.appendChild(btn);
    }

    this.pill.appendChild(el('span', { className: 'bw-broadcast-sep' }));

    this.redactBtn = el(
      'button',
      {
        type: 'button',
        className: 'bw-broadcast-mini-btn',
        onClick: options.onToggleRedact,
      },
      'R'
    ) as HTMLButtonElement;

    this.coffeeBtn = el(
      'button',
      {
        type: 'button',
        className: 'bw-broadcast-mini-btn',
        onClick: () => options.onDropToy('coffee'),
      },
      svgIcon('coffee', 12)
    ) as HTMLButtonElement;

    this.ballBtn = el(
      'button',
      {
        type: 'button',
        className: 'bw-broadcast-mini-btn',
        onClick: () => options.onDropToy('ball'),
      },
      svgIcon('ball', 12)
    ) as HTMLButtonElement;

    this.treatBtn = el(
      'button',
      {
        type: 'button',
        className: 'bw-broadcast-mini-btn',
        onClick: () => options.onDropToy('treat'),
      },
      svgIcon('cookie', 12)
    ) as HTMLButtonElement;

    this.exitBtn = el(
      'button',
      {
        type: 'button',
        className: 'bw-broadcast-mini-btn bw-broadcast-exit-btn',
        onClick: options.onExit,
      },
      'Exit'
    ) as HTMLButtonElement;

    this.pill.appendChild(this.redactBtn);
    this.pill.appendChild(this.coffeeBtn);
    this.pill.appendChild(this.ballBtn);
    this.pill.appendChild(this.treatBtn);
    this.pill.appendChild(el('span', { className: 'bw-broadcast-sep' }));
    this.pill.appendChild(this.exitBtn);

    this.root = el(
      'div',
      { className: 'bw-broadcast-hover-zone bw-hidden' },
      this.pill
    ) as HTMLDivElement;
  }

  revealTemporarily(): void {
    this.pill.classList.add('bw-broadcast-pill-visible');
    if (this.hoverRevealTimer !== null) {
      clearTimeout(this.hoverRevealTimer);
    }
    this.hoverRevealTimer = setTimeout(() => {
      this.hoverRevealTimer = null;
      this.pill.classList.remove('bw-broadcast-pill-visible');
    }, 1800);
  }

  update(options: {
    active: boolean;
    chromaKey: BroadcastChromaKey;
    redactMode: boolean;
    locale: UiLocale;
  }): void {
    this.root.classList.toggle('bw-hidden', !options.active);
    if (!options.active) {
      this.pill.classList.remove('bw-broadcast-pill-visible');
      if (this.hoverRevealTimer !== null) {
        clearTimeout(this.hoverRevealTimer);
        this.hoverRevealTimer = null;
      }
      return;
    }

    const s = tStrings(options.locale);
    const needsCopyUpdate =
      this.lastLocale !== options.locale ||
      this.lastChromaKey !== options.chromaKey ||
      this.lastRedactMode !== options.redactMode;

    if (needsCopyUpdate) {
      this.lastLocale = options.locale;
      this.lastChromaKey = options.chromaKey;
      this.lastRedactMode = options.redactMode;

      for (const [key, btn] of this.swatchButtons.entries()) {
        const isActive = key === options.chromaKey;
        btn.className = isActive
          ? `bw-chroma-swatch bw-chroma-swatch-${key} bw-chroma-swatch-active`
          : `bw-chroma-swatch bw-chroma-swatch-${key}`;
        btn.setAttribute('aria-pressed', String(isActive));
        btn.setAttribute('aria-label', s.broadcastChromaLabels[key]);
        setTooltip(btn, s.broadcastChromaLabels[key]);
      }

      this.redactBtn.textContent = options.redactMode ? s.broadcastRedactOn : s.broadcastRedactOff;
      this.redactBtn.className = options.redactMode
        ? 'bw-broadcast-mini-btn bw-broadcast-mini-btn-active'
        : 'bw-broadcast-mini-btn';
      setTooltip(this.redactBtn, s.tipRedact, 'R');

      setTooltip(this.coffeeBtn, s.petActionCoffeeTitle);
      setTooltip(this.ballBtn, s.petActionBallTitle);
      setTooltip(this.treatBtn, s.petActionTreatTitle);

      this.exitBtn.textContent = s.broadcastExitButton;
      setTooltip(this.exitBtn, s.broadcastExitTip, 'Esc');
    }
  }

  dispose(): void {
    if (this.hoverRevealTimer !== null) {
      clearTimeout(this.hoverRevealTimer);
      this.hoverRevealTimer = null;
    }
  }
}
