import { scrubAll } from '../src/redact.ts';
import {
  type BotWorldCreatorPack,
  type CreatorAssetsState,
  type UiLocale,
  type WorldSnapshot,
  isSafeKey,
  safeJsonParse,
  stripDangerousKeys,
  toPlainSafeRecord,
} from '../src/types.ts';
import { clearChildren, el } from './dom.ts';
import { getBotRedactedAlias, orderedSnapshotBotIds } from './filter.ts';
import { tStrings } from './i18n.ts';

export const ALLOWED_UPLOAD_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

export const MAX_RAW_UPLOAD_BYTES = 4 * 1024 * 1024;
export const AVATAR_SIZE_PX = 128;
export const MAX_AVATAR_DATA_URL_BYTES = 120 * 1024;
export const BG_MAX_WIDTH_PX = 1600;
export const BG_MAX_HEIGHT_PX = 1000;
export const BG_JPEG_QUALITY = 0.84;
export const MAX_BACKGROUND_DATA_URL_BYTES = 450 * 1024;
export const MAX_CREATOR_AVATARS = 24;
export const MAX_CREATOR_PACK_BYTES = 1_200 * 1024;
export const MAX_STORED_CREATOR_BYTES = 900 * 1024;
export const MAX_PACK_NAME_CHARS = 40;

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const SAFE_RASTER_DATA_URL_RE =
  /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const utf8Encoder = new TextEncoder();

export function utf8JsonBytes(value: unknown): number {
  return utf8Encoder.encode(JSON.stringify(value)).byteLength;
}

export function validateCustomAssetDataUrl(
  dataUrl: unknown,
  kind: 'avatar' | 'background'
): string | null {
  if (typeof dataUrl !== 'string') return null;
  if (dataUrl.length === 0 || dataUrl !== dataUrl.trim()) return null;
  const maxBytes =
    kind === 'avatar' ? MAX_AVATAR_DATA_URL_BYTES : MAX_BACKGROUND_DATA_URL_BYTES;
  if (dataUrl.length > maxBytes) return null;
  if (!SAFE_RASTER_DATA_URL_RE.test(dataUrl)) return null;
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx < 0 || dataUrl.length - (commaIdx + 1) < 8) return null;
  return dataUrl;
}

export function sanitizePackName(raw: unknown, fallback = 'Bot World Pack'): string {
  if (typeof raw !== 'string') return fallback;
  const collapsed = raw
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\/Users\/[^/\s]+/gi, '[PATH]')
    .replace(/\/home\/[^/\s]+/gi, '[PATH]')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, '[PATH]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!collapsed) return fallback;
  const scrubbed = scrubAll(collapsed).trim();
  const chars = Array.from(scrubbed || collapsed);
  if (chars.length <= MAX_PACK_NAME_CHARS) return chars.join('');
  return chars.slice(0, MAX_PACK_NAME_CHARS).join('').trim() || fallback;
}

export function createEmptyCreatorAssetsState(updatedAtMs = 0): CreatorAssetsState {
  return {
    packName: 'Custom Pack',
    customBackground: null,
    customAvatars: {},
    updatedAtMs,
  };
}

export function sanitizeCreatorAssetsState(
  raw: unknown,
  fallbackUpdatedAtMs = 0
): CreatorAssetsState {
  const empty = createEmptyCreatorAssetsState(fallbackUpdatedAtMs);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return empty;
  }
  const clean = stripDangerousKeys(raw as Record<string, unknown>);
  const packName = sanitizePackName(clean.packName, 'Custom Pack');
  const customBackground =
    clean.customBackground !== undefined && clean.customBackground !== null
      ? validateCustomAssetDataUrl(clean.customBackground, 'background')
      : null;

  const avatarMap = new Map<string, string>();
  if (
    clean.customAvatars &&
    typeof clean.customAvatars === 'object' &&
    !Array.isArray(clean.customAvatars)
  ) {
    for (const [key, val] of Object.entries(clean.customAvatars as Record<string, unknown>)) {
      if (avatarMap.size >= MAX_CREATOR_AVATARS) break;
      if (
        !isSafeKey(key) ||
        key.length > 128 ||
        CONTROL_CHAR_RE.test(key)
      ) {
        continue;
      }
      const validUrl = validateCustomAssetDataUrl(val, 'avatar');
      if (validUrl) {
        avatarMap.set(key, validUrl);
      }
    }
  }

  const updatedAtMs =
    typeof clean.updatedAtMs === 'number' &&
    Number.isFinite(clean.updatedAtMs) &&
    clean.updatedAtMs >= 0
      ? Math.trunc(clean.updatedAtMs)
      : fallbackUpdatedAtMs;

  const state: CreatorAssetsState = {
    packName,
    customBackground,
    customAvatars: toPlainSafeRecord(avatarMap),
    updatedAtMs,
  };

  if (utf8JsonBytes(state) > MAX_STORED_CREATOR_BYTES) {
    // Trim avatars from the end until stored payload fits cleanly within storage cap
    const keys = Object.keys(state.customAvatars);
    while (keys.length > 0 && utf8JsonBytes(state) > MAX_STORED_CREATOR_BYTES) {
      const k = keys.pop();
      if (k) delete state.customAvatars[k];
    }
    if (utf8JsonBytes(state) > MAX_STORED_CREATOR_BYTES) {
      state.customBackground = null;
    }
  }

  return state;
}

export type CreatorPackParseResult =
  | { ok: true; pack: BotWorldCreatorPack }
  | {
      ok: false;
      error:
        | 'too_large'
        | 'invalid_json'
        | 'invalid_version'
        | 'invalid_asset'
        | 'too_many_avatars';
    };

export function parseAndValidateCreatorPack(rawText: string): CreatorPackParseResult {
  if (typeof rawText !== 'string') {
    return { ok: false, error: 'invalid_json' };
  }
  if (utf8Encoder.encode(rawText).byteLength > MAX_CREATOR_PACK_BYTES) {
    return { ok: false, error: 'too_large' };
  }
  let parsed: unknown;
  try {
    parsed = safeJsonParse<unknown>(rawText, MAX_CREATOR_PACK_BYTES);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'invalid_json' };
  }
  const rec = parsed as Record<string, unknown>;
  if (rec.version !== 1) {
    return { ok: false, error: 'invalid_version' };
  }
  const packName = sanitizePackName(rec.packName, 'Custom Pack');

  let customBackground: string | null = null;
  if (rec.customBackground !== undefined && rec.customBackground !== null) {
    const validBg = validateCustomAssetDataUrl(rec.customBackground, 'background');
    if (!validBg) {
      return { ok: false, error: 'invalid_asset' };
    }
    customBackground = validBg;
  }

  const avatarMap = new Map<string, string>();
  if (rec.customAvatars !== undefined) {
    if (
      !rec.customAvatars ||
      typeof rec.customAvatars !== 'object' ||
      Array.isArray(rec.customAvatars)
    ) {
      return { ok: false, error: 'invalid_asset' };
    }
    const entries = Object.entries(rec.customAvatars as Record<string, unknown>);
    if (entries.length > MAX_CREATOR_AVATARS) {
      return { ok: false, error: 'too_many_avatars' };
    }
    for (const [key, val] of entries) {
      if (
        !isSafeKey(key) ||
        key.length > 128 ||
        CONTROL_CHAR_RE.test(key)
      ) {
        return { ok: false, error: 'invalid_asset' };
      }
      const validAvatar = validateCustomAssetDataUrl(val, 'avatar');
      if (!validAvatar) {
        return { ok: false, error: 'invalid_asset' };
      }
      avatarMap.set(key, validAvatar);
    }
  }

  const pack: BotWorldCreatorPack = {
    version: 1,
    packName,
    customBackground,
    customAvatars: toPlainSafeRecord(avatarMap),
  };

  if (utf8JsonBytes(pack) > MAX_CREATOR_PACK_BYTES) {
    return { ok: false, error: 'too_large' };
  }

  return { ok: true, pack };
}

export function resolveImportedPackAvatars(
  pack: BotWorldCreatorPack,
  botOrder: readonly string[]
): Record<string, string> {
  const out = new Map<string, string>();
  for (const [rawKey, url] of Object.entries(pack.customAvatars)) {
    if (out.size >= MAX_CREATOR_AVATARS) break;
    if (!isSafeKey(rawKey) || CONTROL_CHAR_RE.test(rawKey)) continue;
    const valid = validateCustomAssetDataUrl(url, 'avatar');
    if (!valid) continue;
    const slotMatch = /^slot-(\d+)$/.exec(rawKey);
    if (slotMatch) {
      const idx = Number(slotMatch[1]) - 1;
      const targetBotId = idx >= 0 && idx < botOrder.length ? botOrder[idx] : undefined;
      if (targetBotId && isSafeKey(targetBotId)) {
        out.set(targetBotId, valid);
        continue;
      }
    }
    out.set(rawKey, valid);
  }
  return toPlainSafeRecord(out);
}

export function buildCreatorPackFromState(
  state: CreatorAssetsState,
  options?: { packName?: string; botOrder?: readonly string[] }
): BotWorldCreatorPack {
  const avatarMap = new Map<string, string>();
  const botOrder = options?.botOrder ?? [];
  for (const [key, val] of Object.entries(state.customAvatars)) {
    if (avatarMap.size >= MAX_CREATOR_AVATARS) break;
    if (!isSafeKey(key) || CONTROL_CHAR_RE.test(key)) continue;
    const valid = validateCustomAssetDataUrl(val, 'avatar');
    if (!valid) continue;
    const idx = botOrder.indexOf(key);
    const exportKey =
      idx >= 0
        ? `slot-${idx + 1}`
        : scrubAll(key).replace(/[/\\]+/g, '_').slice(0, 64) || `slot-${avatarMap.size + 1}`;
    if (isSafeKey(exportKey)) {
      avatarMap.set(exportKey, valid);
    }
  }
  return {
    version: 1,
    packName: sanitizePackName(options?.packName ?? state.packName, 'Bot World Pack'),
    customBackground: state.customBackground
      ? validateCustomAssetDataUrl(state.customBackground, 'background')
      : null,
    customAvatars: toPlainSafeRecord(avatarMap),
  };
}

export function buildCreatorPackFilename(packName: string): string {
  const slug = sanitizePackName(packName, 'bot-world-pack')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'bot-world-pack'}.botworld-pack.json`;
}

export function downloadCreatorPack(pack: BotWorldCreatorPack): { ok: boolean; filename?: string } {
  if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
    return { ok: false };
  }
  const filename = buildCreatorPackFilename(pack.packName);
  const json = `${JSON.stringify(pack, null, 2)}\n`;
  let url: string | null = null;
  let anchor: HTMLAnchorElement | null = null;
  try {
    const blob = new Blob([json], { type: 'application/json' });
    url = URL.createObjectURL(blob);
    anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.className = 'bw-sr-only';
    document.body.appendChild(anchor);
    anchor.click();
    return { ok: true, filename };
  } catch {
    return { ok: false };
  } finally {
    if (anchor && anchor.parentNode) {
      anchor.parentNode.removeChild(anchor);
    }
    if (url) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Ignore revoke failure
      }
    }
  }
}

export type SanitizeUploadResult =
  | { ok: true; dataUrl: string }
  | { ok: false; reason: 'unsupported_type' | 'too_large' | 'decode_failed' | 'output_too_large' };

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image decode failed'));
    };
    img.src = url;
  });
}

export async function sanitizeUploadedImage(
  file: Pick<File, 'type' | 'size'> & Blob,
  kind: 'avatar' | 'background'
): Promise<SanitizeUploadResult> {
  const mime = typeof file.type === 'string' ? file.type.toLowerCase().trim() : '';
  if (!ALLOWED_UPLOAD_MIME_TYPES.has(mime)) {
    return { ok: false, reason: 'unsupported_type' };
  }
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_RAW_UPLOAD_BYTES) {
    return { ok: false, reason: 'too_large' };
  }
  if (typeof document === 'undefined') {
    return { ok: false, reason: 'decode_failed' };
  }

  let img: HTMLImageElement;
  try {
    img = await loadImageFromBlob(file);
  } catch {
    return { ok: false, reason: 'decode_failed' };
  }

  const nw = img.naturalWidth || img.width;
  const nh = img.naturalHeight || img.height;
  if (!nw || !nh || nw <= 0 || nh <= 0) {
    return { ok: false, reason: 'decode_failed' };
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { ok: false, reason: 'decode_failed' };
  }

  if (kind === 'avatar') {
    const side = Math.min(nw, nh);
    const sx = Math.floor((nw - side) * 0.5);
    const sy = Math.floor((nh - side) * 0.5);
    canvas.width = AVATAR_SIZE_PX;
    canvas.height = AVATAR_SIZE_PX;
    ctx.clearRect(0, 0, AVATAR_SIZE_PX, AVATAR_SIZE_PX);
    ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE_PX, AVATAR_SIZE_PX);
    const pngUrl = canvas.toDataURL('image/png');
    const valid = validateCustomAssetDataUrl(pngUrl, 'avatar');
    if (valid) {
      return { ok: true, dataUrl: valid };
    }
    // Fallback to 96x96 if 128x128 lossless PNG exceeded 120 KB
    canvas.width = 96;
    canvas.height = 96;
    ctx.clearRect(0, 0, 96, 96);
    ctx.drawImage(img, sx, sy, side, side, 0, 0, 96, 96);
    const smallerPng = validateCustomAssetDataUrl(canvas.toDataURL('image/png'), 'avatar');
    return smallerPng
      ? { ok: true, dataUrl: smallerPng }
      : { ok: false, reason: 'output_too_large' };
  }

  const scale = Math.min(BG_MAX_WIDTH_PX / nw, BG_MAX_HEIGHT_PX / nh, 1);
  const outW = Math.max(1, Math.round(nw * scale));
  const outH = Math.max(1, Math.round(nh * scale));
  canvas.width = outW;
  canvas.height = outH;
  ctx.fillStyle = '#0d1016';
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(img, 0, 0, nw, nh, 0, 0, outW, outH);

  let jpegUrl = validateCustomAssetDataUrl(
    canvas.toDataURL('image/jpeg', BG_JPEG_QUALITY),
    'background'
  );
  if (!jpegUrl) {
    jpegUrl = validateCustomAssetDataUrl(
      canvas.toDataURL('image/jpeg', 0.7),
      'background'
    );
  }
  return jpegUrl
    ? { ok: true, dataUrl: jpegUrl }
    : { ok: false, reason: 'output_too_large' };
}

export type CreatorStudioTab = 'avatars' | 'background';

export function creatorModalRenderKey(input: {
  open: boolean;
  tab: CreatorStudioTab;
  selectedBotId: string | null;
  redactMode: boolean;
  locale: UiLocale;
  demoMode: boolean;
  creatorAssets: CreatorAssetsState;
  statusMessage: string | null;
}): string {
  if (!input.open) return 'closed';
  return JSON.stringify({
    open: true,
    tab: input.tab,
    selectedBotId: input.selectedBotId,
    redactMode: input.redactMode,
    locale: input.locale,
    demoMode: input.demoMode,
    updatedAtMs: input.creatorAssets.updatedAtMs,
    packName: input.creatorAssets.packName,
    hasBg: Boolean(input.creatorAssets.customBackground),
    avatarKeys: Object.keys(input.creatorAssets.customAvatars).sort(),
    statusMessage: input.statusMessage,
  });
}

export function renderCreatorStudioModal(
  container: HTMLElement,
  options: {
    open: boolean;
    tab: CreatorStudioTab;
    onChangeTab: (tab: CreatorStudioTab) => void;
    snapshot: WorldSnapshot;
    selectedBotId: string | null;
    onChangeTargetBot: (botId: string) => void;
    creatorAssets: CreatorAssetsState;
    redactMode: boolean;
    locale: UiLocale;
    statusMessage: string | null;
    statusIsError?: boolean;
    onUploadAvatar: (botId: string, file: File) => void;
    onResetAvatar: (botId: string) => void;
    onUploadBackground: (file: File) => void;
    onResetBackground: () => void;
    onExportPack: () => void;
    onImportPackFile: (file: File) => void;
    onResetAll: () => void;
    onClose: () => void;
  }
): void {
  clearChildren(container);
  container.classList.toggle('bw-hidden', !options.open);
  if (!options.open) {
    return;
  }

  const s = tStrings(options.locale);
  const orderedIds = orderedSnapshotBotIds(options.snapshot);
  const targetBotId =
    options.selectedBotId && orderedIds.includes(options.selectedBotId)
      ? options.selectedBotId
      : (orderedIds[0] ?? null);

  const avatarsTabBtn = el(
    'button',
    {
      type: 'button',
      className: options.tab === 'avatars' ? 'bw-btn bw-btn-active' : 'bw-btn',
      tooltip: s.creatorTabAvatarsTip,
      onClick: () => options.onChangeTab('avatars'),
    },
    s.creatorTabAvatars
  );

  const bgTabBtn = el(
    'button',
    {
      type: 'button',
      className: options.tab === 'background' ? 'bw-btn bw-btn-active' : 'bw-btn',
      tooltip: s.creatorTabBackgroundTip,
      onClick: () => options.onChangeTab('background'),
    },
    s.creatorTabBackground
  );

  let bodyNode: HTMLElement;
  if (options.tab === 'avatars') {
    const botSelect = el('select', {
      className: 'bw-select bw-creator-select',
      ariaLabel: s.creatorSelectBotAria,
      tooltip: s.creatorSelectBotTip,
      onChange: () => {
        if (botSelect.value) {
          options.onChangeTargetBot(botSelect.value);
        }
      },
    }) as HTMLSelectElement;

    for (const id of orderedIds) {
      const bot = options.snapshot.bots[id];
      if (!bot) continue;
      const label = options.redactMode
        ? getBotRedactedAlias(id, options.snapshot, options.locale)
        : scrubAll(bot.name);
      botSelect.appendChild(
        el('option', { value: id, selected: id === targetBotId }, label) as HTMLOptionElement
      );
    }

    const activeAvatarUrl =
      targetBotId && Object.hasOwn(options.creatorAssets.customAvatars, targetBotId)
        ? validateCustomAssetDataUrl(options.creatorAssets.customAvatars[targetBotId], 'avatar')
        : null;

    const fileInput = el('input', {
      type: 'file',
      accept: 'image/png,image/jpeg,image/webp',
      className: 'bw-sr-only',
      onChange: () => {
        const f = fileInput.files?.[0];
        if (f && targetBotId) {
          options.onUploadAvatar(targetBotId, f);
        }
        fileInput.value = '';
      },
    }) as HTMLInputElement;

    const dropzone = el(
      'div',
      {
        className: 'bw-creator-dropzone',
        tooltip: s.creatorAvatarDropTip,
        onClick: () => {
          if (targetBotId) fileInput.click();
        },
        onDragOver: (ev) => {
          ev.preventDefault();
          dropzone.classList.add('bw-creator-dropzone-active');
        },
        onDragLeave: () => {
          dropzone.classList.remove('bw-creator-dropzone-active');
        },
        onDrop: (ev) => {
          ev.preventDefault();
          dropzone.classList.remove('bw-creator-dropzone-active');
          const f = ev.dataTransfer?.files?.[0];
          if (f && targetBotId) {
            options.onUploadAvatar(targetBotId, f);
          }
        },
      },
      activeAvatarUrl
        ? el('img', {
            className: 'bw-creator-avatar-preview',
            src: activeAvatarUrl,
            alt: s.creatorAvatarPreviewAlt,
          })
        : el('div', { className: 'bw-creator-preview-empty' }, '128×128'),
      el(
        'div',
        { className: 'bw-creator-drop-copy' },
        el('div', { className: 'bw-creator-drop-title' }, s.creatorAvatarDropTitle),
        el('div', { className: 'bw-creator-drop-sub' }, s.creatorAvatarDropSub)
      ),
      fileInput
    );

    bodyNode = el(
      'div',
      { className: 'bw-creator-section' },
      el(
        'div',
        { className: 'bw-creator-row' },
        botSelect,
        el(
          'button',
          {
            type: 'button',
            className: 'bw-btn',
            disabled: !targetBotId || !activeAvatarUrl,
            tooltip: s.creatorResetAvatarTip,
            onClick: () => {
              if (targetBotId) options.onResetAvatar(targetBotId);
            },
          },
          s.creatorResetAvatar
        )
      ),
      orderedIds.length === 0
        ? el('div', { className: 'bw-muted-note' }, s.creatorNoBots)
        : dropzone
    );
  } else {
    const activeBgUrl = options.creatorAssets.customBackground
      ? validateCustomAssetDataUrl(options.creatorAssets.customBackground, 'background')
      : null;

    const bgInput = el('input', {
      type: 'file',
      accept: 'image/png,image/jpeg,image/webp',
      className: 'bw-sr-only',
      onChange: () => {
        const f = bgInput.files?.[0];
        if (f) {
          options.onUploadBackground(f);
        }
        bgInput.value = '';
      },
    }) as HTMLInputElement;

    const dropzone = el(
      'div',
      {
        className: 'bw-creator-dropzone bw-creator-dropzone-bg',
        tooltip: s.creatorBgDropTip,
        onClick: () => bgInput.click(),
        onDragOver: (ev) => {
          ev.preventDefault();
          dropzone.classList.add('bw-creator-dropzone-active');
        },
        onDragLeave: () => {
          dropzone.classList.remove('bw-creator-dropzone-active');
        },
        onDrop: (ev) => {
          ev.preventDefault();
          dropzone.classList.remove('bw-creator-dropzone-active');
          const f = ev.dataTransfer?.files?.[0];
          if (f) {
            options.onUploadBackground(f);
          }
        },
      },
      activeBgUrl
        ? el('img', {
            className: 'bw-creator-bg-preview',
            src: activeBgUrl,
            alt: s.creatorBgPreviewAlt,
          })
        : el('div', { className: 'bw-creator-bg-empty' }, '1600×1000'),
      el(
        'div',
        { className: 'bw-creator-drop-copy' },
        el('div', { className: 'bw-creator-drop-title' }, s.creatorBgDropTitle),
        el('div', { className: 'bw-creator-drop-sub' }, s.creatorBgDropSub)
      ),
      bgInput
    );

    bodyNode = el(
      'div',
      { className: 'bw-creator-section' },
      dropzone,
      el(
        'div',
        { className: 'bw-creator-row' },
        el(
          'button',
          {
            type: 'button',
            className: 'bw-btn',
            disabled: !activeBgUrl,
            tooltip: s.creatorResetBgTip,
            onClick: options.onResetBackground,
          },
          s.creatorResetBg
        )
      )
    );
  }

  const packInput = el('input', {
    type: 'file',
    accept: '.json,.botworld-pack.json,application/json',
    className: 'bw-sr-only',
    onChange: () => {
      const f = packInput.files?.[0];
      if (f) {
        options.onImportPackFile(f);
      }
      packInput.value = '';
    },
  }) as HTMLInputElement;

  const avatarCount = Object.keys(options.creatorAssets.customAvatars).length;
  const hasAnyAssets = avatarCount > 0 || Boolean(options.creatorAssets.customBackground);

  const dialog = el(
    'div',
    {
      className: 'bw-modal-dialog bw-creator-dialog',
      role: 'dialog',
      ariaLabel: s.creatorModalTitle,
      onClick: (ev) => ev.stopPropagation(),
    },
    el(
      'div',
      { className: 'bw-modal-header' },
      el(
        'div',
        null,
        el('div', { className: 'bw-modal-title' }, s.creatorModalTitle),
        el('div', { className: 'bw-modal-subtitle' }, s.creatorModalSubtitle)
      ),
      el(
        'button',
        {
          type: 'button',
          className: 'bw-btn bw-btn-ghost',
          ariaLabel: s.creatorClose,
          tooltip: s.creatorClose,
          tooltipKbd: 'Esc',
          onClick: options.onClose,
        },
        '✕'
      )
    ),
    el('div', { className: 'bw-creator-tabs' }, avatarsTabBtn, bgTabBtn),
    bodyNode,
    options.statusMessage
      ? el(
          'div',
          {
            className: options.statusIsError
              ? 'bw-creator-status bw-creator-status-err'
              : 'bw-creator-status',
          },
          options.statusMessage
        )
      : null,
    el(
      'div',
      { className: 'bw-creator-footer' },
      el(
        'div',
        { className: 'bw-creator-pack-actions' },
        el(
          'button',
          {
            type: 'button',
            className: 'bw-btn',
            tooltip: s.creatorExportPackTip,
            onClick: options.onExportPack,
          },
          s.creatorExportPack
        ),
        el(
          'button',
          {
            type: 'button',
            className: 'bw-btn',
            tooltip: s.creatorImportPackTip,
            onClick: () => packInput.click(),
          },
          s.creatorImportPack
        ),
        packInput
      ),
      el(
        'button',
        {
          type: 'button',
          className: 'bw-btn bw-btn-ghost',
          disabled: !hasAnyAssets,
          tooltip: s.creatorResetAllTip,
          onClick: options.onResetAll,
        },
        s.creatorResetAll
      )
    )
  );

  container.appendChild(dialog);
}
