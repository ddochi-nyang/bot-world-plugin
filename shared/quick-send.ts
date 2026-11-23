import { scrubAll } from '../src/redact.ts';
import { type UiLocale, type WorldSnapshot, isSafeKey } from '../src/types.ts';
import { clearChildren, el } from './dom.ts';
import { getBotRedactedAlias, orderedSnapshotBotIds } from './filter.ts';
import { tStrings } from './i18n.ts';

export type QuickSendBarState = {
  snapshot: WorldSnapshot;
  selectedBotId: string | null;
  redactMode: boolean;
  allowQuickSend: boolean;
  demoMode: boolean;
  locale: UiLocale;
  sending: boolean;
};

export class QuickSendBar {
  readonly root: HTMLElement;
  private readonly targetSelect: HTMLSelectElement;
  readonly input: HTMLInputElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly readOnlyBadge: HTMLSpanElement;
  private readonly chipsWrap: HTMLDivElement;
  private readonly onSelectBot?: (botId: string) => void;
  private readonly onSend: (botId: string, message: string) => void;

  private lastTargetBotId: string | null = null;
  private lastLocale: UiLocale | null = null;
  private lastOptionSig = '';
  private currentAllowQuickSend = false;
  private currentDemoMode = false;
  private currentSending = false;

  constructor(options: {
    compact?: boolean;
    onSelectBot?: (botId: string) => void;
    onSend: (botId: string, message: string) => void;
  }) {
    this.onSelectBot = options.onSelectBot;
    this.onSend = options.onSend;

    this.targetSelect = el('select', {
      className: 'bw-select bw-quicksend-select',
      ariaLabel: 'Target bot',
      onChange: () => {
        const val = this.targetSelect.value;
        this.lastTargetBotId = val || null;
        if (val && this.onSelectBot) {
          this.onSelectBot(val);
        }
      },
    }) as HTMLSelectElement;

    this.input = el('input', {
      type: 'text',
      className: 'bw-quicksend-input',
      maxLength: 500,
      placeholder: 'Message selected bot… (Enter to send)',
      onKeyDown: (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) {
          ev.preventDefault();
          this.submit();
        } else if (ev.key === 'Escape') {
          ev.stopPropagation();
          this.input.blur();
        }
      },
    }) as HTMLInputElement;

    this.sendBtn = el(
      'button',
      {
        type: 'button',
        className: 'bw-btn bw-btn-primary bw-quicksend-btn',
        onClick: () => this.submit(),
      },
      '✈ Send'
    ) as HTMLButtonElement;

    this.readOnlyBadge = el('span', { className: 'bw-quicksend-ro-badge bw-hidden' }, 'Read-only');

    this.chipsWrap = el('div', { className: 'bw-quicksend-chips' }) as HTMLDivElement;

    const mainRow = el(
      'div',
      { className: 'bw-quicksend-row' },
      this.targetSelect,
      this.input,
      this.sendBtn,
      this.readOnlyBadge
    );

    this.root = el(
      'div',
      {
        className: options.compact ? 'bw-quicksend-bar bw-quicksend-bar-compact' : 'bw-quicksend-bar',
      },
      mainRow,
      this.chipsWrap
    );
  }

  private submit(): void {
    if (this.currentSending) return;
    const targetId = this.targetSelect.value;
    const msg = this.input.value.trim();
    if (!targetId || msg.length === 0) return;
    this.onSend(targetId, msg);
  }

  clearInput(): void {
    this.input.value = '';
  }

  update(state: QuickSendBarState): void {
    const s = tStrings(state.locale);
    this.currentAllowQuickSend = state.allowQuickSend;
    this.currentDemoMode = state.demoMode;
    this.currentSending = state.sending;

    const botIds = orderedSnapshotBotIds(state.snapshot);
    const optPairs: Array<{ id: string; label: string }> = botIds
      .filter((id) => isSafeKey(id) && Object.hasOwn(state.snapshot.bots, id))
      .map((id) => ({
        id,
        label: state.redactMode
          ? getBotRedactedAlias(id, state.snapshot, state.locale)
          : scrubAll(state.snapshot.bots[id].name),
      }));

    const sig = optPairs.map((o) => `${o.id}:${o.label}`).join('|');
    if (sig !== this.lastOptionSig) {
      this.lastOptionSig = sig;
      clearChildren(this.targetSelect);
      for (const pair of optPairs) {
        this.targetSelect.appendChild(
          el('option', { value: pair.id }, pair.label) as HTMLOptionElement
        );
      }
    }

    const desiredTarget =
      state.selectedBotId && optPairs.some((o) => o.id === state.selectedBotId)
        ? state.selectedBotId
        : this.lastTargetBotId && optPairs.some((o) => o.id === this.lastTargetBotId)
          ? this.lastTargetBotId
          : (optPairs[0]?.id ?? '');

    if (desiredTarget && this.targetSelect.value !== desiredTarget) {
      this.targetSelect.value = desiredTarget;
    }
    this.lastTargetBotId = desiredTarget || null;

    if (this.lastLocale !== state.locale) {
      this.lastLocale = state.locale;
      this.targetSelect.setAttribute('aria-label', s.quickSendTargetAria);
      this.input.placeholder = s.quickSendPlaceholder;
      this.input.setAttribute('aria-label', s.quickSendTitle);

      clearChildren(this.chipsWrap);
      for (const chip of s.quickSendChips) {
        this.chipsWrap.appendChild(
          el(
            'button',
            {
              type: 'button',
              className: 'bw-quicksend-chip',
              title: chip.prompt,
              onClick: () => {
                this.input.value = chip.prompt;
                this.input.focus();
              },
            },
            chip.label
          )
        );
      }
    }

    const canSend = optPairs.length > 0 && (state.demoMode || state.allowQuickSend);
    this.sendBtn.textContent = state.sending ? s.quickSendSending : s.quickSendButton;
    this.sendBtn.disabled = state.sending || optPairs.length === 0 || (!state.demoMode && !state.allowQuickSend);
    this.targetSelect.disabled = optPairs.length === 0;
    this.input.disabled = optPairs.length === 0;

    if (!state.demoMode && !state.allowQuickSend) {
      this.readOnlyBadge.textContent = s.quickSendReadOnlyBadge;
      this.readOnlyBadge.title = s.quickSendDisabledTooltip;
      this.readOnlyBadge.classList.remove('bw-hidden');
      this.sendBtn.title = s.quickSendDisabledTooltip;
      this.input.title = s.quickSendDisabledTooltip;
    } else {
      this.readOnlyBadge.classList.add('bw-hidden');
      this.sendBtn.title = canSend ? s.quickSendButton : '';
      this.input.title = '';
    }
  }
}
