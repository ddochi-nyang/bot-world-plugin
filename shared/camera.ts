import { isSafeKey, type WorldSnapshot } from '../src/types.ts';

export const MIN_CAMERA_ZOOM = 1.0;
export const MAX_CAMERA_ZOOM = 2.6;
export const FOCUS_SPOTLIGHT_ZOOM = 1.65;
export const FOLLOW_CAM_MIN_ZOOM = 1.5;
export const CAMERA_ZOOM_STEP = 0.25;
export const DEFAULT_SPOTLIGHT_SECS = 3.8;

export type StageViewport = {
  cssW: number;
  cssH: number;
  designW: number;
  designH: number;
  baseScale: number;
  baseOriginX: number;
  baseOriginY: number;
};

export type CameraPose = {
  zoom: number;
  panX: number;
  panY: number;
};

export type ViewportTransform = {
  originX: number;
  originY: number;
  scale: number;
  designW: number;
  designH: number;
};

export function clampZoom(zoom: number): number {
  if (typeof zoom !== 'number' || !Number.isFinite(zoom)) {
    return MIN_CAMERA_ZOOM;
  }
  return Math.max(MIN_CAMERA_ZOOM, Math.min(MAX_CAMERA_ZOOM, zoom));
}

export function maxPanForZoom(
  zoom: number,
  designSize: readonly [number, number]
): [number, number] {
  const z = clampZoom(zoom);
  const factor = Math.max(0, 1 - 1 / z);
  const dw = Math.max(1, Number.isFinite(designSize[0]) ? designSize[0] : 1376);
  const dh = Math.max(1, Number.isFinite(designSize[1]) ? designSize[1] : 768);
  return [dw * 0.5 * factor, dh * 0.5 * factor];
}

export function clampPan(
  panX: number,
  panY: number,
  zoom: number,
  designSize: readonly [number, number]
): [number, number] {
  const [maxX, maxY] = maxPanForZoom(zoom, designSize);
  const safeX = typeof panX === 'number' && Number.isFinite(panX) ? panX : 0;
  const safeY = typeof panY === 'number' && Number.isFinite(panY) ? panY : 0;
  const cx = Math.max(-maxX, Math.min(maxX, safeX));
  const cy = Math.max(-maxY, Math.min(maxY, safeY));
  return [cx === 0 ? 0 : cx, cy === 0 ? 0 : cy];
}

export function createStageViewport(
  availW: number,
  availH: number,
  designSize: readonly [number, number]
): StageViewport {
  const designW = Math.max(1, Number.isFinite(designSize[0]) ? designSize[0] : 1376);
  const designH = Math.max(1, Number.isFinite(designSize[1]) ? designSize[1] : 768);
  const cssW = Math.max(1, Number.isFinite(availW) ? availW : 1);
  const cssH = Math.max(1, Number.isFinite(availH) ? availH : 1);
  const baseScale = Math.min(cssW / designW, cssH / designH);
  return {
    cssW,
    cssH,
    designW,
    designH,
    baseScale,
    baseOriginX: (cssW - designW * baseScale) * 0.5,
    baseOriginY: (cssH - designH * baseScale) * 0.5,
  };
}

export function composeViewportTransform(
  vp: StageViewport,
  cam: CameraPose
): ViewportTransform {
  const z = clampZoom(cam.zoom);
  const [px, py] = clampPan(cam.panX, cam.panY, z, [vp.designW, vp.designH]);
  const scale = vp.baseScale * z;
  return {
    originX: vp.cssW * 0.5 - (vp.designW * 0.5 + px) * scale,
    originY: vp.cssH * 0.5 - (vp.designH * 0.5 + py) * scale,
    scale,
    designW: vp.designW,
    designH: vp.designH,
  };
}

export function screenToWorld(
  screenX: number,
  screenY: number,
  vp: StageViewport,
  cam: CameraPose
): [number, number] {
  const z = clampZoom(cam.zoom);
  const [px, py] = clampPan(cam.panX, cam.panY, z, [vp.designW, vp.designH]);
  const effScale = Math.max(1e-6, vp.baseScale * z);
  return [
    vp.designW * 0.5 + px + (screenX - vp.cssW * 0.5) / effScale,
    vp.designH * 0.5 + py + (screenY - vp.cssH * 0.5) / effScale,
  ];
}

export function worldToScreen(
  worldX: number,
  worldY: number,
  vp: StageViewport,
  cam: CameraPose
): [number, number] {
  const z = clampZoom(cam.zoom);
  const [px, py] = clampPan(cam.panX, cam.panY, z, [vp.designW, vp.designH]);
  const effScale = vp.baseScale * z;
  return [
    vp.cssW * 0.5 + (worldX - (vp.designW * 0.5 + px)) * effScale,
    vp.cssH * 0.5 + (worldY - (vp.designH * 0.5 + py)) * effScale,
  ];
}

export function pickNextFocusBotId(
  snapshot: WorldSnapshot,
  currentFocusedId: string | null,
  allowedBotIds?: ReadonlySet<string>
): string | null {
  const orderedIds =
    snapshot.botOrder.length > 0
      ? snapshot.botOrder.filter((id) => isSafeKey(id) && Object.hasOwn(snapshot.bots, id))
      : Object.keys(snapshot.bots).filter((id) => isSafeKey(id));

  if (orderedIds.length === 0) return null;

  const pool =
    allowedBotIds && allowedBotIds.size > 0
      ? orderedIds.filter((id) => allowedBotIds.has(id))
      : orderedIds;
  const candidates = pool.length > 0 ? pool : orderedIds;

  const urgent = candidates.filter((id) => {
    const kind = snapshot.bots[id].status.kind;
    return kind === 'NeedsOwner' || kind === 'Blocked' || kind === 'Error';
  });
  const working = candidates.filter((id) => {
    const kind = snapshot.bots[id].status.kind;
    return kind === 'Working' || kind === 'WaitingAnswer';
  });

  const tier = urgent.length > 0 ? urgent : working.length > 0 ? working : candidates;
  if (tier.length === 0) return null;

  const curIdx = currentFocusedId ? tier.indexOf(currentFocusedId) : -1;
  return tier[(curIdx + 1) % tier.length];
}

export class CameraController {
  zoom = MIN_CAMERA_ZOOM;
  panX = 0;
  panY = 0;
  targetZoom = MIN_CAMERA_ZOOM;
  targetPanX = 0;
  targetPanY = 0;
  followBotId: string | null = null;
  spotlightBotId: string | null = null;
  spotlightRemainingSecs = 0;
  spotlightElapsedSecs = 0;

  isZoomed(): boolean {
    return this.zoom > MIN_CAMERA_ZOOM + 0.005 || this.targetZoom > MIN_CAMERA_ZOOM + 0.005;
  }

  isAnimating(): boolean {
    return (
      Math.abs(this.zoom - this.targetZoom) > 1e-4 ||
      Math.abs(this.panX - this.targetPanX) > 1e-3 ||
      Math.abs(this.panY - this.targetPanY) > 1e-3 ||
      (this.spotlightBotId !== null && this.spotlightRemainingSecs > 0)
    );
  }

  zoomPercent(): number {
    return Math.round(this.targetZoom * 100);
  }

  setZoom(
    nextZoom: number,
    designSize: readonly [number, number],
    immediate = false
  ): void {
    const z = clampZoom(nextZoom);
    const [px, py] = clampPan(this.targetPanX, this.targetPanY, z, designSize);
    this.targetZoom = z;
    this.targetPanX = px;
    this.targetPanY = py;
    if (immediate) {
      this.zoom = z;
      this.panX = px;
      this.panY = py;
    }
  }

  zoomAtScreenPoint(
    nextZoom: number,
    screenX: number,
    screenY: number,
    vp: StageViewport,
    immediate = false
  ): void {
    const [wx, wy] = screenToWorld(screenX, screenY, vp, {
      zoom: this.zoom,
      panX: this.panX,
      panY: this.panY,
    });
    const z = clampZoom(nextZoom);
    const effScale = Math.max(1e-6, vp.baseScale * z);
    const rawPanX = wx - vp.designW * 0.5 - (screenX - vp.cssW * 0.5) / effScale;
    const rawPanY = wy - vp.designH * 0.5 - (screenY - vp.cssH * 0.5) / effScale;
    const [px, py] = clampPan(rawPanX, rawPanY, z, [vp.designW, vp.designH]);

    if (this.followBotId !== null && (Math.abs(px - this.targetPanX) > 1 || Math.abs(py - this.targetPanY) > 1)) {
      this.followBotId = null;
    }

    this.targetZoom = z;
    this.targetPanX = px;
    this.targetPanY = py;
    if (immediate) {
      this.zoom = z;
      this.panX = px;
      this.panY = py;
    }
  }

  panByScreenDelta(
    deltaScreenX: number,
    deltaScreenY: number,
    vp: StageViewport,
    immediate = true
  ): void {
    // Manual pan releases follow cam immediately
    this.followBotId = null;
    const effScale = Math.max(1e-6, vp.baseScale * this.zoom);
    const nextPanX = this.panX - deltaScreenX / effScale;
    const nextPanY = this.panY - deltaScreenY / effScale;
    const [px, py] = clampPan(nextPanX, nextPanY, this.targetZoom, [vp.designW, vp.designH]);
    this.targetPanX = px;
    this.targetPanY = py;
    if (immediate) {
      this.panX = px;
      this.panY = py;
    }
  }

  focusWorldPoint(
    worldX: number,
    worldY: number,
    zoom: number,
    designSize: readonly [number, number],
    opts?: { botId?: string; spotlightSecs?: number; immediate?: boolean }
  ): void {
    const z = clampZoom(zoom);
    const rawPanX = worldX - designSize[0] * 0.5;
    const rawPanY = worldY - designSize[1] * 0.5;
    const [px, py] = clampPan(rawPanX, rawPanY, z, designSize);
    this.targetZoom = z;
    this.targetPanX = px;
    this.targetPanY = py;
    if (opts?.botId) {
      this.spotlightBotId = opts.botId;
      this.spotlightRemainingSecs = opts.spotlightSecs ?? DEFAULT_SPOTLIGHT_SECS;
      this.spotlightElapsedSecs = 0;
    }
    if (opts?.immediate) {
      this.zoom = z;
      this.panX = px;
      this.panY = py;
    }
  }

  setFollowBot(botId: string | null): void {
    this.followBotId = botId;
    if (botId !== null) {
      this.targetZoom = clampZoom(Math.max(this.targetZoom, FOLLOW_CAM_MIN_ZOOM));
    }
  }

  releaseFollow(): void {
    this.followBotId = null;
  }

  updateFollowTarget(
    worldX: number,
    worldY: number,
    designSize: readonly [number, number],
    immediate = false
  ): void {
    if (!this.followBotId) return;
    const z = clampZoom(Math.max(this.targetZoom, FOLLOW_CAM_MIN_ZOOM));
    const [px, py] = clampPan(worldX - designSize[0] * 0.5, worldY - designSize[1] * 0.5, z, designSize);
    this.targetZoom = z;
    this.targetPanX = px;
    this.targetPanY = py;
    if (immediate) {
      this.zoom = z;
      this.panX = px;
      this.panY = py;
    }
  }

  reset(immediate = false): void {
    this.targetZoom = MIN_CAMERA_ZOOM;
    this.targetPanX = 0;
    this.targetPanY = 0;
    this.followBotId = null;
    this.spotlightBotId = null;
    this.spotlightRemainingSecs = 0;
    this.spotlightElapsedSecs = 0;
    if (immediate) {
      this.zoom = MIN_CAMERA_ZOOM;
      this.panX = 0;
      this.panY = 0;
    }
  }

  step(dtSecs: number, designSize: readonly [number, number]): boolean {
    const dt = Math.max(0, Math.min(0.25, Number.isFinite(dtSecs) ? dtSecs : 0));
    if (dt <= 0) return this.isAnimating();

    const alpha = 1 - Math.exp(-12 * dt);
    const nextZ = this.zoom + (this.targetZoom - this.zoom) * alpha;
    this.zoom = Math.abs(this.targetZoom - nextZ) < 0.0015 ? this.targetZoom : clampZoom(nextZ);

    const nextPx = this.panX + (this.targetPanX - this.panX) * alpha;
    const nextPy = this.panY + (this.targetPanY - this.panY) * alpha;
    const snapX = Math.abs(this.targetPanX - nextPx) < 0.2 ? this.targetPanX : nextPx;
    const snapY = Math.abs(this.targetPanY - nextPy) < 0.2 ? this.targetPanY : nextPy;
    const [clampedX, clampedY] = clampPan(snapX, snapY, this.zoom, designSize);
    this.panX = clampedX;
    this.panY = clampedY;

    if (this.spotlightBotId !== null && this.spotlightRemainingSecs > 0) {
      this.spotlightElapsedSecs += dt;
      this.spotlightRemainingSecs = Math.max(0, this.spotlightRemainingSecs - dt);
      if (this.spotlightRemainingSecs <= 0) {
        this.spotlightBotId = null;
      }
    }

    return this.isAnimating();
  }
}
