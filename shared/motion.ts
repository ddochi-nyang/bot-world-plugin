import { formatEventSummaries } from '../src/events.ts';
import {
  type ActorRef,
  type BotState,
  type DeskCoordinate,
  type Keyframe,
  type UiLocale,
  type WorldEvent,
  type WorldEventRecord,
  type WorldSnapshot,
  clampDeskCoordinate,
  createEmptySnapshot,
  isSafeKey,
  isWorkerVisibleOnStage,
} from '../src/types.ts';
import { type ThemeConfig, deskPosition } from './assets-catalog.ts';

export const MAX_CONCURRENT_WALKERS = 8;
export const MAX_BUBBLES = 5;
export const MAX_PARTICLES = 64;
export const MAX_COURIERS = 6;
export const FLOOD_QUEUE_THRESHOLD = 3;
export const FLOOD_SPEED_MULTIPLIER = 4.0;
export const MILESTONE_THRESHOLDS = [5, 10, 25, 50] as const;

export function hasErrorDeskBeacon(bot: BotState): boolean {
  return bot.status.kind === 'Error';
}

export function isCompletionEvent(event: WorldEvent): boolean {
  if (!event || typeof event !== 'object') return false;
  if (event.kind === 'ItemDone' || event.kind === 'WorkerDone') return true;
  if (event.kind === 'AutomationRun') return event.success === true;
  return false;
}

export function localDayKey(epochMs: number): string {
  const ts = Number.isFinite(epochMs) && epochMs > 0 ? epochMs : Date.now();
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function countDailyCompletions(
  events: readonly WorldEventRecord[],
  nowMs: number
): number {
  const dayKey = localDayKey(nowMs);
  let count = 0;
  for (const rec of events) {
    if (!rec || typeof rec.timestampMs !== 'number' || !Number.isFinite(rec.timestampMs)) continue;
    if (localDayKey(rec.timestampMs) !== dayKey) continue;
    if (isCompletionEvent(rec.event)) {
      count += 1;
    }
  }
  return count;
}

export function detectCrossedMilestone(
  prevCount: number,
  nextCount: number,
  celebratedThresholds: ReadonlySet<number>
): number | null {
  let crossed: number | null = null;
  for (const threshold of MILESTONE_THRESHOLDS) {
    if (prevCount < threshold && nextCount >= threshold && !celebratedThresholds.has(threshold)) {
      crossed = threshold;
    }
  }
  return crossed;
}

export class MilestoneTracker {
  private dayKey = '';
  private completionCount = 0;
  private celebrated = new Set<number>();
  private seeded = false;

  reset(): void {
    this.dayKey = '';
    this.completionCount = 0;
    this.celebrated.clear();
    this.seeded = false;
  }

  isSeeded(): boolean {
    return this.seeded;
  }

  getCompletionCount(): number {
    return this.completionCount;
  }

  seedBaseline(events: readonly WorldEventRecord[], nowMs: number): void {
    const key = localDayKey(nowMs);
    this.dayKey = key;
    this.completionCount = countDailyCompletions(events, nowMs);
    this.celebrated.clear();
    for (const threshold of MILESTONE_THRESHOLDS) {
      if (this.completionCount >= threshold) {
        this.celebrated.add(threshold);
      }
    }
    this.seeded = true;
  }

  evaluateNewEvents(events: readonly WorldEvent[], nowMs: number): number | null {
    const key = localDayKey(nowMs);
    if (!this.seeded || this.dayKey !== key) {
      this.dayKey = key;
      this.completionCount = 0;
      this.celebrated.clear();
      this.seeded = true;
    }
    let added = 0;
    for (const ev of events) {
      if (isCompletionEvent(ev)) added += 1;
    }
    if (added === 0) return null;
    const prev = this.completionCount;
    const next = prev + added;
    this.completionCount = next;
    const crossed = detectCrossedMilestone(prev, next, this.celebrated);
    if (crossed !== null) {
      for (const threshold of MILESTONE_THRESHOLDS) {
        if (next >= threshold) this.celebrated.add(threshold);
      }
    }
    return crossed;
  }
}

export type HuddleSparkle = {
  id: number;
  botAId: string;
  botBId: string;
  from: [number, number];
  to: [number, number];
  elapsed: number;
  duration: number;
};

export type MilestoneBanner = {
  count: number;
  ttl: number;
  maxTtl: number;
};

export type CourierKind = 'paper_plane' | 'envelope';

export type FlyingCourier = {
  id: number;
  kind: CourierKind;
  from: [number, number];
  to: [number, number];
  control: [number, number];
  elapsed: number;
  duration: number;
};

export type Facing = 'Left' | 'Right';

export type CarryProp =
  | 'YellowEnvelope'
  | 'ReportBox'
  | 'GreenRibbonBox'
  | 'RedXDoc'
  | 'QuestionMark'
  | 'GrayCancelDoc';

export type FlyingPropKind =
  | { kind: 'PaperAirplane'; isFloodReplacement: boolean }
  | { kind: 'BossStamp' }
  | { kind: 'AutomationNote'; noReply: boolean; success: boolean };

export type FlyingProp = {
  id: number;
  kind: FlyingPropKind;
  start: [number, number];
  end: [number, number];
  arcHeight: number;
  elapsed: number;
  duration: number;
};

export type BubbleKind = 'Normal' | 'Question' | 'Alert' | 'Success' | 'Boss';

export type SpeechBubble = {
  id: number;
  anchorActorKey: string | null;
  fallbackPos: [number, number];
  normalText: string;
  redactedText: string;
  kind: BubbleKind;
  ttl: number;
  maxTtl: number;
  event?: WorldEvent;
  seqHint?: number;
};

export type ParticleKind =
  | 'GreenCheckConfetti'
  | 'MilestoneConfetti'
  | 'Sparkle'
  | 'SweatDrop'
  | 'LockOrange'
  | 'LockOpen'
  | 'GrayArchive';

export type Particle = {
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  gravity: number;
  age: number;
  ttl: number;
  colorHex: string;
  size: number;
};

export type WorkerMotion = {
  dispatchId: string;
  parentBotId: string | null;
  provider: string;
  activity: string;
  liveness: 'Live' | 'Exited' | 'Unverifiable';
  kind: 'Entering' | 'DeliveringToParent' | 'Leaving';
};

type BurstKind = 'None' | 'GreenCheckConfetti' | 'RedAlert' | 'Sparkle';

type WalkSegment = {
  from: [number, number];
  to: [number, number];
  duration: number;
  carry: CarryProp | null;
  onDoneBurst: BurstKind;
};

type FlyingFallbackSpec = {
  kind: FlyingPropKind;
  start: [number, number];
  end: [number, number];
  arcHeight: number;
  duration: number;
};

type QueuedMotion = {
  segments: WalkSegment[];
  workerMotion: WorkerMotion | null;
  flyingFallback: FlyingFallbackSpec | null;
};

type ActiveWalk = {
  actorKey: string;
  segments: WalkSegment[];
  segIdx: number;
  segElapsed: number;
  speedMultiplier: number;
  workerMotion: WorkerMotion | null;
  trailAccum: number;
};

export type ActorPose = {
  footX: number;
  footY: number;
  yBobPx: number;
  facing: Facing;
  carryProp: CarryProp | null;
  isWalking: boolean;
};

export type Rect = [number, number, number, number];

function easeInOut(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

function rectOverlapArea(a: Rect, b: Rect): number {
  const ox = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const oy = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return ox > 0 && oy > 0 ? ox * oy : 0;
}

function padRect(r: Rect, pad: number): Rect {
  return [r[0] - pad, r[1] - pad, r[2] + pad * 2, r[3] + pad * 2];
}

function actorFootprintRects(pos: [number, number], isWorker: boolean): [Rect, Rect] {
  const [x, y] = pos;
  if (isWorker) {
    return [
      [x - 30, y - 48, 60, 54],
      [x - 26, y - 48, 54, 24],
    ];
  }
  return [
    [x - 45, y - 81, 90, 90],
    [x - 69, y + 2, 138, 42],
  ];
}

function pushUniquePos(list: Array<[number, number]>, pos: [number, number]): void {
  if (!list.some(([x, y]) => Math.abs(x - pos[0]) < 1 && Math.abs(y - pos[1]) < 1)) {
    list.push(pos);
  }
}

function motionVisitStopDestination(segments: WalkSegment[]): [number, number] | null {
  if (segments.length === 0) return null;
  if (segments.length >= 2 && segments.length % 2 === 0) {
    const first = segments[0];
    const last = segments[segments.length - 1];
    if (
      Math.abs(first.from[0] - last.to[0]) < 1 &&
      Math.abs(first.from[1] - last.to[1]) < 1
    ) {
      return segments[segments.length / 2 - 1].to;
    }
  }
  return segments[segments.length - 1].to;
}

export function visitStopPointAvoiding(
  start: [number, number],
  target: [number, number],
  designSize: [number, number],
  visitorIsWorker: boolean,
  occupiedBots: Array<[number, number]>,
  occupiedWorkers: Array<[number, number]>,
  landmarks: Array<[number, number]>
): [number, number] {
  const [minX, minY, bottomPad] = visitorIsWorker ? [40, 64, 28] : [76, 92, 54];
  const maxX = Math.max(minX, designSize[0] - minX);
  const maxY = Math.max(minY, designSize[1] - bottomPad);

  const botObstacles: Rect[] = [];
  for (const b of occupiedBots) {
    botObstacles.push(...actorFootprintRects(b, false));
  }
  if (!occupiedBots.some(([bx, by]) => Math.abs(bx - target[0]) < 1 && Math.abs(by - target[1]) < 1)) {
    botObstacles.push(...actorFootprintRects(target, false));
  }
  for (const [lx, ly] of landmarks) {
    botObstacles.push([lx - 52, ly - 38, 108, 28]);
  }
  const workerObstacles: Rect[] = [];
  for (const w of occupiedWorkers) {
    workerObstacles.push(...actorFootprintRects(w, true));
  }

  const radii = visitorIsWorker
    ? [74, 80, 69, 81.5]
    : [112, 118, 124, 124.5, 106, 134, 146, 158];
  const minBand = visitorIsWorker ? 68 : 105;
  const preferredMaxBand = visitorIsWorker ? 82 : 125;
  const hardMaxBand = visitorIsWorker ? 82 : 165;

  const dx = start[0] - target[0];
  const dy = start[1] - target[1];
  const dist = Math.hypot(dx, dy);
  const baseAngle = dist < 1 ? 0.35 : Math.atan2(dy, dx);
  const numAngles = 48;
  const angleStep = (2 * Math.PI) / numAngles;

  let bestPos: [number, number] = [
    Math.max(minX, Math.min(maxX, target[0])),
    Math.max(minY, Math.min(maxY, target[1])),
  ];
  let bestScore = Infinity;

  for (const r of radii) {
    for (let aIdx = 0; aIdx < numAngles; aIdx++) {
      const signedStep =
        aIdx === 0 ? 0 : aIdx % 2 === 1 ? Math.ceil(aIdx / 2) : -(aIdx / 2);
      const angle = baseAngle + signedStep * angleStep;
      const cx = Math.max(minX, Math.min(maxX, target[0] + Math.cos(angle) * r));
      const cy = Math.max(minY, Math.min(maxY, target[1] + Math.sin(angle) * r));

      const actualDist = Math.hypot(cx - target[0], cy - target[1]);
      let outPenalty = 0;
      if (actualDist < minBand) outPenalty = (minBand - actualDist) * 10_000;
      else if (actualDist > hardMaxBand) outPenalty = (actualDist - hardMaxBand) * 10_000;
      else if (actualDist > preferredMaxBand) outPenalty = (actualDist - preferredMaxBand) * 200;

      const visitorRects = actorFootprintRects([cx, cy], visitorIsWorker);
      let botOverlap = 0;
      let workerOverlap = 0;
      let paddedOverlap = 0;
      for (const vr of visitorRects) {
        const vrPad = padRect(vr, 4);
        for (const ob of botObstacles) {
          botOverlap += rectOverlapArea(vr, ob);
          paddedOverlap += rectOverlapArea(vrPad, ob);
        }
        for (const ob of workerObstacles) {
          workerOverlap += rectOverlapArea(vr, ob);
          paddedOverlap += rectOverlapArea(vrPad, ob);
        }
      }

      const travelDist = Math.hypot(cx - start[0], cy - start[1]);
      const backPenalty = cy < target[1] - 75 ? 3 : 0;
      const score =
        outPenalty +
        botOverlap * 300 +
        workerOverlap * 300 +
        paddedOverlap * 2 +
        travelDist * 0.05 +
        backPenalty;

      if (score < bestScore) {
        bestScore = score;
        bestPos = [cx, cy];
      }
    }
  }

  return bestPos;
}

function roundTripSegments(
  start: [number, number],
  end: [number, number],
  legDuration: number,
  carry: CarryProp | null,
  onArriveBurst: BurstKind
): WalkSegment[] {
  return [
    { from: start, to: end, duration: legDuration, carry, onDoneBurst: onArriveBurst },
    { from: end, to: start, duration: legDuration, carry: null, onDoneBurst: 'None' },
  ];
}

function roundTripPathSegments(
  waypoints: Array<[number, number]>,
  legDuration: number,
  carry: CarryProp | null,
  onArriveBurst: BurstKind
): WalkSegment[] {
  if (waypoints.length <= 2) {
    const s = waypoints[0];
    const e = waypoints[waypoints.length - 1] ?? s;
    return roundTripSegments(s, e, legDuration, carry, onArriveBurst);
  }
  const segLens: number[] = [];
  let totalLen = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const len = Math.max(1, Math.hypot(waypoints[i + 1][0] - waypoints[i][0], waypoints[i + 1][1] - waypoints[i][1]));
    segLens.push(len);
    totalLen += len;
  }
  const segments: WalkSegment[] = [];
  const lastOutIdx = segLens.length - 1;
  for (let i = 0; i < segLens.length; i++) {
    segments.push({
      from: waypoints[i],
      to: waypoints[i + 1],
      duration: legDuration * (segLens[i] / totalLen),
      carry,
      onDoneBurst: i === lastOutIdx ? onArriveBurst : 'None',
    });
  }
  for (let i = segLens.length - 1; i >= 0; i--) {
    segments.push({
      from: waypoints[i + 1],
      to: waypoints[i],
      duration: legDuration * (segLens[i] / totalLen),
      carry: null,
      onDoneBurst: 'None',
    });
  }
  return segments;
}

function actorKeyFromRef(actor: ActorRef): string | null {
  if (actor.kind === 'Bot') return `bot:${actor.botId}`;
  if (actor.kind === 'Worker') return `worker:${actor.dispatchId}`;
  return null;
}

function currentWalkPos(walk: ActiveWalk): {
  x: number;
  y: number;
  yBobPx: number;
  facing: Facing;
  carry: CarryProp | null;
} {
  const seg = walk.segments[walk.segIdx];
  if (!seg) return { x: 0, y: 0, yBobPx: 0, facing: 'Right', carry: null };
  const rawT = seg.duration <= 1e-6 ? 1 : Math.max(0, Math.min(1, walk.segElapsed / seg.duration));
  const eased = easeInOut(rawT);
  const x = seg.from[0] + (seg.to[0] - seg.from[0]) * eased;
  const y = seg.from[1] + (seg.to[1] - seg.from[1]) * eased;
  const yBobPx = -Math.abs(Math.sin(rawT * Math.PI * 4)) * 5;
  const facing: Facing = seg.to[0] < seg.from[0] - 0.5 ? 'Left' : 'Right';
  return { x, y, yBobPx, facing, carry: seg.carry };
}

export class StageLayout {
  designSize: [number, number] = [1376, 768];
  bossDesk: [number, number] = [825, 215];
  officeDoor: [number, number] = [1140, 625];
  automationBoard: [number, number] = [175, 320];
  botDesks = new Map<string, { x: number; y: number; workerOffset: [number, number] }>();
  workerSeats = new Map<string, { x: number; y: number; parentBotId: string }>();
  botNameToId = new Map<string, string>();

  static fromSnapshot(
    snapshot: WorldSnapshot,
    theme: ThemeConfig,
    customDeskPositions?: Readonly<Record<string, DeskCoordinate>>
  ): StageLayout {
    const layout = new StageLayout();
    layout.designSize = [...theme.designSize];
    layout.bossDesk = [theme.bossDesk.x, theme.bossDesk.y];
    layout.officeDoor = [theme.officeDoor.x, theme.officeDoor.y];
    layout.automationBoard = [theme.automationBoard.x, theme.automationBoard.y];

    const orderedIds =
      snapshot.botOrder.length > 0
        ? snapshot.botOrder.filter((id) => isSafeKey(id) && Object.hasOwn(snapshot.bots, id))
        : Object.keys(snapshot.bots);

    orderedIds.forEach((botId, idx) => {
      const bot = snapshot.bots[botId];
      if (!bot) return;
      const [defaultX, defaultY, wOff] = deskPosition(theme, idx);
      const custom =
        customDeskPositions && isSafeKey(bot.id) && Object.hasOwn(customDeskPositions, bot.id)
          ? customDeskPositions[bot.id]
          : undefined;
      let dx = defaultX;
      let dy = defaultY;
      if (
        custom &&
        typeof custom.x === 'number' &&
        Number.isFinite(custom.x) &&
        typeof custom.y === 'number' &&
        Number.isFinite(custom.y)
      ) {
        const clamped = clampDeskCoordinate(custom);
        dx = clamped.x;
        dy = clamped.y;
      }
      layout.botDesks.set(bot.id, { x: dx, y: dy, workerOffset: wOff });
      layout.botNameToId.set(bot.name, bot.id);
    });

    const designW = Math.max(100, theme.designSize[0]);
    const designH = Math.max(100, theme.designSize[1]);
    const minWorkerY = 60;
    const maxWorkerY = Math.max(minWorkerY, designH - 18);
    const workersPerBot = new Map<string, number>();

    for (const worker of Object.values(snapshot.workers)) {
      if (!isWorkerVisibleOnStage(worker)) continue;
      const pid =
        worker.parentBotId ??
        (worker.parentBotName ? (layout.botNameToId.get(worker.parentBotName) ?? null) : null);
      if (!pid) continue;
      const desk = layout.botDesks.get(pid);
      if (!desk) continue;

      const slotIdx = workersPerBot.get(pid) ?? 0;
      const stackDx = slotIdx * (desk.workerOffset[0] < 0 ? -26 : 26);
      const stackDy = slotIdx * 14;
      workersPerBot.set(pid, slotIdx + 1);

      const wx = Math.max(36, Math.min(designW - 36, desk.x + desk.workerOffset[0] + stackDx));
      const wy = Math.max(minWorkerY, Math.min(maxWorkerY, desk.y + desk.workerOffset[1] + stackDy));
      layout.workerSeats.set(worker.dispatchId, { x: wx, y: wy, parentBotId: pid });
    }

    return layout;
  }

  resolveActorPos(actor: ActorRef): [number, number] | null {
    switch (actor.kind) {
      case 'Bot': {
        const d = this.botDesks.get(actor.botId);
        return d ? [d.x, d.y] : null;
      }
      case 'Worker': {
        const w = this.workerSeats.get(actor.dispatchId);
        if (w) return [w.x, w.y];
        if (actor.parentBotId) {
          const d = this.botDesks.get(actor.parentBotId);
          if (d) return [d.x + d.workerOffset[0], d.y + d.workerOffset[1]];
        }
        return null;
      }
      case 'BossDesk':
        return this.bossDesk;
      case 'AutomationBoard':
        return this.automationBoard;
      case 'OfficeDoor':
        return this.officeDoor;
      case 'Unknown':
        return null;
    }
  }

  workerSeatOrOffset(dispatchId: string, parentBotId: string | null): [number, number] | null {
    const w = this.workerSeats.get(dispatchId);
    if (w) return [w.x, w.y];
    if (parentBotId) {
      const d = this.botDesks.get(parentBotId);
      if (d) return [d.x + d.workerOffset[0], d.y + d.workerOffset[1]];
    }
    return null;
  }
}

export class MotionDirector {
  layout = new StageLayout();
  private layoutFingerprint = '';
  private activeWalks: ActiveWalk[] = [];
  private actorQueues = new Map<string, QueuedMotion[]>();
  private actorQueueOrder: string[] = [];
  flyingProps: FlyingProp[] = [];
  couriers: FlyingCourier[] = [];
  bubbles: SpeechBubble[] = [];
  particles: Particle[] = [];
  huddles: HuddleSparkle[] = [];
  milestoneBanner: MilestoneBanner | null = null;
  private recentBotPairs = new Map<string, number>();
  private lastBotPairKey: string | null = null;
  private nextId = 1;
  private workerSeqCounter = 0;
  private workerSeqById = new Map<string, number>();
  elapsedSecs = 0;
  private rngSeed = 0x9e3779b9;
  locale: UiLocale = 'en';

  setLocale(locale: UiLocale): void {
    if (this.locale === locale) return;
    this.locale = locale;
    for (const b of this.bubbles) {
      if (b.event) {
        const [normalText, redactedText] = formatEventSummaries(b.event, b.seqHint ?? 1, locale);
        b.normalText = normalText;
        b.redactedText = redactedText;
      }
    }
  }

  syncLayout(
    snapshot: WorldSnapshot,
    theme: ThemeConfig,
    customDeskPositions?: Readonly<Record<string, DeskCoordinate>>
  ): void {
    const workerKeys = Object.values(snapshot.workers)
      .filter((w) => isWorkerVisibleOnStage(w))
      .map((w) => `${w.dispatchId}:${w.parentBotId ?? ''}`)
      .join(',');
    const customFp = customDeskPositions
      ? Object.entries(customDeskPositions)
          .filter(
            ([id, p]) =>
              isSafeKey(id) &&
              p &&
              typeof p.x === 'number' &&
              Number.isFinite(p.x) &&
              typeof p.y === 'number' &&
              Number.isFinite(p.y)
          )
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([id, p]) => `${id}:${p.x},${p.y}`)
          .join(';')
      : '';
    const fp = `${theme.id}|${theme.designSize.join('x')}|${snapshot.botOrder.join(',')}|${Object.keys(snapshot.bots).length}|${workerKeys}|${customFp}`;
    if (this.layoutFingerprint !== fp) {
      this.layout = StageLayout.fromSnapshot(snapshot, theme, customDeskPositions);
      this.layoutFingerprint = fp;
    }
  }

  clearTransients(): void {
    this.activeWalks = [];
    this.actorQueues.clear();
    this.actorQueueOrder = [];
    this.flyingProps = [];
    this.couriers = [];
    this.bubbles = [];
    this.particles = [];
    this.huddles = [];
    this.milestoneBanner = null;
    this.recentBotPairs.clear();
    this.lastBotPairKey = null;
  }

  recentBotPairCount(): number {
    return this.recentBotPairs.size;
  }

  hasActiveAnimations(): boolean {
    return (
      this.activeWalks.length > 0 ||
      this.actorQueues.size > 0 ||
      this.flyingProps.length > 0 ||
      this.couriers.length > 0 ||
      this.bubbles.length > 0 ||
      this.particles.length > 0 ||
      this.huddles.length > 0 ||
      this.milestoneBanner !== null
    );
  }

  triggerMilestone(count: number, centerPos?: [number, number]): void {
    const origin: [number, number] = centerPos ?? [
      this.layout.designSize[0] * 0.5,
      this.layout.designSize[1] * 0.24,
    ];
    this.milestoneBanner = {
      count,
      ttl: 2.4,
      maxTtl: 2.4,
    };
    this.spawnBurst('MilestoneConfetti', origin, 26);
  }

  private assignWorkerSeq(dispatchId: string): number {
    const existing = this.workerSeqById.get(dispatchId);
    if (existing !== undefined) return existing;
    this.workerSeqCounter += 1;
    if (this.workerSeqById.size >= 512) {
      const oldest = this.workerSeqById.keys().next().value;
      if (oldest !== undefined) this.workerSeqById.delete(oldest);
    }
    this.workerSeqById.set(dispatchId, this.workerSeqCounter);
    return this.workerSeqCounter;
  }

  enqueueEvents(
    events: WorldEvent[],
    snapshot: WorldSnapshot,
    theme: ThemeConfig,
    locale?: UiLocale,
    customDeskPositions?: Readonly<Record<string, DeskCoordinate>>
  ): void {
    if (locale) {
      this.setLocale(locale);
    }
    const prevWorkerSeats =
      events.length > 0 ? new Map(this.layout.workerSeats) : new Map<string, { x: number; y: number; parentBotId: string }>();
    this.syncLayout(snapshot, theme, customDeskPositions);
    for (const ev of events) {
      this.enqueueSingleEvent(ev, snapshot, prevWorkerSeats);
    }
    this.drainActorQueues();
  }

  step(
    dtSecs: number,
    snapshot: WorldSnapshot,
    theme: ThemeConfig,
    customDeskPositions?: Readonly<Record<string, DeskCoordinate>>
  ): void {
    const dt = Math.max(0, Math.min(0.25, dtSecs));
    if (dt <= 0) return;
    this.elapsedSecs += dt;
    if (this.recentBotPairs.size > 0) {
      for (const [pairKey, recordedAt] of this.recentBotPairs.entries()) {
        if (this.elapsedSecs - recordedAt > 18) {
          this.recentBotPairs.delete(pairKey);
        }
      }
    }
    this.syncLayout(snapshot, theme, customDeskPositions);

    const bursts: Array<{ kind: BurstKind; pos: [number, number] }> = [];
    let i = 0;
    while (i < this.activeWalks.length) {
      const w = this.activeWalks[i];
      w.segElapsed += dt * w.speedMultiplier;
      if (w.workerMotion && (w.workerMotion.kind === 'Entering' || w.workerMotion.kind === 'Leaving')) {
        w.trailAccum += dt * w.speedMultiplier;
        if (w.trailAccum >= 0.28) {
          w.trailAccum %= 0.28;
          if (this.particles.length < MAX_PARTICLES - 8) {
            const pos = currentWalkPos(w);
            this.spawnTrailSparkle([pos.x, pos.y], w.workerMotion.kind);
          }
        }
      }
      while (w.segIdx < w.segments.length && w.segElapsed >= w.segments[w.segIdx].duration) {
        const seg = w.segments[w.segIdx];
        const overflow = w.segElapsed - seg.duration;
        if (seg.onDoneBurst !== 'None') {
          bursts.push({ kind: seg.onDoneBurst, pos: seg.to });
        }
        w.segIdx += 1;
        w.segElapsed = overflow;
      }
      if (w.segIdx >= w.segments.length) {
        this.activeWalks.splice(i, 1);
      } else {
        i++;
      }
    }

    for (const b of bursts) {
      if (b.kind === 'GreenCheckConfetti') {
        this.spawnBurst('GreenCheckConfetti', b.pos, 10);
      } else if (b.kind === 'RedAlert') {
        this.spawnBurst('SweatDrop', b.pos, 4);
      } else if (b.kind === 'Sparkle') {
        this.spawnBurst('Sparkle', b.pos, 6);
      }
    }

    this.drainActorQueues();

    for (const fp of this.flyingProps) fp.elapsed += dt;
    this.flyingProps = this.flyingProps.filter((fp) => fp.elapsed < fp.duration);

    const survivingCouriers: FlyingCourier[] = [];
    for (const c of this.couriers) {
      c.elapsed += dt;
      if (c.elapsed >= c.duration) {
        this.spawnBurst('Sparkle', c.to, 5);
      } else {
        survivingCouriers.push(c);
      }
    }
    this.couriers = survivingCouriers;

    for (const b of this.bubbles) b.ttl -= dt;
    this.bubbles = this.bubbles.filter((b) => b.ttl > 0);

    for (const p of this.particles) {
      p.age += dt;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    this.particles = this.particles.filter((p) => p.age < p.ttl);

    for (const h of this.huddles) {
      h.elapsed += dt;
    }
    this.huddles = this.huddles.filter((h) => h.elapsed < h.duration);

    if (this.milestoneBanner) {
      this.milestoneBanner.ttl -= dt;
      if (this.milestoneBanner.ttl <= 0) {
        this.milestoneBanner = null;
      }
    }
  }

  actorPose(actorKey: string, defaultPos: [number, number]): ActorPose {
    const walk = this.activeWalks.find((w) => w.actorKey === actorKey);
    if (walk) {
      const pos = currentWalkPos(walk);
      return {
        footX: pos.x,
        footY: pos.y,
        yBobPx: pos.yBobPx,
        facing: pos.facing,
        carryProp: pos.carry,
        isWalking: true,
      };
    }
    return {
      footX: defaultPos[0],
      footY: defaultPos[1],
      yBobPx: 0,
      facing: 'Right',
      carryProp: null,
      isWalking: false,
    };
  }

  activeWorkerMotions(): Array<{ meta: WorkerMotion; pose: ActorPose }> {
    const out: Array<{ meta: WorkerMotion; pose: ActorPose }> = [];
    for (const walk of this.activeWalks) {
      if (!walk.workerMotion) continue;
      const pos = currentWalkPos(walk);
      out.push({
        meta: walk.workerMotion,
        pose: {
          footX: pos.x,
          footY: pos.y,
          yBobPx: pos.yBobPx,
          facing: pos.facing,
          carryProp: pos.carry,
          isWalking: true,
        },
      });
    }
    return out;
  }

  bubbleAnchorPos(bubble: SpeechBubble): [number, number] {
    if (bubble.anchorActorKey) {
      const walk = this.activeWalks.find((w) => w.actorKey === bubble.anchorActorKey);
      if (walk) {
        const pos = currentWalkPos(walk);
        return [pos.x, pos.y];
      }
      if (bubble.anchorActorKey.startsWith('bot:')) {
        const bid = bubble.anchorActorKey.slice(4);
        const desk = this.layout.botDesks.get(bid);
        if (desk) return [desk.x, desk.y];
      } else if (bubble.anchorActorKey.startsWith('worker:')) {
        const did = bubble.anchorActorKey.slice(7);
        const seat = this.layout.workerSeats.get(did);
        if (seat) return [seat.x, seat.y];
      }
    }
    return bubble.fallbackPos;
  }

  private enqueueSingleEvent(
    event: WorldEvent,
    snapshot: WorldSnapshot,
    prevWorkerSeats: Map<string, { x: number; y: number; parentBotId: string }>
  ): void {
    const seqHint = event.kind === 'WorkerStart' ? this.assignWorkerSeq(event.dispatchId) : 1;
    const [normalText, redactedText] = formatEventSummaries(event, seqHint, this.locale);

    switch (event.kind) {
      case 'Handoff':
      case 'Question':
      case 'StatusReport': {
        const start =
          this.layout.resolveActorPos(event.from) ??
          (event.kind === 'Handoff' ? this.layout.bossDesk : this.layout.officeDoor);
        const end = this.layout.resolveActorPos(event.to) ?? this.layout.bossDesk;
        this.recordBotInteractionForHuddle(event.from, event.to, start, end);
        const courierKind: CourierKind = event.kind === 'Handoff' ? 'paper_plane' : 'envelope';
        this.spawnCourier(courierKind, start, end, 1.1);
        const aKey = actorKeyFromRef(event.from);
        const visitEnd = this.resolveVisitStopPoint(aKey, start, end);
        const carry: CarryProp =
          event.kind === 'Handoff'
            ? 'YellowEnvelope'
            : event.kind === 'Question'
              ? 'QuestionMark'
              : 'ReportBox';
        const dur = event.kind === 'Handoff' ? 1.25 : 1.0;
        if (aKey) {
          const waypoints = this.resolveWalkWaypoints(aKey, start, visitEnd, end);
          this.scheduleWalkOrFlood(aKey, {
            segments: roundTripPathSegments(waypoints, dur, carry, 'None'),
            workerMotion: null,
            flyingFallback: {
              kind: { kind: 'PaperAirplane', isFloodReplacement: true },
              start,
              end,
              arcHeight: 62,
              duration: 0.72,
            },
          });
        }
        this.pushBubble(
          aKey,
          start,
          normalText,
          redactedText,
          event.kind === 'Question' ? 'Question' : 'Normal',
          event.kind === 'Handoff' ? 2.5 : 2.0,
          event,
          seqHint
        );
        break;
      }
      case 'Reply': {
        const start = this.layout.resolveActorPos(event.from) ?? this.layout.bossDesk;
        const end = this.layout.resolveActorPos(event.to) ?? this.layout.officeDoor;
        this.recordBotInteractionForHuddle(event.from, event.to, start, end);
        this.spawnCourier('paper_plane', start, end, 1.1);
        this.pushBubble(
          actorKeyFromRef(event.from),
          start,
          normalText,
          redactedText,
          'Normal',
          1.8,
          event,
          seqHint
        );
        break;
      }
      case 'WorkerStart': {
        const seat =
          this.layout.workerSeatOrOffset(event.dispatchId, event.parentBotId) ??
          this.layout.officeDoor;
        const door = this.layout.officeDoor;
        const aKey = `worker:${event.dispatchId}`;
        const meta = this.buildWorkerMotion(
          snapshot,
          event.dispatchId,
          event.parentBotId,
          event.provider,
          'working',
          'Entering'
        );
        this.spawnBurst('Sparkle', door, 4);
        this.scheduleWalkOrFlood(aKey, {
          segments: [{ from: door, to: seat, duration: 2.2, carry: null, onDoneBurst: 'Sparkle' }],
          workerMotion: meta,
          flyingFallback: null,
        });
        this.pushBubble(aKey, seat, normalText, redactedText, 'Normal', 2.2, event, seqHint);
        break;
      }
      case 'WorkerDone':
      case 'WorkerFailed': {
        const wSeat = this.layout.workerSeats.get(event.dispatchId);
        const prevWSeat = prevWorkerSeats.get(event.dispatchId);
        const start: [number, number] = wSeat
          ? [wSeat.x, wSeat.y]
          : prevWSeat
            ? [prevWSeat.x, prevWSeat.y]
            : (this.layout.workerSeatOrOffset(event.dispatchId, event.parentBotId) ??
              this.layout.officeDoor);
        const pDesk = event.parentBotId ? this.layout.botDesks.get(event.parentBotId) : undefined;
        const end: [number, number] = pDesk ? [pDesk.x, pDesk.y] : this.layout.bossDesk;
        const door = this.layout.officeDoor;
        const aKey = `worker:${event.dispatchId}`;
        const visitEnd = this.resolveVisitStopPoint(aKey, start, end);
        const workerObj = Object.hasOwn(snapshot.workers, event.dispatchId)
          ? snapshot.workers[event.dispatchId]
          : undefined;
        const stillVisible = workerObj ? isWorkerVisibleOnStage(workerObj) : false;
        const isDone = event.kind === 'WorkerDone';
        const segments: WalkSegment[] =
          isDone && stillVisible
            ? roundTripSegments(start, visitEnd, 1.25, 'GreenRibbonBox', 'GreenCheckConfetti')
            : stillVisible
              ? [
                  {
                    from: start,
                    to: visitEnd,
                    duration: 1.25,
                    carry: 'RedXDoc' as const,
                    onDoneBurst: 'RedAlert' as const,
                  },
                ]
              : [
                  {
                    from: start,
                    to: visitEnd,
                    duration: 1.05,
                    carry: isDone ? ('GreenRibbonBox' as const) : ('RedXDoc' as const),
                    onDoneBurst: isDone ? ('GreenCheckConfetti' as const) : ('RedAlert' as const),
                  },
                  {
                    from: visitEnd,
                    to: door,
                    duration: 1.35,
                    carry: null,
                    onDoneBurst: 'Sparkle' as const,
                  },
                ];
        const meta = this.buildWorkerMotion(
          snapshot,
          event.dispatchId,
          event.parentBotId,
          null,
          isDone ? 'done' : 'failed',
          stillVisible ? 'DeliveringToParent' : 'Leaving'
        );
        this.scheduleWalkOrFlood(aKey, {
          segments,
          workerMotion: meta,
          flyingFallback: {
            kind: { kind: 'PaperAirplane', isFloodReplacement: true },
            start,
            end,
            arcHeight: 64,
            duration: 0.7,
          },
        });
        this.pushBubble(
          aKey,
          visitEnd,
          normalText,
          redactedText,
          isDone ? 'Success' : 'Alert',
          2.5,
          event,
          seqHint
        );
        break;
      }
      case 'Escalation': {
        const pDesk = event.targetBotId ? this.layout.botDesks.get(event.targetBotId) : undefined;
        const pos =
          this.layout.resolveActorPos(event.actor) ??
          (pDesk ? ([pDesk.x, pDesk.y] as [number, number]) : this.layout.bossDesk);
        this.spawnBurst('LockOrange', pos, 5);
        this.pushBubble(actorKeyFromRef(event.actor), pos, normalText, redactedText, 'Alert', 2.5, event, seqHint);
        break;
      }
      case 'ApprovalClosed': {
        const pDesk = event.parentBotId ? this.layout.botDesks.get(event.parentBotId) : undefined;
        const pos =
          this.layout.resolveActorPos(event.actor) ??
          (pDesk ? ([pDesk.x, pDesk.y] as [number, number]) : this.layout.bossDesk);
        this.spawnBurst('LockOpen', pos, 5);
        this.pushBubble(
          actorKeyFromRef(event.actor),
          pos,
          normalText,
          redactedText,
          'Success',
          1.5,
          event,
          seqHint
        );
        break;
      }
      case 'ItemNeedsYou': {
        const d = this.layout.botDesks.get(event.botId);
        const pos: [number, number] = d ? [d.x, d.y] : this.layout.bossDesk;
        this.spawnBurst('Sparkle', this.layout.bossDesk, 4);
        this.pushBubble(`bot:${event.botId}`, pos, normalText, redactedText, 'Boss', 2.5, event, seqHint);
        break;
      }
      case 'BossReplied': {
        const d = this.layout.botDesks.get(event.botId);
        const end: [number, number] = d ? [d.x, d.y] : this.layout.officeDoor;
        const start = this.layout.bossDesk;
        this.spawnFlyingProp({ kind: 'BossStamp' }, start, end, 95, 1.5);
        this.spawnBurst('Sparkle', start, 6);
        this.pushBubble(`bot:${event.botId}`, end, normalText, redactedText, 'Boss', 2.0, event, seqHint);
        break;
      }
      case 'ItemDone': {
        const d = this.layout.botDesks.get(event.botId);
        const pos: [number, number] = d ? [d.x, d.y] : this.layout.bossDesk;
        this.spawnBurst('GreenCheckConfetti', pos, 14);
        this.pushBubble(`bot:${event.botId}`, pos, normalText, redactedText, 'Success', 1.8, event, seqHint);
        break;
      }
      case 'ItemCanceled': {
        const d = this.layout.botDesks.get(event.botId);
        const pos: [number, number] = d ? [d.x, d.y] : this.layout.bossDesk;
        this.spawnBurst('GrayArchive', pos, 6);
        this.pushBubble(`bot:${event.botId}`, pos, normalText, redactedText, 'Normal', 1.4, event, seqHint);
        break;
      }
      case 'BotWorking':
      case 'ToolChanged': {
        const d = this.layout.botDesks.get(event.botId);
        const pos: [number, number] = d ? [d.x, d.y] : this.layout.bossDesk;
        this.pushBubble(`bot:${event.botId}`, pos, normalText, redactedText, 'Normal', 1.4, event, seqHint);
        break;
      }
      case 'BotIdle':
      case 'WaitingAnswer':
        break;
      case 'BotFailed': {
        const d = this.layout.botDesks.get(event.botId);
        const pos: [number, number] = d ? [d.x, d.y] : this.layout.bossDesk;
        this.spawnBurst('SweatDrop', pos, 7);
        this.pushBubble(`bot:${event.botId}`, pos, normalText, redactedText, 'Alert', 2.5, event, seqHint);
        break;
      }
      case 'AutomationRun': {
        const start = this.layout.automationBoard;
        const d = event.botId ? this.layout.botDesks.get(event.botId) : undefined;
        const end: [number, number] = d ? [d.x, d.y] : this.layout.bossDesk;
        this.spawnBurst('Sparkle', start, 6);
        this.spawnFlyingProp(
          { kind: 'AutomationNote', noReply: event.noReply, success: event.success },
          start,
          end,
          72,
          1.2
        );
        if (!event.success) {
          this.spawnBurst('SweatDrop', end, 4);
        }
        this.pushBubble(
          event.botId ? `bot:${event.botId}` : null,
          end,
          normalText,
          redactedText,
          event.success ? 'Normal' : 'Alert',
          1.8,
          event,
          seqHint
        );
        break;
      }
      case 'BotPaused': {
        const d = this.layout.botDesks.get(event.botId);
        const pos: [number, number] = d ? [d.x, d.y] : this.layout.bossDesk;
        this.pushBubble(`bot:${event.botId}`, pos, normalText, redactedText, 'Normal', 1.5, event, seqHint);
        break;
      }
      case 'WorkerExited': {
        const wSeat = this.layout.workerSeats.get(event.dispatchId);
        const prevWSeat = prevWorkerSeats.get(event.dispatchId);
        const start: [number, number] = wSeat
          ? [wSeat.x, wSeat.y]
          : prevWSeat
            ? [prevWSeat.x, prevWSeat.y]
            : (this.layout.workerSeatOrOffset(event.dispatchId, event.parentBotId) ??
              this.layout.officeDoor);
        const door = this.layout.officeDoor;
        const aKey = `worker:${event.dispatchId}`;
        const meta = this.buildWorkerMotion(
          snapshot,
          event.dispatchId,
          event.parentBotId,
          event.provider,
          'exited',
          'Leaving'
        );
        this.spawnBurst('GrayArchive', start, 4);
        this.scheduleWalkOrFlood(aKey, {
          segments: [{ from: start, to: door, duration: 1.6, carry: null, onDoneBurst: 'Sparkle' }],
          workerMotion: meta,
          flyingFallback: null,
        });
        this.pushBubble(aKey, start, normalText, redactedText, 'Normal', 1.6, event, seqHint);
        break;
      }
      case 'WorkerReleased': {
        const wSeat = this.layout.workerSeats.get(event.dispatchId);
        const prevWSeat = prevWorkerSeats.get(event.dispatchId);
        const start: [number, number] = wSeat
          ? [wSeat.x, wSeat.y]
          : prevWSeat
            ? [prevWSeat.x, prevWSeat.y]
            : (this.layout.workerSeatOrOffset(event.dispatchId, event.parentBotId) ??
              this.layout.bossDesk);
        const door = this.layout.officeDoor;
        const aKey = `worker:${event.dispatchId}`;
        const meta = this.buildWorkerMotion(
          snapshot,
          event.dispatchId,
          event.parentBotId,
          event.provider,
          'released',
          'Leaving'
        );
        this.scheduleWalkOrFlood(aKey, {
          segments: [{ from: start, to: door, duration: 1.8, carry: null, onDoneBurst: 'Sparkle' }],
          workerMotion: meta,
          flyingFallback: null,
        });
        this.pushBubble(aKey, start, normalText, redactedText, 'Normal', 1.8, event, seqHint);
        break;
      }
      case 'BotJoined': {
        const d = this.layout.botDesks.get(event.botId);
        const desk: [number, number] = d ? [d.x, d.y] : this.layout.bossDesk;
        const door = this.layout.officeDoor;
        const aKey = `bot:${event.botId}`;
        this.scheduleWalkOrFlood(aKey, {
          segments: [{ from: door, to: desk, duration: 2.4, carry: null, onDoneBurst: 'None' }],
          workerMotion: null,
          flyingFallback: null,
        });
        this.spawnBurst('Sparkle', desk, 6);
        this.pushBubble(aKey, desk, normalText, redactedText, 'Success', 2.4, event, seqHint);
        break;
      }
    }
  }

  private recordBotInteractionForHuddle(
    from: ActorRef,
    to: ActorRef,
    fromPos: [number, number],
    toPos: [number, number]
  ): void {
    if (from.kind !== 'Bot' || to.kind !== 'Bot' || from.botId === to.botId) {
      return;
    }
    const [a, b] = from.botId < to.botId ? [from.botId, to.botId] : [to.botId, from.botId];
    const pairKey = `${a}::${b}`;
    const prevElapsed = this.recentBotPairs.get(pairKey);
    const isConsecutiveOrRecent =
      this.lastBotPairKey === pairKey ||
      (prevElapsed !== undefined && this.elapsedSecs - prevElapsed <= 18);

    this.recentBotPairs.set(pairKey, this.elapsedSecs);
    this.lastBotPairKey = pairKey;

    if (isConsecutiveOrRecent) {
      const existing = this.huddles.find(
        (h) => (h.botAId === a && h.botBId === b) || (h.botAId === b && h.botBId === a)
      );
      if (existing) {
        existing.elapsed = 0;
        existing.from = [fromPos[0], fromPos[1]];
        existing.to = [toPos[0], toPos[1]];
      } else {
        if (this.huddles.length >= 4) {
          this.huddles.shift();
        }
        this.huddles.push({
          id: this.nextId++,
          botAId: a,
          botBId: b,
          from: [fromPos[0], fromPos[1]],
          to: [toPos[0], toPos[1]],
          elapsed: 0,
          duration: 2.6,
        });
      }
    }
  }

  private scheduleWalkOrFlood(actorKey: string, motion: QueuedMotion): void {
    const existing = this.actorQueues.get(actorKey)?.length ?? 0;
    const active = this.activeWalks.some((w) => w.actorKey === actorKey) ? 1 : 0;
    if (existing + active >= FLOOD_QUEUE_THRESHOLD) {
      for (const w of this.activeWalks) {
        if (w.actorKey === actorKey) w.speedMultiplier = FLOOD_SPEED_MULTIPLIER;
      }
      if (motion.flyingFallback) {
        const ff = motion.flyingFallback;
        this.spawnFlyingProp(ff.kind, ff.start, ff.end, ff.arcHeight, ff.duration);
        return;
      }
    }
    if (!this.actorQueues.has(actorKey) && !this.actorQueueOrder.includes(actorKey)) {
      this.actorQueueOrder.push(actorKey);
    }
    const queue = this.actorQueues.get(actorKey) ?? [];
    if (queue.length >= 8) queue.shift();
    queue.push(motion);
    this.actorQueues.set(actorKey, queue);
  }

  private drainActorQueues(): void {
    let checked = 0;
    const maxChecks = this.actorQueueOrder.length;
    while (this.activeWalks.length < MAX_CONCURRENT_WALKERS && checked < maxChecks) {
      checked++;
      const actorKey = this.actorQueueOrder.shift();
      if (!actorKey) break;
      if (this.activeWalks.some((w) => w.actorKey === actorKey)) {
        const q = this.actorQueues.get(actorKey);
        if (q && q.length > 0) this.actorQueueOrder.push(actorKey);
        else this.actorQueues.delete(actorKey);
        continue;
      }
      const q = this.actorQueues.get(actorKey);
      if (!q || q.length === 0) {
        this.actorQueues.delete(actorKey);
        continue;
      }
      const motion = q.shift()!;
      const speedMultiplier = q.length >= FLOOD_QUEUE_THRESHOLD ? FLOOD_SPEED_MULTIPLIER : 1.0;
      if (q.length === 0) {
        this.actorQueues.delete(actorKey);
      } else {
        this.actorQueueOrder.push(actorKey);
      }
      this.activeWalks.push({
        actorKey,
        segments: motion.segments,
        segIdx: 0,
        segElapsed: 0,
        speedMultiplier,
        workerMotion: motion.workerMotion,
        trailAccum: 0,
      });
    }

    if (this.activeWalks.length >= MAX_CONCURRENT_WALKERS) {
      for (const [actorKey, q] of Array.from(this.actorQueues.entries())) {
        while (q.length >= FLOOD_QUEUE_THRESHOLD) {
          const front = q.shift();
          if (front?.flyingFallback) {
            const ff = front.flyingFallback;
            this.spawnFlyingProp(ff.kind, ff.start, ff.end, ff.arcHeight, ff.duration);
          }
        }
        if (q.length === 0) this.actorQueues.delete(actorKey);
      }
    }
    this.actorQueueOrder = this.actorQueueOrder.filter((k) => (this.actorQueues.get(k)?.length ?? 0) > 0);
  }

  private spawnCourier(
    kind: CourierKind,
    from: [number, number],
    to: [number, number],
    duration = 1.1
  ): void {
    if (this.couriers.length >= MAX_COURIERS) {
      this.couriers.shift();
    }
    const midX = (from[0] + to[0]) * 0.5;
    const midY = (from[1] + to[1]) * 0.5;
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const dist = Math.hypot(dx, dy);
    const arcLift = Math.max(54, Math.min(130, dist * 0.28 + 38));
    const sideCurve = Math.abs(dx) < 40 ? (dy >= 0 ? 46 : -46) : 0;
    const control: [number, number] = [midX + sideCurve, Math.max(40, midY - arcLift)];
    this.couriers.push({
      id: this.nextId++,
      kind,
      from: [from[0], from[1]],
      to: [to[0], to[1]],
      control,
      elapsed: 0,
      duration: Math.max(0.3, duration),
    });
  }

  private spawnTrailSparkle(pos: [number, number], kind: 'Entering' | 'Leaving'): void {
    if (this.particles.length >= MAX_PARTICLES) return;
    const r1 = this.nextRand();
    this.particles.push({
      kind: 'Sparkle',
      x: pos[0] + (r1 - 0.5) * 10,
      y: pos[1] - 6,
      vx: (r1 - 0.5) * 14,
      vy: -14 - r1 * 10,
      gravity: 12,
      age: 0,
      ttl: 0.48,
      colorHex: kind === 'Entering' ? '#7dd3fc' : '#fde047',
      size: 4.5,
    });
  }

  private spawnFlyingProp(
    kind: FlyingPropKind,
    start: [number, number],
    end: [number, number],
    arcHeight: number,
    duration: number
  ): void {
    if (this.flyingProps.length >= 32) this.flyingProps.shift();
    this.flyingProps.push({
      id: this.nextId++,
      kind,
      start,
      end,
      arcHeight,
      elapsed: 0,
      duration: Math.max(0.2, duration),
    });
  }

  private pushBubble(
    anchorActorKey: string | null,
    fallbackPos: [number, number],
    normalText: string,
    redactedText: string,
    kind: BubbleKind,
    ttl: number,
    event?: WorldEvent,
    seqHint?: number
  ): void {
    if (anchorActorKey) {
      const existing = this.bubbles.find((b) => b.anchorActorKey === anchorActorKey);
      if (existing) {
        existing.normalText = normalText;
        existing.redactedText = redactedText;
        existing.kind = kind;
        existing.ttl = ttl;
        existing.maxTtl = ttl;
        existing.fallbackPos = fallbackPos;
        existing.event = event;
        existing.seqHint = seqHint;
        return;
      }
    }
    if (this.bubbles.length >= MAX_BUBBLES) {
      let minIdx = 0;
      for (let i = 1; i < this.bubbles.length; i++) {
        if (this.bubbles[i].ttl < this.bubbles[minIdx].ttl) minIdx = i;
      }
      this.bubbles.splice(minIdx, 1);
    }
    this.bubbles.push({
      id: this.nextId++,
      anchorActorKey,
      fallbackPos,
      normalText,
      redactedText,
      kind,
      ttl,
      maxTtl: ttl,
      event,
      seqHint,
    });
  }

  private nextRand(): number {
    this.rngSeed = (this.rngSeed * 1664525 + 1013904223) >>> 0;
    return this.rngSeed / 0x100000000;
  }

  private spawnBurst(kind: ParticleKind, origin: [number, number], count: number): void {
    for (let i = 0; i < count; i++) {
      if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
      const r1 = this.nextRand();
      const r2 = this.nextRand();
      let vx = 0;
      let vy = 0;
      let gravity = 0;
      let ttl = 0.8;
      let colorHex = '#4ade80';
      let size = 6;
      if (kind === 'GreenCheckConfetti') {
        const angle = (i / Math.max(1, count)) * Math.PI * 2 + r1 * 0.4;
        const speed = 35 + r2 * 65;
        const palette = ['#22c55e', '#4ade80', '#facc15', '#38bdf8'];
        vx = Math.cos(angle) * speed;
        vy = Math.sin(angle) * speed - 48;
        gravity = 120;
        ttl = 0.95 + r1 * 0.35;
        colorHex = palette[i % palette.length];
        size = 6;
      } else if (kind === 'MilestoneConfetti') {
        const angle = (i / Math.max(1, count)) * Math.PI * 2 + r1 * 0.5;
        const speed = 60 + r2 * 115;
        const palette = ['#22c55e', '#38bdf8', '#facc15', '#f472b6', '#a78bfa', '#fb923c'];
        vx = Math.cos(angle) * speed;
        vy = Math.sin(angle) * speed * 0.65 - 70;
        gravity = 135;
        ttl = 1.9 + r1 * 0.5;
        colorHex = palette[i % palette.length];
        size = 6.5 + r2 * 2.5;
      } else if (kind === 'Sparkle') {
        const angle = (i / Math.max(1, count)) * Math.PI * 2;
        const speed = 18 + r1 * 28;
        vx = Math.cos(angle) * speed;
        vy = Math.sin(angle) * speed - 18;
        gravity = 15;
        ttl = 0.8 + r2 * 0.3;
        colorHex = i % 2 === 0 ? '#facc15' : '#fef08a';
        size = 6.5;
      } else if (kind === 'SweatDrop') {
        vx = (r1 - 0.5) * 44;
        vy = -28 - r2 * 24;
        gravity = 95;
        ttl = 0.85;
        colorHex = '#38bdf8';
        size = 5.5;
      } else if (kind === 'LockOrange') {
        vx = (r1 - 0.5) * 26;
        vy = -22 - r2 * 18;
        gravity = 20;
        ttl = 1.0;
        colorHex = '#f97316';
        size = 7.5;
      } else if (kind === 'LockOpen') {
        vx = (r1 - 0.5) * 32;
        vy = -32 - r2 * 18;
        gravity = 25;
        ttl = 0.9;
        colorHex = '#4ade80';
        size = 7.5;
      } else {
        vx = (r1 - 0.5) * 24;
        vy = -18 - r2 * 14;
        gravity = 30;
        ttl = 0.8;
        colorHex = '#94a3b8';
        size = 5.5;
      }
      this.particles.push({
        kind,
        x: origin[0] + (r1 - 0.5) * 14,
        y: origin[1] - 36 + (r2 - 0.5) * 10,
        vx,
        vy,
        gravity,
        age: 0,
        ttl,
        colorHex,
        size,
      });
    }
  }

  private resolveVisitStopPoint(
    visitorKey: string | null,
    start: [number, number],
    target: [number, number]
  ): [number, number] {
    const visitorIsWorker = visitorKey !== null && visitorKey.startsWith('worker:');
    const occupiedBots: Array<[number, number]> = [];
    for (const d of this.layout.botDesks.values()) {
      pushUniquePos(occupiedBots, [d.x, d.y]);
    }
    const occupiedWorkers: Array<[number, number]> = [];
    for (const [did, seat] of this.layout.workerSeats.entries()) {
      if (visitorKey !== `worker:${did}`) {
        pushUniquePos(occupiedWorkers, [seat.x, seat.y]);
      }
    }
    for (const walk of this.activeWalks) {
      if (walk.actorKey === visitorKey) continue;
      const stopPos = motionVisitStopDestination(walk.segments);
      if (stopPos) {
        if (walk.actorKey.startsWith('bot:')) pushUniquePos(occupiedBots, stopPos);
        else pushUniquePos(occupiedWorkers, stopPos);
      }
      if (walk.actorKey.startsWith('worker:') || walk.workerMotion) {
        const pos = currentWalkPos(walk);
        pushUniquePos(occupiedWorkers, [pos.x, pos.y]);
      }
    }
    return visitStopPointAvoiding(
      start,
      target,
      this.layout.designSize,
      visitorIsWorker,
      occupiedBots,
      occupiedWorkers,
      [this.layout.bossDesk, this.layout.officeDoor, this.layout.automationBoard]
    );
  }

  private resolveWalkWaypoints(
    visitorKey: string | null,
    start: [number, number],
    visitEnd: [number, number],
    target: [number, number]
  ): Array<[number, number]> {
    if (visitorKey && visitorKey.startsWith('worker:')) return [start, visitEnd];
    const dx = visitEnd[0] - start[0];
    const dy = visitEnd[1] - start[1];
    const chord = Math.hypot(dx, dy);
    if (chord < 140) return [start, visitEnd];

    const intermediateObstacles: Rect[] = [];
    for (const d of this.layout.botDesks.values()) {
      const dStart = Math.hypot(d.x - start[0], d.y - start[1]);
      const dTarget = Math.hypot(d.x - target[0], d.y - target[1]);
      if (dStart < 20 || dTarget < 20) continue;
      intermediateObstacles.push(...actorFootprintRects([d.x, d.y], false));
    }
    for (const [lx, ly] of [this.layout.bossDesk, this.layout.officeDoor, this.layout.automationBoard]) {
      if (Math.hypot(lx - start[0], ly - start[1]) < 20 || Math.hypot(lx - target[0], ly - target[1]) < 20) {
        continue;
      }
      intermediateObstacles.push([lx - 52, ly - 38, 108, 28]);
    }

    const sampleLegOverlap = (a: [number, number], b: [number, number], includeEnd: boolean): number => {
      const ts = includeEnd ? [0.2, 0.4, 0.6, 0.8, 1.0] : [0.2, 0.35, 0.5, 0.65, 0.8];
      let total = 0;
      for (const t of ts) {
        const px = a[0] + (b[0] - a[0]) * t;
        const py = a[1] + (b[1] - a[1]) * t;
        for (const vr of actorFootprintRects([px, py], false)) {
          for (const ob of intermediateObstacles) {
            total += rectOverlapArea(vr, ob);
          }
        }
      }
      return total;
    };

    const straightOverlap = sampleLegOverlap(start, visitEnd, false);
    if (straightOverlap <= 0) return [start, visitEnd];

    const minX = 76;
    const maxX = Math.max(minX, this.layout.designSize[0] - 76);
    const minY = 92;
    const maxY = Math.max(minY, this.layout.designSize[1] - 54);
    const perp: [number, number] = [-dy / chord, dx / chord];
    let bestWp: [number, number] | null = null;
    let bestScore = straightOverlap;

    for (const along of [0.35, 0.5, 0.65]) {
      const bx = start[0] + dx * along;
      const by = start[1] + dy * along;
      for (const side of [1, -1]) {
        for (const offset of [90, 140, 190, 240]) {
          const wx = Math.max(minX, Math.min(maxX, bx + perp[0] * side * offset));
          const wy = Math.max(minY, Math.min(maxY, by + perp[1] * side * offset));
          const wp: [number, number] = [wx, wy];
          const ov = sampleLegOverlap(start, wp, true) + sampleLegOverlap(wp, visitEnd, false);
          const len1 = Math.hypot(wx - start[0], wy - start[1]);
          const len2 = Math.hypot(visitEnd[0] - wx, visitEnd[1] - wy);
          const score = ov + (len1 + len2 - chord) * 0.05;
          if (score < bestScore) {
            bestScore = score;
            bestWp = wp;
          }
        }
      }
    }

    return bestWp ? [start, bestWp, visitEnd] : [start, visitEnd];
  }

  private buildWorkerMotion(
    snapshot: WorldSnapshot,
    dispatchId: string,
    parentBotId: string | null,
    fallbackProvider: string | null,
    fallbackActivity: string,
    kind: WorkerMotion['kind']
  ): WorkerMotion {
    const w = Object.hasOwn(snapshot.workers, dispatchId) ? snapshot.workers[dispatchId] : undefined;
    if (w) {
      return {
        dispatchId,
        parentBotId: parentBotId ?? w.parentBotId,
        provider: w.provider,
        activity: kind === 'Leaving' ? 'released' : w.activity || fallbackActivity,
        liveness: w.liveness,
        kind,
      };
    }
    return {
      dispatchId,
      parentBotId,
      provider: fallbackProvider ?? 'worker',
      activity: fallbackActivity,
      liveness: kind === 'Entering' ? 'Live' : 'Unverifiable',
      kind,
    };
  }
}

export const REPLAY_SPEEDS = [1, 2, 5, 10] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export class ReplayController {
  isReplay = false;
  isPlaying = false;
  speed: ReplaySpeed = 1;
  cursorMs = 0;
  snapshot: WorldSnapshot = createEmptySnapshot();
  motion = new MotionDirector();

  timeBounds(keyframes: readonly Keyframe[], events: readonly WorldEventRecord[]): [number, number] | null {
    let minTs: number | null = null;
    let maxTs: number | null = null;
    const candidates = [
      keyframes[0]?.timestampMs,
      keyframes[keyframes.length - 1]?.timestampMs,
      events[0]?.timestampMs,
      events[events.length - 1]?.timestampMs,
    ];
    for (const ts of candidates) {
      if (typeof ts !== 'number' || ts <= 0) continue;
      minTs = minTs === null ? ts : Math.min(minTs, ts);
      maxTs = maxTs === null ? ts : Math.max(maxTs, ts);
    }
    return minTs !== null && maxTs !== null ? [minTs, Math.max(minTs, maxTs)] : null;
  }

  private snapshotAt(keyframes: readonly Keyframe[], timestampMs: number): WorldSnapshot | null {
    if (keyframes.length === 0) return null;
    if (keyframes.length === 1 || timestampMs <= keyframes[0].timestampMs) {
      return { ...keyframes[0].snapshot, capturedAt: Math.max(timestampMs, keyframes[0].timestampMs) };
    }
    const lastIdx = keyframes.length - 1;
    if (timestampMs >= keyframes[lastIdx].timestampMs) {
      return { ...keyframes[lastIdx].snapshot, capturedAt: Math.max(timestampMs, keyframes[lastIdx].timestampMs) };
    }
    let nextIdx = 0;
    while (nextIdx < lastIdx && keyframes[nextIdx].timestampMs <= timestampMs) nextIdx++;
    const prevIdx = Math.max(0, nextIdx - 1);
    return {
      ...keyframes[prevIdx].snapshot,
      capturedAt: Math.max(timestampMs, keyframes[prevIdx].timestampMs),
    };
  }

  setLocale(locale: UiLocale): void {
    this.motion.setLocale(locale);
  }

  resyncSnapshot(
    keyframes: readonly Keyframe[],
    liveSnapshot: WorldSnapshot,
    theme: ThemeConfig,
    locale?: UiLocale,
    customDeskPositions?: Readonly<Record<string, DeskCoordinate>>
  ): void {
    if (locale) {
      this.motion.setLocale(locale);
    }
    if (!this.isReplay) return;
    this.snapshot =
      this.snapshotAt(keyframes, this.cursorMs) ?? {
        ...liveSnapshot,
        capturedAt: this.cursorMs,
      };
    this.motion.syncLayout(this.snapshot, theme, customDeskPositions);
  }

  seekTo(
    targetMs: number,
    keyframes: readonly Keyframe[],
    events: readonly WorldEventRecord[],
    liveSnapshot: WorldSnapshot,
    theme: ThemeConfig,
    locale?: UiLocale,
    customDeskPositions?: Readonly<Record<string, DeskCoordinate>>
  ): void {
    if (locale) {
      this.motion.setLocale(locale);
    }
    const bounds = this.timeBounds(keyframes, events);
    if (!bounds) {
      this.isReplay = true;
      this.cursorMs = liveSnapshot.capturedAt;
      this.snapshot = liveSnapshot;
      this.motion.clearTransients();
      this.motion.syncLayout(this.snapshot, theme, customDeskPositions);
      return;
    }

    const [minTs, maxTs] = bounds;
    const clamped = Math.max(minTs, Math.min(maxTs, targetMs));
    this.isReplay = true;
    this.cursorMs = clamped;
    this.snapshot = this.snapshotAt(keyframes, clamped) ?? { ...liveSnapshot, capturedAt: clamped };
    this.motion.clearTransients();
    this.motion.syncLayout(this.snapshot, theme, customDeskPositions);

    const lookbackFloor = clamped - 3_000;
    const recent = events
      .filter((r) => r.timestampMs >= lookbackFloor && r.timestampMs <= clamped)
      .sort((a, b) => a.timestampMs - b.timestampMs);
    if (recent.length > 0) {
      let simMs = lookbackFloor;
      let idx = 0;
      while (idx < recent.length) {
        const evTs = Math.max(simMs, Math.min(clamped, recent[idx].timestampMs));
        const dtSecs = Math.min(3, Math.max(0, (evTs - simMs) / 1000));
        if (dtSecs > 0) {
          this.stepMotionSubsteps(dtSecs, theme, customDeskPositions);
        }
        simMs = evTs;
        const batch: WorldEvent[] = [];
        while (idx < recent.length && Math.max(simMs, Math.min(clamped, recent[idx].timestampMs)) === evTs) {
          batch.push(recent[idx].event);
          idx++;
        }
        this.motion.enqueueEvents(batch, this.snapshot, theme, locale, customDeskPositions);
      }
      const tailSecs = Math.min(3, Math.max(0, (clamped - simMs) / 1000));
      if (tailSecs > 0) {
        this.stepMotionSubsteps(tailSecs, theme, customDeskPositions);
      }
    }
  }

  seekFraction(
    fraction: number,
    keyframes: readonly Keyframe[],
    events: readonly WorldEventRecord[],
    liveSnapshot: WorldSnapshot,
    theme: ThemeConfig,
    locale?: UiLocale,
    customDeskPositions?: Readonly<Record<string, DeskCoordinate>>
  ): void {
    const t = Math.max(0, Math.min(1, fraction));
    const bounds = this.timeBounds(keyframes, events);
    if (bounds) {
      const target = bounds[0] + Math.round((bounds[1] - bounds[0]) * t);
      this.seekTo(target, keyframes, events, liveSnapshot, theme, locale, customDeskPositions);
    } else {
      this.seekTo(
        liveSnapshot.capturedAt,
        keyframes,
        events,
        liveSnapshot,
        theme,
        locale,
        customDeskPositions
      );
    }
  }

  togglePlay(
    keyframes: readonly Keyframe[],
    events: readonly WorldEventRecord[],
    liveSnapshot: WorldSnapshot,
    theme: ThemeConfig,
    locale?: UiLocale,
    customDeskPositions?: Readonly<Record<string, DeskCoordinate>>
  ): void {
    const bounds = this.timeBounds(keyframes, events);
    if (!this.isReplay) {
      const startMs = bounds ? bounds[0] : liveSnapshot.capturedAt;
      this.seekTo(startMs, keyframes, events, liveSnapshot, theme, locale, customDeskPositions);
      this.isPlaying = true;
      return;
    }
    if (!this.isPlaying && bounds && this.cursorMs >= bounds[1]) {
      this.seekTo(bounds[0], keyframes, events, liveSnapshot, theme, locale, customDeskPositions);
    }
    this.isPlaying = !this.isPlaying;
  }

  step(
    dtSecs: number,
    keyframes: readonly Keyframe[],
    events: readonly WorldEventRecord[],
    liveSnapshot: WorldSnapshot,
    theme: ThemeConfig,
    locale?: UiLocale,
    customDeskPositions?: Readonly<Record<string, DeskCoordinate>>
  ): void {
    if (locale) {
      this.motion.setLocale(locale);
    }
    if (!this.isReplay) return;
    if (!this.isPlaying) {
      this.motion.syncLayout(this.snapshot, theme, customDeskPositions);
      return;
    }
    const bounds = this.timeBounds(keyframes, events);
    if (!bounds) {
      this.isPlaying = false;
      return;
    }
    const [minTs, maxTs] = bounds;
    const scaledDt = Math.max(0, Math.min(0.25, dtSecs)) * this.speed;
    const advanceMs = Math.round(scaledDt * 1000);
    if (advanceMs <= 0) return;

    const prevCursor = Math.max(minTs, Math.min(maxTs, this.cursorMs));
    const nextCursor = Math.min(maxTs, prevCursor + advanceMs);
    this.cursorMs = nextCursor;

    this.snapshot = this.snapshotAt(keyframes, nextCursor) ?? { ...liveSnapshot, capturedAt: nextCursor };
    const crossed = events
      .filter((r) => r.timestampMs > prevCursor && r.timestampMs <= nextCursor)
      .sort((a, b) => a.timestampMs - b.timestampMs)
      .map((r) => r.event);
    if (crossed.length > 0) {
      this.motion.enqueueEvents(crossed, this.snapshot, theme, locale, customDeskPositions);
    }
    this.stepMotionSubsteps(scaledDt, theme, customDeskPositions);

    if (nextCursor >= maxTs) {
      this.isPlaying = false;
    }
  }

  advanceToTimestamp(
    targetMs: number,
    realDtSecs: number,
    keyframes: readonly Keyframe[],
    events: readonly WorldEventRecord[],
    liveSnapshot: WorldSnapshot,
    theme: ThemeConfig,
    locale?: UiLocale,
    customDeskPositions?: Readonly<Record<string, DeskCoordinate>>
  ): void {
    if (locale) {
      this.motion.setLocale(locale);
    }
    const bounds = this.timeBounds(keyframes, events);
    if (!bounds) {
      this.isReplay = true;
      this.cursorMs = liveSnapshot.capturedAt;
      this.snapshot = liveSnapshot;
      this.motion.syncLayout(this.snapshot, theme, customDeskPositions);
      return;
    }
    const [minTs, maxTs] = bounds;
    const clampedTarget = Math.max(minTs, Math.min(maxTs, targetMs));
    if (!this.isReplay) {
      this.seekTo(clampedTarget, keyframes, events, liveSnapshot, theme, locale, customDeskPositions);
      return;
    }

    const prevCursor = Math.max(minTs, Math.min(maxTs, this.cursorMs));
    const nextCursor = Math.max(prevCursor, clampedTarget);
    this.cursorMs = nextCursor;
    this.snapshot =
      this.snapshotAt(keyframes, nextCursor) ?? { ...liveSnapshot, capturedAt: nextCursor };

    const crossed = events
      .filter((r) => r.timestampMs > prevCursor && r.timestampMs <= nextCursor)
      .sort((a, b) => a.timestampMs - b.timestampMs)
      .map((r) => r.event);
    if (crossed.length > 0) {
      this.motion.enqueueEvents(crossed, this.snapshot, theme, locale, customDeskPositions);
    }
    const safeDt = Math.max(0, Math.min(0.25, realDtSecs));
    if (safeDt > 0) {
      this.motion.step(safeDt, this.snapshot, theme, customDeskPositions);
    } else {
      this.motion.syncLayout(this.snapshot, theme, customDeskPositions);
    }
  }

  returnToLive(): void {
    this.isReplay = false;
    this.isPlaying = false;
    this.motion.clearTransients();
  }

  progressFraction(keyframes: readonly Keyframe[], events: readonly WorldEventRecord[]): number {
    const bounds = this.timeBounds(keyframes, events);
    if (!bounds) return 1;
    const [minTs, maxTs] = bounds;
    if (maxTs <= minTs) return this.isReplay ? 0 : 1;
    if (!this.isReplay) return 1;
    return Math.max(0, Math.min(1, (this.cursorMs - minTs) / (maxTs - minTs)));
  }

  private stepMotionSubsteps(
    totalDt: number,
    theme: ThemeConfig,
    customDeskPositions?: Readonly<Record<string, DeskCoordinate>>
  ): void {
    let rem = Math.max(0, totalDt);
    while (rem > 0.0001) {
      const chunk = Math.min(0.2, rem);
      this.motion.step(chunk, this.snapshot, theme, customDeskPositions);
      rem -= chunk;
    }
  }
}
