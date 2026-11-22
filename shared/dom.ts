/**
 * Safe DOM helpers: uses strictly document.createElement, document.createTextNode,
 * textContent, and addEventListener without HTML string injection APIs.
 */

export type DomChild = Node | string | number | null | undefined | false;

export type DomAttrs = {
  className?: string;
  id?: string;
  title?: string;
  type?: string;
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
};

function isSafeLocalAssetSrc(src: string): boolean {
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
    if (attrs.title !== undefined) node.title = attrs.title;
    if (attrs.role !== undefined) node.setAttribute('role', attrs.role);
    if (attrs.ariaLabel !== undefined) node.setAttribute('aria-label', attrs.ariaLabel);
    if (attrs.ariaPressed !== undefined) node.setAttribute('aria-pressed', attrs.ariaPressed);
    if (attrs.type !== undefined && 'type' in node) {
      (node as HTMLInputElement).type = attrs.type;
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
