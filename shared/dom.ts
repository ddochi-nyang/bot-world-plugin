/**
 * Safe DOM helpers: uses strictly document.createElement, document.createTextNode,
 * textContent, and addEventListener without HTML string injection APIs.
 */

export type DomChild = Node | string | number | null | undefined | false;

export type DomAttrs = {
  className?: string;
  id?: string;
  title?: string;
  tooltip?: string;
  tooltipKbd?: string;
  type?: string;
  accept?: string;
  disabled?: boolean;
  min?: string;
  max?: string;
  step?: string;
  value?: string;
  selected?: boolean;
  src?: string;
  alt?: string;
  role?: string;
  ariaLabel?: string;
  ariaPressed?: string;
  placeholder?: string;
  maxLength?: number;
  onClick?: (ev: MouseEvent) => void;
  onInput?: (ev: Event) => void;
  onChange?: (ev: Event) => void;
  onKeyDown?: (ev: KeyboardEvent) => void;
  onDragOver?: (ev: DragEvent) => void;
  onDragLeave?: (ev: DragEvent) => void;
  onDrop?: (ev: DragEvent) => void;
};

const SAFE_RASTER_DATA_URL_RE =
  /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_DOM_DATA_URL_CHARS = 512 * 1024;

function isSafeLocalAssetSrc(src: string): boolean {
  if (src.startsWith('data:')) {
    return src.length <= MAX_DOM_DATA_URL_CHARS && SAFE_RASTER_DATA_URL_RE.test(src);
  }
  if (!src.startsWith('../assets/')) return false;
  const rest = src.slice('../assets/'.length);
  if (rest.length === 0) return false;
  if (
    rest.includes('..') ||
    src.includes('\\') ||
    src.includes('://') ||
    src.includes('?') ||
    src.includes('#')
  ) {
    return false;
  }
  return true;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: DomAttrs | null,
  ...children: DomChild[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    if (attrs.className !== undefined) node.className = attrs.className;
    if (attrs.id !== undefined) node.id = attrs.id;
    if (attrs.tooltip !== undefined) {
      node.setAttribute('data-bw-tip', attrs.tooltip);
      if (attrs.tooltipKbd) {
        node.setAttribute('data-bw-kbd', attrs.tooltipKbd);
      }
    } else if (attrs.title !== undefined) {
      node.title = attrs.title;
    }
    if (attrs.role !== undefined) node.setAttribute('role', attrs.role);
    if (attrs.ariaLabel !== undefined) node.setAttribute('aria-label', attrs.ariaLabel);
    if (attrs.ariaPressed !== undefined) node.setAttribute('aria-pressed', attrs.ariaPressed);
    if (attrs.type !== undefined && 'type' in node) {
      (node as HTMLInputElement).type = attrs.type;
    }
    if (attrs.accept !== undefined && node instanceof HTMLInputElement) {
      node.accept = attrs.accept;
    }
    if (attrs.disabled !== undefined && 'disabled' in node) {
      (node as HTMLButtonElement).disabled = attrs.disabled;
    }
    if (attrs.min !== undefined && node instanceof HTMLInputElement) {
      node.min = attrs.min;
    }
    if (attrs.max !== undefined && node instanceof HTMLInputElement) {
      node.max = attrs.max;
    }
    if (attrs.step !== undefined && node instanceof HTMLInputElement) {
      node.step = attrs.step;
    }
    if (attrs.value !== undefined && 'value' in node) {
      (node as HTMLInputElement).value = attrs.value;
    }
    if (attrs.placeholder !== undefined && node instanceof HTMLInputElement) {
      node.placeholder = attrs.placeholder;
    }
    if (typeof attrs.maxLength === 'number' && 'maxLength' in node) {
      (node as HTMLInputElement).maxLength = attrs.maxLength;
    }
    if (attrs.selected !== undefined && typeof HTMLOptionElement !== 'undefined' && node instanceof HTMLOptionElement) {
      node.selected = attrs.selected;
    }
    if (attrs.src !== undefined && node instanceof HTMLImageElement) {
      // Only allow local relative asset paths (never external URLs, traversal, query, or fragment)
      if (isSafeLocalAssetSrc(attrs.src)) {
        node.src = attrs.src;
      }
    }
    if (attrs.alt !== undefined && node instanceof HTMLImageElement) {
      node.alt = attrs.alt;
    }
    if (attrs.onClick) {
      const onClick = attrs.onClick;
      node.addEventListener('click', (ev) => onClick(ev as MouseEvent));
    }
    if (attrs.onInput) {
      node.addEventListener('input', attrs.onInput);
    }
    if (attrs.onChange) {
      node.addEventListener('change', attrs.onChange);
    }
    if (attrs.onKeyDown) {
      node.addEventListener('keydown', (ev) => attrs.onKeyDown!(ev as KeyboardEvent));
    }
    if (attrs.onDragOver) {
      node.addEventListener('dragover', (ev) => attrs.onDragOver!(ev as DragEvent));
    }
    if (attrs.onDragLeave) {
      node.addEventListener('dragleave', (ev) => attrs.onDragLeave!(ev as DragEvent));
    }
    if (attrs.onDrop) {
      node.addEventListener('drop', (ev) => attrs.onDrop!(ev as DragEvent));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (child instanceof Node) {
      node.appendChild(child);
    } else {
      node.appendChild(document.createTextNode(String(child)));
    }
  }
  return node;
}

export function clearChildren(parent: HTMLElement): void {
  while (parent.firstChild) {
    parent.removeChild(parent.firstChild);
  }
}

export function setText(target: HTMLElement, text: string): void {
  target.textContent = text;
}
