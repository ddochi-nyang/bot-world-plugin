export const TOOLTIP_HOVER_DELAY_MS = 260;
export const TOOLTIP_WARM_WINDOW_MS = 350;
export const TOOLTIP_GAP_PX = 8;
export const TOOLTIP_EDGE_PADDING_PX = 8;

export type TooltipRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type TooltipPosition = {
  left: number;
  top: number;
  placement: 'bottom' | 'top';
};

export function readTooltipAttributes(
  el: Element | null | undefined
): { text: string; kbd: string | null } | null {
  if (!el || typeof el.getAttribute !== 'function') return null;
  const rawTip = el.getAttribute('data-bw-tip');
  if (!rawTip) return null;
  const text = rawTip.trim();
  if (!text) return null;
  const rawKbd = el.getAttribute('data-bw-kbd');
  const kbd = rawKbd ? rawKbd.trim() : '';
  return { text, kbd: kbd.length > 0 ? kbd : null };
}

export function computeTooltipPosition(
  targetRect: TooltipRect,
  tipSize: { width: number; height: number },
  viewport: { width: number; height: number },
  gap: number = TOOLTIP_GAP_PX,
  padding: number = TOOLTIP_EDGE_PADDING_PX
): TooltipPosition {
  const vw = Math.max(padding * 2 + 1, viewport.width);
  const vh = Math.max(padding * 2 + 1, viewport.height);
  const tipW = Math.max(1, tipSize.width);
  const tipH = Math.max(1, tipSize.height);

  const centerX = targetRect.left + targetRect.width * 0.5;
  const rawLeft = Math.round(centerX - tipW * 0.5);
  const maxLeft = Math.max(padding, vw - tipW - padding);
  const left = Math.max(padding, Math.min(maxLeft, rawLeft));

  const belowTop = Math.round(targetRect.bottom + gap);
  const aboveTop = Math.round(targetRect.top - gap - tipH);

  let placement: 'bottom' | 'top' = 'bottom';
  let rawTop = belowTop;
  if (belowTop + tipH > vh - padding && aboveTop >= padding) {
    placement = 'top';
    rawTop = aboveTop;
  }

  const maxTop = Math.max(padding, vh - tipH - padding);
  const top = Math.max(padding, Math.min(maxTop, rawTop));

  return { left, top, placement };
}

export function setTooltip(
  el: HTMLElement,
  text: string,
  shortcut?: string | null
): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    clearTooltip(el);
    return;
  }
  el.setAttribute('data-bw-tip', trimmed);
  const kbd = shortcut ? shortcut.trim() : '';
  if (kbd.length > 0) {
    el.setAttribute('data-bw-kbd', kbd);
  } else if (typeof el.removeAttribute === 'function') {
    el.removeAttribute('data-bw-kbd');
  }
  // Remove native browser title so double overlapping tooltips never appear
  if (typeof el.removeAttribute === 'function') {
    el.removeAttribute('title');
  } else if ('title' in el) {
    el.title = '';
  }
}

export function clearTooltip(el: HTMLElement): void {
  if (typeof el.removeAttribute === 'function') {
    el.removeAttribute('data-bw-tip');
    el.removeAttribute('data-bw-kbd');
    el.removeAttribute('title');
  } else if ('title' in el) {
    el.title = '';
  }
}

export class TooltipController {
  private readonly root: HTMLElement;
  private readonly tipEl: HTMLDivElement;
  private readonly textEl: HTMLSpanElement;
  private readonly kbdEl: HTMLElement;
  private readonly nowMs: () => number;

  private activeTarget: HTMLElement | null = null;
  private pendingTarget: HTMLElement | null = null;
  private showTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHiddenAtMs = -Infinity;
  private disposed = false;

  constructor(root: HTMLElement, options?: { nowMs?: () => number }) {
    this.root = root;
    this.nowMs = options?.nowMs ?? (() => Date.now());

    this.tipEl = document.createElement('div');
    this.tipEl.className = 'bw-tooltip bw-hidden';
    this.tipEl.setAttribute('role', 'tooltip');
    this.tipEl.setAttribute('aria-hidden', 'true');

    this.textEl = document.createElement('span');
    this.textEl.className = 'bw-tooltip-text';
    this.kbdEl = document.createElement('kbd');
    this.kbdEl.className = 'bw-tooltip-kbd bw-hidden';

    this.tipEl.appendChild(this.textEl);
    this.tipEl.appendChild(this.kbdEl);

    if (typeof document !== 'undefined' && document.body) {
      document.body.appendChild(this.tipEl);
    }

    this.root.addEventListener('mouseover', this.handleMouseOver);
    this.root.addEventListener('mouseout', this.handleMouseOut);
    this.root.addEventListener('focusin', this.handleFocusIn);
    this.root.addEventListener('focusout', this.handleFocusOut);
    this.root.addEventListener('pointerdown', this.handleImmediateHide);
    this.root.addEventListener('click', this.handleImmediateHide);
    if (typeof document !== 'undefined') {
      document.addEventListener('scroll', this.handleImmediateHide, true);
      document.addEventListener('keydown', this.handleKeyDown);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('blur', this.handleImmediateHide);
      window.addEventListener('resize', this.handleImmediateHide);
    }
  }

  private findTooltipTarget(node: EventTarget | null): HTMLElement | null {
    if (!(node instanceof Element)) return null;
    const found = node.closest('[data-bw-tip]');
    if (!found || !(found instanceof HTMLElement)) return null;
    if (!this.root.contains(found)) return null;
    return found;
  }

  private clearShowTimer(): void {
    if (this.showTimer !== null) {
      clearTimeout(this.showTimer);
      this.showTimer = null;
    }
    this.pendingTarget = null;
  }

  private isWarm(): boolean {
    return this.nowMs() - this.lastHiddenAtMs <= TOOLTIP_WARM_WINDOW_MS;
  }

  private showFor(target: HTMLElement): void {
    if (this.disposed) return;
    if (!target.isConnected) {
      this.hide(false);
      return;
    }
    const attrs = readTooltipAttributes(target);
    if (!attrs) {
      this.hide(false);
      return;
    }

    this.activeTarget = target;
    this.textEl.textContent = attrs.text;
    if (attrs.kbd) {
      this.kbdEl.textContent = attrs.kbd;
      this.kbdEl.classList.remove('bw-hidden');
    } else {
      this.kbdEl.textContent = '';
      this.kbdEl.classList.add('bw-hidden');
    }

    this.tipEl.classList.remove('bw-hidden');
    this.tipEl.setAttribute('aria-hidden', 'false');

    const targetRect = target.getBoundingClientRect();
    const tipRect = this.tipEl.getBoundingClientRect();
    const vw = typeof window !== 'undefined' ? window.innerWidth : 800;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 600;
    const pos = computeTooltipPosition(
      targetRect,
      { width: tipRect.width || 120, height: tipRect.height || 26 },
      { width: vw, height: vh }
    );
    this.tipEl.style.left = `${pos.left}px`;
    this.tipEl.style.top = `${pos.top}px`;
    this.tipEl.setAttribute('data-placement', pos.placement);
  }

  hide(recordWarm = true): void {
    this.clearShowTimer();
    const wasVisible = this.activeTarget !== null;
    this.activeTarget = null;
    if (wasVisible && recordWarm) {
      this.lastHiddenAtMs = this.nowMs();
    }
    this.tipEl.classList.add('bw-hidden');
    this.tipEl.setAttribute('aria-hidden', 'true');
  }

  private readonly handleMouseOver = (ev: MouseEvent): void => {
    if (this.disposed) return;
    const target = this.findTooltipTarget(ev.target);
    if (!target) return;
    if (target === this.activeTarget || target === this.pendingTarget) return;

    const wasVisible = this.activeTarget !== null;
    this.clearShowTimer();
    if (wasVisible || this.isWarm()) {
      this.showFor(target);
      return;
    }

    this.pendingTarget = target;
    this.showTimer = setTimeout(() => {
      const t = this.pendingTarget;
      this.showTimer = null;
      this.pendingTarget = null;
      if (t && !this.disposed) {
        this.showFor(t);
      }
    }, TOOLTIP_HOVER_DELAY_MS);
  };

  private readonly handleMouseOut = (ev: MouseEvent): void => {
    const leaving = this.findTooltipTarget(ev.target);
    if (!leaving) return;
    const related = ev.relatedTarget;
    if (related instanceof Node && leaving.contains(related)) {
      return;
    }
    const entering = this.findTooltipTarget(related);
    if (entering && entering !== leaving) {
      this.hide(true);
      this.showFor(entering);
      return;
    }
    if (leaving === this.activeTarget || leaving === this.pendingTarget) {
      this.hide(true);
    }
  };

  private readonly handleFocusIn = (ev: FocusEvent): void => {
    if (this.disposed) return;
    const target = this.findTooltipTarget(ev.target);
    if (!target) return;
    let isFocusVisible = false;
    try {
      isFocusVisible = target.matches(':focus-visible');
    } catch {
      isFocusVisible = false;
    }
    if (isFocusVisible) {
      this.clearShowTimer();
      this.showFor(target);
    }
  };

  private readonly handleFocusOut = (ev: FocusEvent): void => {
    const leaving = this.findTooltipTarget(ev.target);
    if (leaving && leaving === this.activeTarget) {
      this.hide(false);
    }
  };

  private readonly handleImmediateHide = (): void => {
    this.hide(false);
  };

  private readonly handleKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      this.hide(false);
    }
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hide(false);
    this.root.removeEventListener('mouseover', this.handleMouseOver);
    this.root.removeEventListener('mouseout', this.handleMouseOut);
    this.root.removeEventListener('focusin', this.handleFocusIn);
    this.root.removeEventListener('focusout', this.handleFocusOut);
    this.root.removeEventListener('pointerdown', this.handleImmediateHide);
    this.root.removeEventListener('click', this.handleImmediateHide);
    if (typeof document !== 'undefined') {
      document.removeEventListener('scroll', this.handleImmediateHide, true);
      document.removeEventListener('keydown', this.handleKeyDown);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('blur', this.handleImmediateHide);
      window.removeEventListener('resize', this.handleImmediateHide);
    }
    if (this.tipEl.parentNode) {
      this.tipEl.parentNode.removeChild(this.tipEl);
    }
  }
}

export function attachTooltips(
  root: HTMLElement,
  options?: { nowMs?: () => number }
): TooltipController {
  return new TooltipController(root, options);
}
