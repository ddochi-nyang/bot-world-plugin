import { scrubAll } from '../src/redact.ts';
import {
  type AtmosphereMode,
  type ThemeId,
  type UiLocale,
  type WeatherMode,
  type WorldEventRecord,
  type WorldSnapshot,
  isValidThemeId,
  isWorkerActive,
} from '../src/types.ts';
import { resolveThemeName } from './assets-catalog.ts';
import { tStrings } from './i18n.ts';
import { atmosphereIcon, weatherIcon } from './shortcuts.ts';
import { resolveAtmospherePhase } from './stage-renderer.ts';
import { resolveWeatherKind } from './weather.ts';

export const PHOTO_CARD_BANNER_HEIGHT = 72;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PhotoCardMetadata = {
  title: string;
  themeName: string;
  atmosphereBadge: string;
  timestampLabel: string;
  bots: number;
  working: number;
  workers: number;
  events24h: number;
  redacted: boolean;
  redactBadgeLabel: string | null;
  kpiLabels: {
    bots: string;
    working: string;
    workers: string;
    events24h: string;
  };
};

export function buildPhotoCardFilename(
  themeId: ThemeId | string,
  timestampMs: number = Date.now()
): string {
  const safeTheme = isValidThemeId(themeId) ? themeId : 'startup_office';
  const ts = Number.isFinite(timestampMs) && timestampMs > 0 ? timestampMs : Date.now();
  const d = new Date(ts);
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `bot-world-${safeTheme}-${yyyy}${mm}${dd}-${hh}${min}.png`;
}

export function formatPhotoCardTimestamp(timestampMs: number): string {
  const ts = Number.isFinite(timestampMs) && timestampMs > 0 ? timestampMs : Date.now();
  const d = new Date(ts);
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

export function buildPhotoCardMetadata(input: {
  snapshot: WorldSnapshot;
  events: readonly WorldEventRecord[];
  themeId: ThemeId;
  atmosphereMode?: AtmosphereMode;
  weatherMode?: WeatherMode;
  redactMode: boolean;
  locale: UiLocale;
  timestampMs?: number;
}): PhotoCardMetadata {
  const s = tStrings(input.locale);
  const ts =
    typeof input.timestampMs === 'number' && Number.isFinite(input.timestampMs) && input.timestampMs > 0
      ? input.timestampMs
      : input.snapshot.capturedAt > 0
        ? input.snapshot.capturedAt
        : Date.now();

  const phase = resolveAtmospherePhase(input.atmosphereMode ?? 'auto', ts);
  const weatherKind = resolveWeatherKind(input.weatherMode ?? 'auto', phase, input.themeId);
  const botsList = Object.values(input.snapshot.bots);
  const bots = botsList.length;
  const working = botsList.filter((b) => b.status.kind === 'Working').length;
  const workers = Object.values(input.snapshot.workers).filter((w) => isWorkerActive(w)).length;
  const windowStart = ts - DAY_MS;
  const events24h = input.events.filter(
    (ev) =>
      ev &&
      typeof ev.timestampMs === 'number' &&
      Number.isFinite(ev.timestampMs) &&
      ev.timestampMs >= windowStart &&
      ev.timestampMs <= ts + 60_000
  ).length;

  return {
    title: scrubAll(s.statusBarBrand),
    themeName: scrubAll(resolveThemeName(input.themeId, input.locale)),
    atmosphereBadge: `${atmosphereIcon(phase)} ${s.atmosphereModes[phase]} · ${weatherIcon(weatherKind)} ${s.weatherModes[weatherKind]}`,
    timestampLabel: formatPhotoCardTimestamp(ts),
    bots,
    working,
    workers,
    events24h,
    redacted: Boolean(input.redactMode),
    redactBadgeLabel: input.redactMode ? s.photoCardRedactedBadge : null,
    kpiLabels: {
      bots: s.photoCardKpiBots,
      working: s.photoCardKpiWorking,
      workers: s.photoCardKpiWorkers,
      events24h: s.photoCardKpiEvents24h,
    },
  };
}

function drawRoundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rad = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

export function composePhotoCardCanvas(
  stageCanvas: HTMLCanvasElement,
  metadata: PhotoCardMetadata,
  createCanvas?: (width: number, height: number) => HTMLCanvasElement
): HTMLCanvasElement | null {
  const stageW = Math.max(1, Math.trunc(stageCanvas.width || 0));
  const stageH = Math.max(1, Math.trunc(stageCanvas.height || 0));
  const cardW = stageW;
  const cardH = stageH + PHOTO_CARD_BANNER_HEIGHT;

  const factory =
    createCanvas ??
    ((w: number, h: number): HTMLCanvasElement => {
      if (typeof document === 'undefined') {
        throw new Error('DOM canvas unavailable');
      }
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    });

  let card: HTMLCanvasElement;
  try {
    card = factory(cardW, cardH);
  } catch {
    return null;
  }
  if (card.width !== cardW) card.width = cardW;
  if (card.height !== cardH) card.height = cardH;

  const ctx = card.getContext('2d');
  if (!ctx) return null;

  ctx.save();
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, cardW, cardH);
  try {
    ctx.drawImage(stageCanvas, 0, 0, stageW, stageH);
  } catch {
    // Keep dark backdrop if stage canvas cannot be drawn in headless mocks
  }

  // Dark-glass bottom KPI strip
  const stripY = stageH;
  const grad = ctx.createLinearGradient(0, stripY, 0, cardH);
  grad.addColorStop(0, 'rgba(15, 23, 42, 0.96)');
  grad.addColorStop(1, 'rgba(9, 13, 24, 0.99)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, stripY, cardW, PHOTO_CARD_BANNER_HEIGHT);

  ctx.fillStyle = 'rgba(148, 163, 184, 0.28)';
  ctx.fillRect(0, stripY, cardW, 1);

  const fontScale = Math.max(0.74, Math.min(1.08, cardW / 1100));
  const padX = Math.round(16 * fontScale);
  const fontFamily = '"Pretendard", "Apple SD Gothic Neo", "Inter", system-ui, sans-serif';

  // Left: Title + Theme + Atmosphere/Weather + Redact badge + Timestamp
  let leftCursorX = padX;
  const topRowY = stripY + 24;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  ctx.font = `700 ${Math.round(15 * fontScale)}px ${fontFamily}`;
  ctx.fillStyle = '#f8fafc';
  ctx.fillText(metadata.title, leftCursorX, topRowY);
  leftCursorX += ctx.measureText(metadata.title).width + Math.round(10 * fontScale);

  const drawPill = (
    text: string,
    x: number,
    cy: number,
    bg: string,
    border: string,
    fg: string,
    fontPx: number
  ): number => {
    ctx.font = `600 ${fontPx}px ${fontFamily}`;
    const textW = ctx.measureText(text).width;
    const pillW = Math.round(textW + 14 * fontScale);
    const pillH = Math.round(22 * fontScale);
    drawRoundedRectPath(ctx, x, cy - pillH * 0.5, pillW, pillH, 999);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.fillText(text, x + pillW * 0.5, cy);
    ctx.textAlign = 'left';
    return pillW;
  };

  if (cardW >= 460) {
    leftCursorX +=
      drawPill(
        metadata.themeName,
        leftCursorX,
        topRowY,
        'rgba(56, 189, 248, 0.14)',
        'rgba(56, 189, 248, 0.42)',
        '#bae6fd',
        Math.round(11 * fontScale)
      ) + Math.round(6 * fontScale);
  }

  if (cardW >= 620) {
    leftCursorX +=
      drawPill(
        metadata.atmosphereBadge,
        leftCursorX,
        topRowY,
        'rgba(148, 163, 184, 0.14)',
        'rgba(148, 163, 184, 0.35)',
        '#e2e8f0',
        Math.round(11 * fontScale)
      ) + Math.round(6 * fontScale);
  }

  if (metadata.redacted && metadata.redactBadgeLabel) {
    drawPill(
      metadata.redactBadgeLabel,
      leftCursorX,
      topRowY,
      'rgba(250, 204, 21, 0.18)',
      'rgba(250, 204, 21, 0.65)',
      '#fde047',
      Math.round(10.5 * fontScale)
    );
  }

  ctx.font = `500 ${Math.round(11 * fontScale)}px ${fontFamily}`;
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(metadata.timestampLabel, padX, stripY + 50);

  // Right: KPI pills (Bots, Working, Workers, 24h Events)
  const kpiItems = [
    { label: metadata.kpiLabels.bots, value: String(metadata.bots), accent: '#e2e8f0' },
    { label: metadata.kpiLabels.working, value: String(metadata.working), accent: '#38bdf8' },
    { label: metadata.kpiLabels.workers, value: String(metadata.workers), accent: '#4ade80' },
    { label: metadata.kpiLabels.events24h, value: String(metadata.events24h), accent: '#facc15' },
  ];

  const pillGap = Math.round(6 * fontScale);
  let rightCursorX = cardW - padX;
  const kpiPillH = 40;
  const kpiCy = stripY + PHOTO_CARD_BANNER_HEIGHT * 0.5;

  for (let i = kpiItems.length - 1; i >= 0; i--) {
    const item = kpiItems[i];
    ctx.font = `700 ${Math.round(13 * fontScale)}px ${fontFamily}`;
    const valW = ctx.measureText(item.value).width;
    ctx.font = `600 ${Math.round(9.5 * fontScale)}px ${fontFamily}`;
    const lblW = ctx.measureText(item.label).width;
    const pillW = Math.max(Math.round(54 * fontScale), Math.round(Math.max(valW, lblW) + 18 * fontScale));
    const pillX = rightCursorX - pillW;
    if (pillX < cardW * 0.42 && i < kpiItems.length - 1) {
      break;
    }

    drawRoundedRectPath(ctx, pillX, kpiCy - kpiPillH * 0.5, pillW, kpiPillH, 8);
    ctx.fillStyle = 'rgba(30, 41, 59, 0.85)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.font = `700 ${Math.round(13 * fontScale)}px ${fontFamily}`;
    ctx.fillStyle = item.accent;
    ctx.fillText(item.value, pillX + pillW * 0.5, kpiCy - 7);

    ctx.font = `600 ${Math.round(9.5 * fontScale)}px ${fontFamily}`;
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(item.label, pillX + pillW * 0.5, kpiCy + 10);

    rightCursorX = pillX - pillGap;
  }

  ctx.restore();
  return card;
}

export async function downloadPhotoCardCanvas(
  canvas: HTMLCanvasElement,
  filename: string
): Promise<boolean> {
  if (
    typeof document === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function' ||
    typeof URL.revokeObjectURL !== 'function' ||
    typeof canvas.toBlob !== 'function'
  ) {
    return false;
  }

  const blob = await new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), 'image/png');
    } catch {
      resolve(null);
    }
  });
  if (!blob) return false;

  let objectUrl: string | null = null;
  let anchor: HTMLAnchorElement | null = null;
  try {
    objectUrl = URL.createObjectURL(blob);
    anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.className = 'bw-sr-only';
    document.body?.appendChild(anchor);
    anchor.click();
    return true;
  } catch {
    return false;
  } finally {
    if (anchor && anchor.parentNode) {
      anchor.parentNode.removeChild(anchor);
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
  }
}

export async function capturePhotoCard(
  stageCanvas: HTMLCanvasElement,
  input: Parameters<typeof buildPhotoCardMetadata>[0],
  createCanvas?: (width: number, height: number) => HTMLCanvasElement
): Promise<{ ok: boolean; filename: string; metadata: PhotoCardMetadata }> {
  const ts =
    typeof input.timestampMs === 'number' && Number.isFinite(input.timestampMs) && input.timestampMs > 0
      ? input.timestampMs
      : input.snapshot.capturedAt > 0
        ? input.snapshot.capturedAt
        : Date.now();
  const metadata = buildPhotoCardMetadata({ ...input, timestampMs: ts });
  const filename = buildPhotoCardFilename(input.themeId, ts);
  const card = composePhotoCardCanvas(stageCanvas, metadata, createCanvas);
  if (!card) {
    return { ok: false, filename, metadata };
  }
  const ok = await downloadPhotoCardCanvas(card, filename);
  return { ok, filename, metadata };
}
