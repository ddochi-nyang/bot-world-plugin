import { type WorldSnapshot, isSafeKey } from '../src/types.ts';
import type { Facing } from './motion.ts';

export const OWNER_MIN_X = 0.06;
export const OWNER_MAX_X = 0.94;
export const OWNER_MIN_Y = 0.14;
export const OWNER_MAX_Y = 0.9;
export const OWNER_PROXIMITY_RADIUS = 0.11;
export const OWNER_WALK_SPEED = 0.26;
export const OWNER_INTERACTION_COOLDOWN_MS = 3_000;

export type OwnerInteractionAction = 'high_five' | 'coffee';

export type OwnerMoveDir = 'up' | 'down' | 'left' | 'right';

export type OwnerRipple = {
  x: number;
  y: number;
  age: number;
  ttl: number;
};

export type NearbyBotMatch = {
  botId: string;
  distance: number;
};

export function clampOwnerCoord(nx: number, ny: number): [number, number] {
  const cx = Number.isFinite(nx) ? Math.max(OWNER_MIN_X, Math.min(OWNER_MAX_X, nx)) : 0.5;
  const cy = Number.isFinite(ny) ? Math.max(OWNER_MIN_Y, Math.min(OWNER_MAX_Y, ny)) : 0.3;
  return [cx, cy];
}

export function mapKeyToOwnerMoveDir(key: string): OwnerMoveDir | null {
  if (typeof key !== 'string') return null;
  switch (key.toLowerCase()) {
    case 'w':
    case 'arrowup':
      return 'up';
    case 's':
    case 'arrowdown':
      return 'down';
    case 'a':
    case 'arrowleft':
      return 'left';
    case 'd':
    case 'arrowright':
      return 'right';
    default:
      return null;
  }
}

export class OwnerAvatarController {
  roaming = false;
  x = 0.6;
  y = 0.28;
  facing: Facing = 'Right';
  walkPhase = 0;
  isMoving = false;
  targetX: number | null = null;
  targetY: number | null = null;
  ripple: OwnerRipple | null = null;

  private readonly heldDirs = new Set<OwnerMoveDir>();
  private readonly cooldowns = new Map<string, number>();

  anchorToBossDesk(bossDeskNorm: readonly [number, number]): void {
    const [cx, cy] = clampOwnerCoord(bossDeskNorm[0], bossDeskNorm[1]);
    this.x = cx;
    this.y = cy;
    this.targetX = null;
    this.targetY = null;
    this.isMoving = false;
    this.ripple = null;
  }

  setRoaming(enabled: boolean, bossDeskNorm?: readonly [number, number]): void {
    if (this.roaming === enabled) return;
    this.roaming = enabled;
    this.heldDirs.clear();
    this.targetX = null;
    this.targetY = null;
    this.isMoving = false;
    this.ripple = null;
    if (bossDeskNorm) {
      if (enabled) {
        // Step just in front of the Owner Desk so the avatar is immediately visible
        const [cx, cy] = clampOwnerCoord(bossDeskNorm[0], bossDeskNorm[1] + 0.04);
        this.x = cx;
        this.y = cy;
      } else {
        this.anchorToBossDesk(bossDeskNorm);
      }
    }
  }

  toggleRoaming(bossDeskNorm?: readonly [number, number]): boolean {
    this.setRoaming(!this.roaming, bossDeskNorm);
    return this.roaming;
  }

  clearKeys(): void {
    this.heldDirs.clear();
  }

  setMoveKey(key: string, pressed: boolean): boolean {
    const dir = mapKeyToOwnerMoveDir(key);
    if (!dir) return false;
    if (pressed) {
      this.heldDirs.add(dir);
      this.targetX = null;
      this.targetY = null;
    } else {
      this.heldDirs.delete(dir);
    }
    return true;
  }

  walkToNormalized(nx: number, ny: number): void {
    if (!this.roaming) return;
    const [cx, cy] = clampOwnerCoord(nx, ny);
    this.targetX = cx;
    this.targetY = cy;
    this.ripple = { x: cx, y: cy, age: 0, ttl: 0.75 };
  }

  step(dtSecs: number): boolean {
    const dt = Number.isFinite(dtSecs) ? Math.max(0, Math.min(0.25, dtSecs)) : 0;
    if (dt <= 0) return false;

    let changed = false;
    if (this.ripple) {
      this.ripple.age += dt;
      if (this.ripple.age >= this.ripple.ttl) {
        this.ripple = null;
      }
      changed = true;
    }

    if (!this.roaming) {
      this.isMoving = false;
      return changed;
    }

    let vx = 0;
    let vy = 0;
    if (this.heldDirs.has('left')) vx -= 1;
    if (this.heldDirs.has('right')) vx += 1;
    if (this.heldDirs.has('up')) vy -= 1;
    if (this.heldDirs.has('down')) vy += 1;

    if (vx !== 0 || vy !== 0) {
      const len = Math.hypot(vx, vy);
      const stepDist = OWNER_WALK_SPEED * dt;
      const dx = (vx / len) * stepDist;
      const dy = (vy / len) * stepDist;
      if (dx < -0.0001) this.facing = 'Left';
      else if (dx > 0.0001) this.facing = 'Right';
      const [nx, ny] = clampOwnerCoord(this.x + dx, this.y + dy);
      this.x = nx;
      this.y = ny;
      this.walkPhase += dt * 13;
      this.isMoving = true;
      return true;
    }

    if (this.targetX !== null && this.targetY !== null) {
      const dx = this.targetX - this.x;
      const dy = this.targetY - this.y;
      const dist = Math.hypot(dx, dy);
      const stepDist = OWNER_WALK_SPEED * dt;
      if (dist <= stepDist || dist < 0.002) {
        const [nx, ny] = clampOwnerCoord(this.targetX, this.targetY);
        this.x = nx;
        this.y = ny;
        this.targetX = null;
        this.targetY = null;
        this.isMoving = false;
      } else {
        if (dx < -0.0001) this.facing = 'Left';
        else if (dx > 0.0001) this.facing = 'Right';
        const [nx, ny] = clampOwnerCoord(
          this.x + (dx / dist) * stepDist,
          this.y + (dy / dist) * stepDist
        );
        this.x = nx;
        this.y = ny;
        this.walkPhase += dt * 13;
        this.isMoving = true;
      }
      return true;
    }

    if (this.isMoving) {
      this.isMoving = false;
      changed = true;
    }
    return changed;
  }

  findNearbyBot(
    snapshot: WorldSnapshot,
    botPositionsNorm: ReadonlyMap<string, readonly [number, number]>,
    radius: number = OWNER_PROXIMITY_RADIUS
  ): NearbyBotMatch | null {
    if (!this.roaming) return null;
    let best: NearbyBotMatch | null = null;
    for (const [botId, pos] of botPositionsNorm.entries()) {
      if (!isSafeKey(botId) || !Object.hasOwn(snapshot.bots, botId)) continue;
      const d = Math.hypot(pos[0] - this.x, pos[1] - this.y);
      if (d <= radius && (!best || d < best.distance || (d === best.distance && botId < best.botId))) {
        best = { botId, distance: d };
      }
    }
    return best;
  }

  cooldownRemainingMs(
    botId: string,
    action: OwnerInteractionAction,
    nowMs: number = Date.now(),
    cooldownMs: number = OWNER_INTERACTION_COOLDOWN_MS
  ): number {
    const key = `${botId}:${action}`;
    const last = this.cooldowns.get(key);
    if (last === undefined) return 0;
    return Math.max(0, cooldownMs - (nowMs - last));
  }

  canInteract(
    botId: string,
    action: OwnerInteractionAction,
    nowMs: number = Date.now(),
    cooldownMs: number = OWNER_INTERACTION_COOLDOWN_MS
  ): boolean {
    return this.cooldownRemainingMs(botId, action, nowMs, cooldownMs) === 0;
  }

  recordInteraction(
    botId: string,
    action: OwnerInteractionAction,
    nowMs: number = Date.now()
  ): void {
    const key = `${botId}:${action}`;
    if (this.cooldowns.size >= 512) {
      const oldest = this.cooldowns.keys().next().value;
      if (oldest !== undefined) this.cooldowns.delete(oldest);
    }
    this.cooldowns.set(key, nowMs);
  }
}
