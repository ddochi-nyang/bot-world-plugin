import { scrubAll } from '../src/redact.ts';
import {
  type BotActivityStatus,
  type BotState,
  type CharacterId,
  type ThemeId,
  type WorldSnapshot,
  botStatusLabelKo,
  isSafeKey,
  isWorkerUnverifiableWarning,
  isWorkerVisibleOnStage,
} from '../src/types.ts';
import {
  CHARACTER_SPECS,
  type ThemeConfig,
  getThemeConfig,
  resolveCharacterIdWithPrefs,
  resolveCharacterSpritePath,
  resolveThemeAssetPath,
} from './assets-catalog.ts';
import {
  type BubbleKind,
  type CarryProp,
  type Facing,
  type FlyingProp,
  MAX_BUBBLES,
  MAX_PARTICLES,
  type MotionDirector,
  type Particle,
  type Rect,
  type ReplayController,
} from './motion.ts';

const BOT_SPRITE_DESIGN_PX = 90;
const WORKER_SPRITE_DESIGN_PX = 74;

type ViewportTransform = {
  originX: number;
  originY: number;
  scale: number;
  designW: number;
  designH: number;
};

function createViewportTransform(
  availW: number,
  availH: number,
  designSize: [number, number]
): ViewportTransform {
  const designW = Math.max(1, designSize[0]);
  const designH = Math.max(1, designSize[1]);
  const w = Math.max(1, availW);
  const h = Math.max(1, availH);
  const scale = Math.min(w / designW, h / designH);
  return {
    originX: (w - designW * scale) * 0.5,
    originY: (h - designH * scale) * 0.5,
    scale,
    designW,
    designH,
  };
}

function designToScreen(vt: ViewportTransform, dx: number, dy: number): [number, number] {
  return [vt.originX + dx * vt.scale, vt.originY + dy * vt.scale];
}

function spriteBounds(
  vt: ViewportTransform,
  footX: number,
  footY: number,
  baseDesignPx: number,
  scale: number,
  anchor: [number, number],
  yBobPx: number
): Rect {
  const w = baseDesignPx * scale * vt.scale;
  const h = baseDesignPx * scale * vt.scale;
  const [sx, sy] = designToScreen(vt, footX, footY);
  return [sx - w * anchor[0], sy - h * anchor[1] + yBobPx, w, h];
}

function rectOverlapArea(a: Rect, b: Rect): number {
  const ox = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const oy = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return ox > 0 && oy > 0 ? ox * oy : 0;
}

function estimateBubbleWidth(text: string): number {
  let w = 22;
  for (const ch of text) {
    w += ch.charCodeAt(0) <= 127 ? 6.5 : 10.5;
  }
  return Math.max(72, Math.min(220, w));
}

function placeSpeechBubble(
  anchorX: number,
  anchorY: number,
  scale: number,
  estW: number,
  estH: number,
  stageBounds: Rect,
  obstacles: readonly Rect[]
): [number, number] {
  const [bgLeft, bgTop, bgRight, bgBottom] = stageBounds;
  const margin = 10;
  const minX = bgLeft + margin;
  const maxX = Math.max(minX, bgRight - estW - margin);
  const minY = bgTop + margin;
  const maxY = Math.max(minY, bgBottom - estH - margin);

  const baseX = Math.max(minX, Math.min(maxX, anchorX - estW * 0.5));
  const baseY = Math.max(minY, Math.min(maxY, anchorY - 116 * scale));

  const stepY = estH + 8;
  const stepX = Math.max(52, estW * 0.52);
  const dirs: ReadonlyArray<[number, number]> = [
    [0, -1],
    [0.8, -0.8],
    [-0.8, -0.8],
    [1, 0],
    [-1, 0],
    [0.8, 0.8],
    [-0.8, 0.8],
    [0, 1],
  ];
  const rings = [0.85, 1.5, 2.25, 3.2, 4.4];

  const candidates: Array<[number, number]> = [[baseX, baseY]];
  for (const ring of rings) {
    for (const [dx, dy] of dirs) {
      candidates.push([
        Math.max(minX, Math.min(maxX, baseX + dx * stepX * ring)),
        Math.max(minY, Math.min(maxY, baseY + dy * stepY * ring)),
      ]);
    }
  }

  let best = candidates[0];
  let bestHasOverlap = true;
  let bestOverlap = Infinity;
  let bestPaddedOverlap = Infinity;
  let bestDist = Infinity;

  for (const [cx, cy] of candidates) {
    const rect: Rect = [cx, cy, estW, estH];
    const padded: Rect = [cx - 4, cy - 4, estW + 8, estH + 8];
    let overlap = 0;
    let paddedOverlap = 0;
    for (const ob of obstacles) {
      overlap += rectOverlapArea(rect, ob);
      paddedOverlap += rectOverlapArea(padded, ob);
    }
    const dist = Math.hypot(cx - baseX, cy - baseY);
    const hasOverlap = overlap > 0;
    let isBetter = false;
    if (!hasOverlap && bestHasOverlap) isBetter = true;
    else if (hasOverlap && !bestHasOverlap) isBetter = false;
    else if (!hasOverlap && !bestHasOverlap) {
      isBetter = dist + paddedOverlap * 0.05 < bestDist + bestPaddedOverlap * 0.05;
    } else {
      isBetter = overlap * 100 + dist < bestOverlap * 100 + bestDist;
    }
    if (isBetter) {
      best = [cx, cy];
      bestHasOverlap = hasOverlap;
      bestOverlap = overlap;
      bestPaddedOverlap = paddedOverlap;
      bestDist = dist;
    }
  }
  return best;
}

function shortToolName(tool: string): string {
  switch (tool) {
    case 'run_command':
      return 'Cmd';
    case 'edit_file':
      return 'Edit';
    case 'write_file':
      return 'Write';
    case 'read_file':
      return 'Read';
    case 'search_web':
      return 'Web';
    case 'call_mcp_tool':
      return 'MCP';
    case 'execute':
      return 'Exec';
    default:
      return tool;
  }
}

function classifyToolGlyph(tool: string | null): string {
  if (!tool) return '⚙';
  const lower = tool.toLowerCase();
  if (['bash', 'run_command', 'execute', 'cmd', 'exec'].includes(lower)) return '>_';
  if (['edit', 'write', 'edit_file', 'write_file'].includes(lower)) return '✎';
  if (['read', 'grep', 'glob', 'read_file', 'search_web', 'web'].includes(lower)) return '🔍';
  return '⚙';
}

function shortProvider(provider: string): string {
  if (provider === 'antigravity') return 'agy';
  return provider;
}

function statusBadgeStyle(
  status: BotActivityStatus,
  redactMode: boolean
): { text: string; bg: string; fg: string } {
  switch (status.kind) {
    case 'Working': {
      const text =
        redactMode || !status.tool || status.tool.length === 0
          ? '▶ 작업 중'
          : `▶ ${scrubAll(shortToolName(status.tool))}`;
      return { text, bg: '#1d4ed8', fg: '#ffffff' };
    }
    case 'Idle':
      return { text: '● 대기', bg: 'rgba(22, 101, 52, 0.9)', fg: '#dcfce7' };
    case 'WaitingAnswer':
      return { text: '… 응답', bg: '#b45309', fg: '#fef3c7' };
    case 'Blocked':
      return { text: '■ 차단', bg: '#ea580c', fg: '#ffffff' };
    case 'NeedsOwner': {
      const text = status.optionsCount > 0 ? `★ 결정 (${status.optionsCount})` : '★ 결정';
      return { text, bg: '#eab308', fg: '#422006' };
    }
    case 'Error':
      return { text: '! 오류', bg: '#dc2626', fg: '#ffffff' };
    case 'Paused':
      return { text: 'Zzz 정지', bg: '#475569', fg: '#e2e8f0' };
  }
}

function drawRoundedRect(
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

function truncateTextToWidth(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const chars = Array.from(text);
  let out = '';
  for (const ch of chars) {
    if (ctx.measureText(`${out}${ch}…`).width > maxWidth) {
      return `${out}…`;
    }
    out += ch;
  }
  return out;
}

function bubbleColors(kind: BubbleKind): { bg: string; border: string; fg: string } {
  switch (kind) {
    case 'Normal':
      return { bg: 'rgba(250, 250, 250, 0.95)', border: 'rgba(63, 63, 70, 0.8)', fg: '#18181b' };
    case 'Question':
      return { bg: 'rgba(239, 246, 255, 0.95)', border: 'rgba(59, 130, 246, 0.92)', fg: '#1e3a8a' };
    case 'Alert':
      return { bg: 'rgba(254, 242, 242, 0.96)', border: 'rgba(239, 68, 68, 0.92)', fg: '#7f1d1d' };
    case 'Success':
      return { bg: 'rgba(240, 253, 244, 0.96)', border: 'rgba(34, 197, 94, 0.92)', fg: '#14532d' };
    case 'Boss':
      return { bg: 'rgba(254, 252, 232, 0.96)', border: 'rgba(234, 179, 8, 0.92)', fg: '#713f12' };
  }
}

export type StageRenderInput = {
  snapshot: WorldSnapshot;
  themeId: ThemeId;
  selectedBotId: string | null;
  redactMode: boolean;
  botAppearances: Record<string, CharacterId>;
  motion: MotionDirector;
  replay?: ReplayController | null;
};

type HitBox = {
  botId: string;
  rect: Rect;
};

export class StageRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly imageCache = new Map<string, HTMLImageElement>();
  private readonly onSelectBot: (botId: string) => void;
  private readonly onHoverBot?: (botId: string | null) => void;
  private lastInput: StageRenderInput | null = null;
  private hitBoxes: HitBox[] = [];
  private rafId: number | null = null;
  private lastFrameMs = 0;
  private animTick = 0;
  private tickAccumulatorMs = 0;
  private resizeObserver: ResizeObserver | null = null;
  private destroyed = false;

  constructor(
    canvas: HTMLCanvasElement,
    options: {
      onSelectBot: (botId: string) => void;
      onHoverBot?: (botId: string | null) => void;
    }
  ) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('2D canvas context unavailable');
    }
    this.ctx = ctx;
    this.onSelectBot = options.onSelectBot;
    this.onHoverBot = options.onHoverBot;

    this.canvas.addEventListener('click', this.handleClick);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerleave', this.handlePointerLeave);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.resizeCanvas();
        this.renderNow();
      });
      this.resizeObserver.observe(this.canvas);
    }
    this.resizeCanvas();
  }

  private loadImage(safePath: string): HTMLImageElement | null {
    const cached = this.imageCache.get(safePath);
    if (cached) {
      return cached.complete && cached.naturalWidth > 0 ? cached : null;
    }
    const img = new Image();
    img.onload = () => {
      if (!this.destroyed) {
        this.renderNow();
      }
    };
    img.src = safePath;
    this.imageCache.set(safePath, img);
    return img.complete && img.naturalWidth > 0 ? img : null;
  }

  private resizeCanvas(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const targetW = Math.max(1, Math.round(rect.width * dpr));
    const targetH = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
  }

  update(input: StageRenderInput): void {
    this.lastInput = input;
    const theme = getThemeConfig(input.themeId);
    input.motion.syncLayout(input.snapshot, theme);
    this.renderNow();
    this.ensureAnimationLoopIfNeeded();
  }

  private shouldAnimate(input: StageRenderInput): boolean {
    if (input.motion.hasActiveAnimations()) return true;
    if (input.replay?.isReplay) {
      return input.replay.isPlaying;
    }
    for (const bot of Object.values(input.snapshot.bots)) {
      if (
        bot.status.kind === 'Working' ||
        bot.status.kind === 'NeedsOwner' ||
        bot.status.kind === 'Blocked'
      ) {
        return true;
      }
    }
    return false;
  }

  private ensureAnimationLoopIfNeeded(): void {
    if (this.destroyed || !this.lastInput) return;
    if (this.shouldAnimate(this.lastInput)) {
      if (this.rafId === null) {
        this.lastFrameMs = performance.now();
        this.rafId = requestAnimationFrame(this.frameLoop);
      }
    } else if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private readonly frameLoop = (nowMs: number): void => {
    this.rafId = null;
    if (this.destroyed || !this.lastInput) return;

    const dtMs = Math.max(0, Math.min(250, nowMs - this.lastFrameMs));
    this.lastFrameMs = nowMs;
    const dtSecs = dtMs / 1000;

    this.tickAccumulatorMs += dtMs;
    if (this.tickAccumulatorMs >= 420) {
      this.animTick += 1;
      this.tickAccumulatorMs %= 420;
    }

    const input = this.lastInput;
    const theme = getThemeConfig(input.themeId);
    if (input.replay?.isReplay && input.replay.isPlaying) {
      // Replay controller advances its own motion director when playing
    } else {
      input.motion.step(dtSecs, input.snapshot, theme);
    }

    this.renderNow();
    this.ensureAnimationLoopIfNeeded();
  };

  private readonly handleClick = (ev: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    for (let i = this.hitBoxes.length - 1; i >= 0; i--) {
      const hb = this.hitBoxes[i];
      const [rx, ry, rw, rh] = hb.rect;
      if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) {
        this.onSelectBot(hb.botId);
        return;
      }
    }
  };

  private readonly handlePointerMove = (ev: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    let hovered: string | null = null;
    for (let i = this.hitBoxes.length - 1; i >= 0; i--) {
      const hb = this.hitBoxes[i];
      const [rx, ry, rw, rh] = hb.rect;
      if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) {
        hovered = hb.botId;
        break;
      }
    }
    this.canvas.style.cursor = hovered ? 'pointer' : 'default';
    this.onHoverBot?.(hovered);
  };

  private readonly handlePointerLeave = (): void => {
    this.canvas.style.cursor = 'default';
    this.onHoverBot?.(null);
  };

  renderNow(): void {
    const input = this.lastInput;
    if (!input) return;

    this.resizeCanvas();
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const cssW = this.canvas.width / dpr;
    const cssH = this.canvas.height / dpr;
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // Stage background
    ctx.fillStyle = '#1c1917';
    ctx.fillRect(0, 0, cssW, cssH);

    const theme: ThemeConfig = getThemeConfig(input.themeId);
    const vt = createViewportTransform(cssW, cssH, theme.designSize);
    const bgW = vt.designW * vt.scale;
    const bgH = vt.designH * vt.scale;
    const bgImg = this.loadImage(resolveThemeAssetPath(input.themeId));
    if (bgImg) {
      ctx.drawImage(bgImg, vt.originX, vt.originY, bgW, bgH);
    } else {
      ctx.fillStyle = '#292524';
      ctx.fillRect(vt.originX, vt.originY, bgW, bgH);
    }

    const { snapshot, motion, redactMode, selectedBotId, botAppearances } = input;
    const layout = motion.layout;
    const elapsedSecs = motion.elapsedSecs;
    const pulseHigh = this.animTick % 2 === 0;
    const runtimeDimmed = !snapshot.runtime.connected && Object.keys(snapshot.bots).length > 0;
    const uiScale = Math.max(0.76, Math.min(1.05, vt.scale));

    const orderedBots: BotState[] =
      snapshot.botOrder.length > 0
        ? snapshot.botOrder
            .filter((id) => isSafeKey(id) && Object.hasOwn(snapshot.bots, id))
            .map((id) => snapshot.bots[id])
        : Object.values(snapshot.bots);

    type ActorRenderItem = {
      footX: number;
      footY: number;
      zBias: number;
      spritePath: string;
      scale: number;
      anchor: [number, number];
      basePx: number;
      yBobPx: number;
      facing: Facing;
      carryProp: CarryProp | null;
      grayscale: boolean;
      selected: boolean;
      needsOwner: boolean;
      isWorker: boolean;
    };

    type BotOverlay = {
      botId: string;
      name: string;
      status: BotActivityStatus;
      taskTitle: string | null;
      screenX: number;
      screenY: number;
      spriteTopY: number;
      spriteRect: Rect;
      selected: boolean;
      activeWorkerCount: number;
    };

    type WorkerOverlay = {
      provider: string;
      activity: string;
      unverifiableWarning: boolean;
      screenX: number;
      screenY: number;
      spriteRect: Rect;
    };

    type DeskMiniProp = {
      glyph: string;
      bg: string;
      border: string;
      fg: string;
      screenX: number;
      screenY: number;
    };

    const actors: ActorRenderItem[] = [];
    const botOverlays: BotOverlay[] = [];
    const workerOverlays: WorkerOverlay[] = [];
    const deskProps: DeskMiniProp[] = [];

    orderedBots.forEach((bot, idx) => {
      const desk = layout.botDesks.get(bot.id);
      if (!desk) return;

      const pose = motion.actorPose(`bot:${bot.id}`, [desk.x, desk.y]);
      const charId = resolveCharacterIdWithPrefs(botAppearances, bot.id, bot.name);
      const spec = CHARACTER_SPECS[charId];

      let yBobPx = 0;
      let xShakePx = 0;
      if (pose.isWalking) {
        yBobPx = pose.yBobPx;
      } else if (bot.status.kind === 'Working') {
        yBobPx = (this.animTick + idx) % 2 === 0 ? -1.5 : 1.5;
      } else if (bot.status.kind === 'NeedsOwner') {
        yBobPx = -Math.abs(Math.sin(elapsedSecs * 6 + idx)) * 3.5;
      } else if (bot.status.kind === 'Blocked') {
        yBobPx = -Math.abs(Math.sin(elapsedSecs * 7.5 + idx * 0.9)) * 3.8;
        xShakePx = Math.sin(elapsedSecs * 14 + idx) * 1.8;
      }

      const selected = selectedBotId === bot.id;
      const needsOwner = bot.status.kind === 'NeedsOwner';
      const grayscale = bot.status.kind === 'Paused';

      actors.push({
        footX: pose.footX + xShakePx,
        footY: pose.footY,
        zBias: 0,
        spritePath: resolveCharacterSpritePath(charId),
        scale: spec.scale,
        anchor: spec.anchor,
        basePx: BOT_SPRITE_DESIGN_PX,
        yBobPx,
        facing: pose.facing,
        carryProp: pose.carryProp,
        grayscale,
        selected,
        needsOwner,
        isWorker: false,
      });

      const [sx, sy] = designToScreen(vt, pose.footX, pose.footY);
      const sb = spriteBounds(
        vt,
        pose.footX + xShakePx,
        pose.footY,
        BOT_SPRITE_DESIGN_PX,
        spec.scale,
        spec.anchor,
        yBobPx
      );
      const cleanName = scrubAll(bot.name);
      const taskTitle = redactMode
        ? `${cleanName} · ${botStatusLabelKo(bot.status)}`
        : bot.currentTaskTitle !== null
          ? scrubAll(bot.currentTaskTitle)
          : null;

      botOverlays.push({
        botId: bot.id,
        name: cleanName,
        status: bot.status,
        taskTitle,
        screenX: sx,
        screenY: sy,
        spriteTopY: sb[1],
        spriteRect: sb,
        selected,
        activeWorkerCount: bot.activeWorkerCount,
      });

      const hasVisibleWorker =
        Array.from(layout.workerSeats.values()).some((s) => s.parentBotId === bot.id) ||
        motion.activeWorkerMotions().some((m) => m.meta.parentBotId === bot.id);

      const deskPt = designToScreen(vt, desk.x, desk.y);
      const prop = this.buildDeskMiniProp(
        bot.status,
        desk.x,
        desk.y,
        layout.bossDesk,
        elapsedSecs + idx * 0.4,
        vt,
        deskPt,
        hasVisibleWorker,
        desk.workerOffset[0],
        redactMode
      );
      if (prop) deskProps.push(prop);
    });

    const workerSpec = CHARACTER_SPECS.worker_helper;
    const renderedWorkerIds = new Set<string>();
    let redactedWorkerBadgeIdx = 1;
    for (const worker of Object.values(snapshot.workers)) {
      if (!isWorkerVisibleOnStage(worker)) continue;
      const seat = layout.workerSeats.get(worker.dispatchId);
      if (!seat) continue;
      renderedWorkerIds.add(worker.dispatchId);

      const pose = motion.actorPose(`worker:${worker.dispatchId}`, [seat.x, seat.y]);
      const yBobPx = pose.isWalking
        ? pose.yBobPx
        : worker.activity === 'working' && this.animTick % 2 === 0
          ? -1.2
          : 0;

      actors.push({
        footX: pose.footX,
        footY: pose.footY,
        zBias: 1,
        spritePath: resolveCharacterSpritePath('worker_helper'),
        scale: workerSpec.scale,
        anchor: workerSpec.anchor,
        basePx: WORKER_SPRITE_DESIGN_PX,
        yBobPx,
        facing: pose.facing,
        carryProp: pose.carryProp,
        grayscale: worker.liveness === 'Exited',
        selected: false,
        needsOwner: false,
        isWorker: true,
      });

      const [wx, wy] = designToScreen(vt, pose.footX, pose.footY);
      const wb = spriteBounds(
        vt,
        pose.footX,
        pose.footY,
        WORKER_SPRITE_DESIGN_PX,
        workerSpec.scale,
        workerSpec.anchor,
        yBobPx
      );
      const badgeProvider = redactMode
        ? `도우미 #${redactedWorkerBadgeIdx++}`
        : shortProvider(scrubAll(worker.provider));
      workerOverlays.push({
        provider: badgeProvider,
        activity: scrubAll(worker.activity),
        unverifiableWarning: isWorkerUnverifiableWarning(worker),
        screenX: wx,
        screenY: wy,
        spriteRect: wb,
      });
    }

    for (const { meta, pose } of motion.activeWorkerMotions()) {
      if (renderedWorkerIds.has(meta.dispatchId)) continue;
      actors.push({
        footX: pose.footX,
        footY: pose.footY,
        zBias: 1,
        spritePath: resolveCharacterSpritePath('worker_helper'),
        scale: workerSpec.scale,
        anchor: workerSpec.anchor,
        basePx: WORKER_SPRITE_DESIGN_PX,
        yBobPx: pose.yBobPx,
        facing: pose.facing,
        carryProp: pose.carryProp,
        grayscale: meta.kind === 'Leaving' && meta.liveness === 'Exited',
        selected: false,
        needsOwner: false,
        isWorker: true,
      });
      const [wx, wy] = designToScreen(vt, pose.footX, pose.footY);
      const wb = spriteBounds(
        vt,
        pose.footX,
        pose.footY,
        WORKER_SPRITE_DESIGN_PX,
        workerSpec.scale,
        workerSpec.anchor,
        pose.yBobPx
      );
      const badgeProvider = redactMode
        ? `도우미 #${redactedWorkerBadgeIdx++}`
        : shortProvider(scrubAll(meta.provider));
      workerOverlays.push({
        provider: badgeProvider,
        activity: scrubAll(meta.activity),
        unverifiableWarning: meta.liveness === 'Unverifiable' && meta.kind === 'Entering',
        screenX: wx,
        screenY: wy,
        spriteRect: wb,
      });
    }

    // Y-sort strictly by (footY, zBias)
    actors.sort((a, b) => a.footY - b.footY || a.zBias - b.zBias);
    botOverlays.sort((a, b) => a.screenY - b.screenY || a.botId.localeCompare(b.botId));

    // Paint actors
    for (const actor of actors) {
      const [fx, fy] = designToScreen(vt, actor.footX, actor.footY);
      const shadowW = (actor.isWorker ? 40 : 56) * vt.scale;
      const shadowH = (actor.isWorker ? 12 : 16) * vt.scale;
      const sx = fx - shadowW * 0.5;
      const sy = fy - shadowH * 0.45;

      if (actor.selected) {
        drawRoundedRect(ctx, sx - 5, sy - 4, shadowW + 10, shadowH + 8, 14);
        ctx.fillStyle = 'rgba(56, 189, 248, 0.2)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#38bdf8';
        ctx.stroke();
      } else if (actor.needsOwner) {
        drawRoundedRect(ctx, sx - 4, sy - 3, shadowW + 8, shadowH + 6, 14);
        ctx.fillStyle = 'rgba(250, 204, 21, 0.18)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = pulseHigh ? '#facc15' : '#f59e0b';
        ctx.stroke();
      }

      drawRoundedRect(ctx, sx, sy, shadowW, shadowH, 12);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.28)';
      ctx.fill();

      const sb = spriteBounds(
        vt,
        actor.footX,
        actor.footY,
        actor.basePx,
        actor.scale,
        actor.anchor,
        actor.yBobPx
      );
      const spriteImg = this.loadImage(actor.spritePath);
      ctx.save();
      if (actor.grayscale || runtimeDimmed) {
        ctx.filter = 'grayscale(90%) opacity(75%)';
      }
      if (spriteImg) {
        ctx.drawImage(spriteImg, sb[0], sb[1], sb[2], sb[3]);
      } else {
        drawRoundedRect(ctx, sb[0], sb[1], sb[2], sb[3], 10);
        ctx.fillStyle = '#334155';
        ctx.fill();
      }
      ctx.restore();

      if (actor.carryProp) {
        const dir = actor.facing === 'Left' ? -1 : 1;
        const [cx, cy] = designToScreen(vt, actor.footX + dir * 24, actor.footY - 30);
        this.paintCarryProp(ctx, actor.carryProp, cx, cy + actor.yBobPx, vt.scale);
      }
    }

    // Flying props & particles
    for (const fp of motion.flyingProps) {
      this.paintFlyingProp(ctx, vt, fp);
    }
    for (const p of motion.particles.slice(0, MAX_PARTICLES)) {
      this.paintParticle(ctx, vt, p);
    }

    // Overlays & obstacles for speech bubbles
    const obstacles: Rect[] = [];
    const bgLeft = vt.originX;
    const bgTop = vt.originY;
    const bgRight = bgLeft + bgW;
    const bgBottom = bgTop + bgH;

    // Landmarks
    const landmarks: Array<[number, number, string, string]> = [
      [theme.bossDesk.x, theme.bossDesk.y - 38, `★ ${theme.bossDesk.label}`, 'rgba(194, 134, 10, 0.94)'],
      [theme.officeDoor.x, theme.officeDoor.y - 30, `▸ ${theme.officeDoor.label}`, 'rgba(28, 118, 156, 0.92)'],
      [theme.automationBoard.x, theme.automationBoard.y - 26, `◷ ${theme.automationBoard.label}`, 'rgba(98, 48, 166, 0.92)'],
    ];
    for (const [lx, ly, label, bg] of landmarks) {
      const rect = this.paintLandmark(ctx, vt, lx, ly, label, bg, uiScale, bgLeft, bgTop, bgRight, bgBottom);
      obstacles.push(rect);
    }

    // Desk mini-props
    for (const dp of deskProps) {
      const left = Math.max(bgLeft + 4, Math.min(bgRight - 34 * uiScale, dp.screenX));
      const top = Math.max(bgTop + 4, Math.min(bgBottom - 24 * uiScale, dp.screenY));
      ctx.font = `700 ${Math.round(10 * uiScale)}px system-ui, sans-serif`;
      const estW = Math.max(24 * uiScale, ctx.measureText(dp.glyph).width + 12 * uiScale);
      const estH = 20 * uiScale;
      drawRoundedRect(ctx, left, top, estW, estH, 6 * uiScale);
      ctx.fillStyle = dp.bg;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = dp.border;
      ctx.stroke();
      ctx.fillStyle = dp.fg;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText(dp.glyph, left + estW * 0.5, top + estH * 0.5);
      obstacles.push([left, top, estW, estH]);
    }

    // Worker mini badges
    for (const w of workerOverlays) {
      obstacles.push(w.spriteRect);
      const label = w.unverifiableWarning ? `${w.provider} ?` : w.provider;
      const badgeBg = w.unverifiableWarning
        ? 'rgba(100, 116, 139, 0.94)'
        : w.activity === 'blocked'
          ? 'rgba(234, 88, 12, 0.94)'
          : 'rgba(15, 118, 110, 0.94)';
      ctx.font = `600 ${Math.round(9 * uiScale)}px system-ui, sans-serif`;
      const estW = Math.max(32 * uiScale, ctx.measureText(label).width + 12 * uiScale);
      const estH = 18 * uiScale;
      const left = Math.max(bgLeft + 4, Math.min(bgRight - estW - 4, w.screenX - 20 * vt.scale));
      const top = Math.max(bgTop + 4, Math.min(bgBottom - estH - 4, w.screenY - 46 * vt.scale));
      drawRoundedRect(ctx, left, top, estW, estH, 5 * uiScale);
      ctx.fillStyle = badgeBg;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, left + estW * 0.5, top + estH * 0.5);
      obstacles.push([left, top, estW, estH]);
    }

    // Bot overlays + hitboxes
    const nextHitBoxes: HitBox[] = [];
    for (const overlay of botOverlays) {
      obstacles.push(overlay.spriteRect);
      const boxW = Math.max(96, Math.min(148, 138 * vt.scale));
      const left = Math.max(bgLeft + 4, Math.min(bgRight - boxW - 4, overlay.screenX - boxW * 0.5));
      const spriteSpan = Math.max(26 * uiScale, overlay.screenY - overlay.spriteTopY);
      const spacerH = spriteSpan + 2 * uiScale;
      const hasCallout = overlay.status.kind === 'NeedsOwner';
      const calloutH = hasCallout ? 20 * uiScale : 0;
      const pillH = overlay.taskTitle ? 38 * uiScale : 24 * uiScale;
      const estHeight = spacerH + pillH + calloutH;
      const desiredTop = overlay.spriteTopY - (hasCallout ? 20 * uiScale : 0);
      const top = Math.max(bgTop + 4, Math.min(bgBottom - estHeight - 4, desiredTop));

      if (overlay.status.kind === 'NeedsOwner') {
        const notice =
          overlay.status.count > 1
            ? `▲ 결정 대기 (${overlay.status.count}) · 사장님`
            : '▲ 결정 대기 · 사장님';
        drawRoundedRect(ctx, left, top, boxW, calloutH - 2, 7 * uiScale);
        ctx.fillStyle = pulseHigh ? '#facc15' : '#fbbf24';
        ctx.fill();
        ctx.strokeStyle = '#78350f';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.font = `700 ${Math.round(9.5 * uiScale)}px system-ui, sans-serif`;
        ctx.fillStyle = '#451a03';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(
          truncateTextToWidth(ctx, notice, boxW - 8),
          left + boxW * 0.5,
          top + (calloutH - 2) * 0.5
        );
        obstacles.push([left, top, boxW, calloutH]);
      }

      const pillTop = top + calloutH + spacerH;
      obstacles.push([left, pillTop, boxW, pillH]);

      drawRoundedRect(ctx, left, pillTop, boxW, pillH, 8 * uiScale);
      ctx.fillStyle = overlay.selected ? 'rgba(15, 23, 42, 0.95)' : 'rgba(24, 24, 27, 0.88)';
      ctx.fill();
      ctx.lineWidth = overlay.selected ? 1.6 : 1;
      ctx.strokeStyle = overlay.selected
        ? '#38bdf8'
        : hasCallout
          ? pulseHigh
            ? '#facc15'
            : '#f59e0b'
          : 'rgba(255,255,255,0.2)';
      ctx.stroke();

      const badge = statusBadgeStyle(overlay.status, redactMode);
      const workerTag = overlay.activeWorkerCount > 0 ? `+${overlay.activeWorkerCount}` : null;
      ctx.font = `600 ${Math.round(9 * uiScale)}px system-ui, sans-serif`;
      const badgeW = Math.min(boxW * 0.45, ctx.measureText(badge.text).width + 10 * uiScale);
      const workerW = workerTag ? ctx.measureText(workerTag).width + 8 * uiScale : 0;
      const rowY = pillTop + (overlay.taskTitle ? 11 * uiScale : pillH * 0.5);

      const rightUsed = badgeW + (workerW > 0 ? workerW + 3 : 0) + 6 * uiScale;
      const nameMaxW = Math.max(24, boxW - rightUsed - 8 * uiScale);
      ctx.font = `600 ${Math.round(10.5 * uiScale)}px system-ui, sans-serif`;
      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(truncateTextToWidth(ctx, overlay.name, nameMaxW), left + 6 * uiScale, rowY);

      let cursorRight = left + boxW - 5 * uiScale;
      if (workerTag) {
        const wx = cursorRight - workerW;
        drawRoundedRect(ctx, wx, rowY - 7 * uiScale, workerW, 14 * uiScale, 4 * uiScale);
        ctx.fillStyle = '#0f766e';
        ctx.fill();
        ctx.font = `600 ${Math.round(8.5 * uiScale)}px system-ui, sans-serif`;
        ctx.fillStyle = '#ccfbf1';
        ctx.textAlign = 'center';
        ctx.fillText(workerTag, wx + workerW * 0.5, rowY);
        cursorRight = wx - 3;
      }

      const bx = cursorRight - badgeW;
      drawRoundedRect(ctx, bx, rowY - 7 * uiScale, badgeW, 14 * uiScale, 4 * uiScale);
      ctx.fillStyle = badge.bg;
      ctx.fill();
      ctx.font = `600 ${Math.round(8.5 * uiScale)}px system-ui, sans-serif`;
      ctx.fillStyle = badge.fg;
      ctx.textAlign = 'center';
      ctx.fillText(truncateTextToWidth(ctx, badge.text, badgeW - 4), bx + badgeW * 0.5, rowY);

      if (overlay.taskTitle) {
        ctx.font = `400 ${Math.round(9 * uiScale)}px system-ui, sans-serif`;
        ctx.fillStyle = '#cbd5e1';
        ctx.textAlign = 'center';
        ctx.fillText(
          truncateTextToWidth(ctx, overlay.taskTitle, boxW - 10 * uiScale),
          left + boxW * 0.5,
          pillTop + 27 * uiScale
        );
      }

      // Click hitbox covers both sprite and nameplate
      const hbLeft = Math.min(overlay.spriteRect[0], left);
      const hbTop = Math.min(overlay.spriteRect[1], top);
      const hbRight = Math.max(overlay.spriteRect[0] + overlay.spriteRect[2], left + boxW);
      const hbBottom = Math.max(overlay.spriteRect[1] + overlay.spriteRect[3], pillTop + pillH);
      nextHitBoxes.push({
        botId: overlay.botId,
        rect: [hbLeft, hbTop, hbRight - hbLeft, hbBottom - hbTop],
      });
    }
    this.hitBoxes = nextHitBoxes;

    // Speech bubbles (max 5, obstacle-avoiding)
    for (const bubble of motion.bubbles.slice(0, MAX_BUBBLES)) {
      const [ax, ay] = motion.bubbleAnchorPos(bubble);
      const [sx, sy] = designToScreen(vt, ax, ay);
      const text = redactMode ? bubble.redactedText : bubble.normalText;
      const estW = estimateBubbleWidth(text);
      const estH = 26;
      const [bLeft, bTop] = placeSpeechBubble(
        sx,
        sy,
        vt.scale,
        estW,
        estH,
        [bgLeft, bgTop, bgRight, bgBottom],
        obstacles
      );
      obstacles.push([bLeft, bTop, estW, estH]);
      const col = bubbleColors(bubble.kind);
      drawRoundedRect(ctx, bLeft, bTop, estW, estH, 9);
      ctx.fillStyle = col.bg;
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = col.border;
      ctx.stroke();
      ctx.font = '600 10.5px system-ui, sans-serif';
      ctx.fillStyle = col.fg;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(truncateTextToWidth(ctx, text, estW - 14), bLeft + estW * 0.5, bTop + estH * 0.5);
    }

    ctx.restore();
  }

  private buildDeskMiniProp(
    status: BotActivityStatus,
    dx: number,
    dy: number,
    bossDesk: [number, number],
    phase: number,
    vt: ViewportTransform,
    deskScreen: [number, number],
    hasVisibleWorker: boolean,
    workerOffsetX: number,
    redactMode: boolean
  ): { glyph: string; bg: string; border: string; fg: string; screenX: number; screenY: number } | null {
    const placeLeft = hasVisibleWorker && workerOffsetX > 0;
    const xShift = (placeLeft ? -28 : 22) * vt.scale;
    switch (status.kind) {
      case 'Working':
        if (redactMode) return null;
        return {
          glyph: classifyToolGlyph(status.tool),
          bg: 'rgba(13, 46, 109, 0.92)',
          border: 'rgba(84, 165, 255, 0.9)',
          fg: '#e0f2fe',
          screenX: deskScreen[0] + xShift,
          screenY: deskScreen[1] - 36 * vt.scale,
        };
      case 'Idle':
        return {
          glyph: '☕',
          bg: 'rgba(81, 56, 31, 0.88)',
          border: 'rgba(209, 152, 71, 0.85)',
          fg: '#fef3c7',
          screenX: deskScreen[0] + xShift,
          screenY: deskScreen[1] - 32 * vt.scale,
        };
      case 'WaitingAnswer':
        return {
          glyph: '⏳',
          bg: 'rgba(128, 86, 14, 0.92)',
          border: 'rgba(250, 204, 21, 0.95)',
          fg: '#fef9c3',
          screenX: deskScreen[0] + xShift,
          screenY: deskScreen[1] - 36 * vt.scale,
        };
      case 'Paused':
        return {
          glyph: 'Zzz',
          bg: 'rgba(50, 62, 82, 0.9)',
          border: 'rgba(100, 128, 173, 0.8)',
          fg: '#dbeafe',
          screenX: deskScreen[0] + (placeLeft ? -28 : 18) * vt.scale,
          screenY: deskScreen[1] - 46 * vt.scale,
        };
      case 'NeedsOwner': {
        const vx = bossDesk[0] - dx;
        const vy = bossDesk[1] - dy;
        const len = Math.max(1, Math.hypot(vx, vy));
        const dirX = (vx / len) * 26;
        const dirY = (vy / len) * 16 - 44 + Math.sin(phase * 7) * 4;
        const [wx, wy] = designToScreen(vt, dx + dirX, dy + dirY);
        return {
          glyph: '👋',
          bg: 'rgba(249, 198, 6, 0.96)',
          border: 'rgba(145, 81, 8, 0.95)',
          fg: '#451a03',
          screenX: wx - 10,
          screenY: wy - 10,
        };
      }
      case 'Blocked':
        return {
          glyph: '🔒',
          bg: 'rgba(174, 73, 9, 0.94)',
          border: 'rgba(251, 146, 60, 0.95)',
          fg: '#ffffff',
          screenX: deskScreen[0] + xShift,
          screenY: deskScreen[1] - 40 * vt.scale,
        };
      case 'Error':
        return {
          glyph: '✕',
          bg: 'rgba(175, 19, 19, 0.94)',
          border: 'rgba(248, 113, 113, 0.95)',
          fg: '#ffffff',
          screenX: deskScreen[0] + xShift,
          screenY: deskScreen[1] - 40 * vt.scale,
        };
    }
  }

  private paintLandmark(
    ctx: CanvasRenderingContext2D,
    vt: ViewportTransform,
    dx: number,
    dy: number,
    label: string,
    bg: string,
    uiScale: number,
    bgLeft: number,
    bgTop: number,
    bgRight: number,
    bgBottom: number
  ): Rect {
    const [ptX, ptY] = designToScreen(vt, dx, dy);
    ctx.font = `700 ${Math.round(10.5 * uiScale)}px system-ui, sans-serif`;
    const estW = Math.max(64 * uiScale, ctx.measureText(label).width + 18 * uiScale);
    const estH = 24 * uiScale;
    const left = Math.max(bgLeft + 4, Math.min(bgRight - estW - 4, ptX - 52 * vt.scale));
    const top = Math.max(bgTop + 4, Math.min(bgBottom - estH - 4, ptY));

    drawRoundedRect(ctx, left, top, estW, estH, 7 * uiScale);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, left + estW * 0.5, top + estH * 0.5);
    return [left, top, estW, estH];
  }

  private paintCarryProp(
    ctx: CanvasRenderingContext2D,
    prop: CarryProp,
    cx: number,
    cy: number,
    scale: number
  ): void {
    const s = Math.max(0.5, scale);
    ctx.save();
    if (prop === 'YellowEnvelope') {
      const w = 18 * s;
      const h = 13 * s;
      drawRoundedRect(ctx, cx - w * 0.5, cy - h * 0.5, w, h, 2);
      ctx.fillStyle = '#facc15';
      ctx.fill();
      ctx.strokeStyle = '#a16207';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - w * 0.45, cy - h * 0.35);
      ctx.lineTo(cx, cy + h * 0.1);
      ctx.lineTo(cx + w * 0.45, cy - h * 0.35);
      ctx.strokeStyle = '#854d0e';
      ctx.stroke();
    } else if (prop === 'ReportBox') {
      const w = 16 * s;
      const h = 15 * s;
      drawRoundedRect(ctx, cx - w * 0.5, cy - h * 0.5, w, h, 2.5);
      ctx.fillStyle = '#d97706';
      ctx.fill();
      ctx.strokeStyle = '#78350f';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#fef3c7';
      ctx.fillRect(cx - w * 0.42, cy - 1.5 * s, w * 0.84, 3 * s);
    } else if (prop === 'GreenRibbonBox') {
      const w = 17 * s;
      const h = 16 * s;
      drawRoundedRect(ctx, cx - w * 0.5, cy - h * 0.5, w, h, 3);
      ctx.fillStyle = '#86efac';
      ctx.fill();
      ctx.strokeStyle = '#15803d';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#16a34a';
      ctx.fillRect(cx - 1.5 * s, cy - h * 0.5, 3 * s, h);
      ctx.fillRect(cx - w * 0.5, cy - 1.5 * s, w, 3 * s);
    } else if (prop === 'RedXDoc') {
      const w = 14 * s;
      const h = 17 * s;
      drawRoundedRect(ctx, cx - w * 0.5, cy - h * 0.5, w, h, 2);
      ctx.fillStyle = '#fef2f2';
      ctx.fill();
      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - 3.5 * s, cy - 3.5 * s);
      ctx.lineTo(cx + 3.5 * s, cy + 3.5 * s);
      ctx.moveTo(cx + 3.5 * s, cy - 3.5 * s);
      ctx.lineTo(cx - 3.5 * s, cy + 3.5 * s);
      ctx.lineWidth = 2;
      ctx.stroke();
    } else if (prop === 'QuestionMark') {
      const r = 15 * s;
      drawRoundedRect(ctx, cx - r * 0.5, cy - r * 0.5, r, r, r * 0.5);
      ctx.fillStyle = '#dbeafe';
      ctx.fill();
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      const w = 14 * s;
      const h = 16 * s;
      drawRoundedRect(ctx, cx - w * 0.5, cy - h * 0.5, w, h, 2);
      ctx.fillStyle = '#e2e8f0';
      ctx.fill();
      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }

  private paintFlyingProp(
    ctx: CanvasRenderingContext2D,
    vt: ViewportTransform,
    fp: FlyingProp
  ): void {
    const t = fp.duration <= 1e-6 ? 1 : Math.max(0, Math.min(1, fp.elapsed / fp.duration));
    const gx = fp.start[0] + (fp.end[0] - fp.start[0]) * t;
    const gy = fp.start[1] + (fp.end[1] - fp.start[1]) * t;
    const lift = fp.arcHeight * 4 * t * (1 - t);
    const [groundX, groundY] = designToScreen(vt, gx, gy);
    const [x, y] = designToScreen(vt, gx, gy - lift);
    const s = Math.max(0.5, vt.scale);

    ctx.save();
    drawRoundedRect(ctx, groundX - 9 * s, groundY - 3 * s, 18 * s, 6 * s, 6);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.34)';
    ctx.fill();

    if (fp.kind.kind === 'PaperAirplane') {
      const dx = fp.end[0] - fp.start[0];
      const dy = fp.end[1] - fp.start[1] - fp.arcHeight * 4 * (1 - 2 * t);
      const len = Math.max(0.001, Math.hypot(dx, dy));
      const fwdX = dx / len;
      const fwdY = dy / len;
      const perpX = -fwdY;
      const perpY = fwdX;
      ctx.beginPath();
      ctx.moveTo(x + fwdX * 13 * s, y + fwdY * 13 * s);
      ctx.lineTo(x - fwdX * 9 * s + perpX * 7.5 * s, y - fwdY * 9 * s + perpY * 7.5 * s);
      ctx.lineTo(x - fwdX * 4 * s, y - fwdY * 4 * s);
      ctx.lineTo(x - fwdX * 9 * s - perpX * 7.5 * s, y - fwdY * 9 * s - perpY * 7.5 * s);
      ctx.closePath();
      ctx.fillStyle = fp.kind.isFloodReplacement ? '#bae6fd' : '#f8fafc';
      ctx.fill();
      ctx.strokeStyle = '#0284c7';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    } else if (fp.kind.kind === 'BossStamp') {
      const w = 22 * s;
      const h = 16 * s;
      drawRoundedRect(ctx, x - w * 0.5, y - h * 0.5, w, h, 4);
      ctx.fillStyle = '#fef08a';
      ctx.fill();
      ctx.strokeStyle = '#ca8a04';
      ctx.lineWidth = 2;
      ctx.stroke();
      const seal = 8 * s;
      drawRoundedRect(ctx, x - seal * 0.5, y - seal * 0.5, seal, seal, seal * 0.5);
      ctx.fillStyle = '#dc2626';
      ctx.fill();
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      const w = 16 * s;
      const h = 19 * s;
      const border = fp.kind.success ? '#16a34a' : '#dc2626';
      drawRoundedRect(ctx, x - w * 0.5, y - h * 0.5, w, h, 2.5);
      ctx.fillStyle = '#f8fafc';
      ctx.fill();
      ctx.strokeStyle = border;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.beginPath();
      if (fp.kind.success) {
        ctx.moveTo(x - 4 * s, y);
        ctx.lineTo(x - 1 * s, y + 3.5 * s);
        ctx.lineTo(x + 4.5 * s, y - 4 * s);
      } else {
        ctx.moveTo(x - 3.5 * s, y - 3.5 * s);
        ctx.lineTo(x + 3.5 * s, y + 3.5 * s);
        ctx.moveTo(x + 3.5 * s, y - 3.5 * s);
        ctx.lineTo(x - 3.5 * s, y + 3.5 * s);
      }
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  }

  private paintParticle(
    ctx: CanvasRenderingContext2D,
    vt: ViewportTransform,
    p: Particle
  ): void {
    const alpha = Math.max(0, Math.min(1, 1 - p.age / Math.max(0.01, p.ttl)));
    if (alpha <= 0.02) return;
    const [x, y] = designToScreen(vt, p.x, p.y);
    const sz = p.size * Math.max(0.6, vt.scale);

    ctx.save();
    ctx.globalAlpha = alpha;
    if (p.kind === 'GreenCheckConfetti' || p.kind === 'GrayArchive') {
      ctx.fillStyle = p.colorHex;
      ctx.fillRect(x - sz * 0.5, y - sz * 0.5, sz, sz * 0.8);
    } else if (p.kind === 'Sparkle') {
      ctx.beginPath();
      ctx.moveTo(x, y - sz);
      ctx.lineTo(x + sz * 0.55, y);
      ctx.lineTo(x, y + sz);
      ctx.lineTo(x - sz * 0.55, y);
      ctx.closePath();
      ctx.fillStyle = p.colorHex;
      ctx.fill();
    } else if (p.kind === 'SweatDrop') {
      drawRoundedRect(ctx, x - sz * 0.4, y - sz * 0.6, sz * 0.8, sz * 1.2, sz * 0.5);
      ctx.fillStyle = p.colorHex;
      ctx.fill();
    } else {
      drawRoundedRect(ctx, x - sz * 0.55, y - sz * 0.35, sz * 1.1, sz * 0.9, 2);
      ctx.fillStyle = p.colorHex;
      ctx.fill();
      ctx.beginPath();
      const shift = p.kind === 'LockOpen' ? -sz * 0.25 : 0;
      ctx.moveTo(x - sz * 0.3, y - sz * 0.35);
      ctx.lineTo(x - sz * 0.3, y - sz * 0.8 + shift);
      ctx.lineTo(x + sz * 0.3, y - sz * 0.8 + shift);
      if (p.kind === 'LockOrange') {
        ctx.lineTo(x + sz * 0.3, y - sz * 0.35);
      }
      ctx.strokeStyle = p.colorHex;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }

  dispose(): void {
    this.destroyed = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.resizeObserver?.disconnect();
    this.canvas.removeEventListener('click', this.handleClick);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerleave', this.handlePointerLeave);
  }
}
