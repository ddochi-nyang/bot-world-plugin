import { scrubAll } from '../src/redact.ts';
import {
  type AtmosphereMode,
  type AtmospherePhase,
  type BotActivityStatus,
  type BotRpgProfile,
  type BotState,
  type BroadcastChromaKey,
  type CharacterId,
  type PetToyKind,
  type ThemeId,
  type UiLocale,
  type WeatherKind,
  type WeatherMode,
  type WorldEvent,
  type WorldSnapshot,
  isSafeKey,
} from '../src/types.ts';
import {
  CHARACTER_SPECS,
  resolveCharacterIdWithPrefs,
  resolveCharacterSpritePath,
} from './assets-catalog.ts';
import { getBroadcastChromaColor } from './broadcast-bar.ts';
import { validateCustomAssetDataUrl } from './creator-studio.ts';
import { getBotRedactedAlias, orderedSnapshotBotIds } from './filter.ts';
import { tStrings } from './i18n.ts';
import { resolveAtmospherePhase } from './stage-renderer.ts';
import { WeatherSystem, resolveWeatherKind } from './weather.ts';

export const MAX_PET_TOYS = 8;
export const MAX_PET_PARTICLES = 36;
export const MAX_PET_RIPPLES = 8;
export const MAX_PET_DT_SECS = 0.25;
export const MAX_PETS = 48;
export const PET_NARROW_WIDTH_PX = 640;
export const PET_NARROW_TOOL_MAX_CHARS = 12;

export function formatPetToolLabel(tool: string, narrow: boolean): string {
  const clean = scrubAll(tool).trim();
  if (!clean) return '';
  if (narrow && clean.length > PET_NARROW_TOOL_MAX_CHARS) {
    return `${clean.slice(0, PET_NARROW_TOOL_MAX_CHARS - 1)}…`;
  }
  return clean;
}

type PlacedBadgeRect = {
  left: number;
  right: number;
  cy: number;
  halfH: number;
};

export type NameplateItemInput = {
  botId: string;
  label: string;
  anchorCx: number;
  pillW: number;
  baseY: number;
  statusDotColor: string;
  selected: boolean;
  dimmed: boolean;
};

export type NameplateBox = NameplateItemInput & {
  left: number;
  right: number;
  top: number;
  bottom: number;
  tier: number;
};

const RPG_LEVEL_SUFFIX_RE = /^(.*?)( · Lv\.\d+)$/;

export function truncateCanvasLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidthPx: number
): string {
  if (!text || maxWidthPx <= 0) return '';
  if (ctx.measureText(text).width <= maxWidthPx) return text;

  const lvMatch = RPG_LEVEL_SUFFIX_RE.exec(text);
  if (lvMatch) {
    const prefix = lvMatch[1] ?? '';
    const suffix = lvMatch[2] ?? '';
    const minNeeded = ctx.measureText(`…${suffix}`).width;
    if (minNeeded < maxWidthPx - 8 && prefix.length > 1) {
      let lo = 1;
      let hi = prefix.length;
      let best = '';
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const cand = `${prefix.slice(0, mid).trimEnd()}…${suffix}`;
        if (ctx.measureText(cand).width <= maxWidthPx) {
          best = cand;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (best) return best;
    }
  }

  let lo = 1;
  let hi = text.length;
  let best = `${text.slice(0, 1)}…`;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cand = `${text.slice(0, mid).trimEnd()}…`;
    if (ctx.measureText(cand).width <= maxWidthPx) {
      best = cand;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export function resolveNameplateBoxes(
  items: readonly NameplateItemInput[],
  options: {
    canvasWidth: number;
    canvasHeight: number;
    railBaseY: number;
    pillH: number;
    tierStepY: number;
    minGapX?: number;
    maxNudgeX?: number;
    marginX?: number;
    maxTiers?: number;
  }
): NameplateBox[] {
  if (items.length === 0) return [];
  const marginX = options.marginX ?? 6;
  const minGapX = options.minGapX ?? 6;
  const maxNudgeX = options.maxNudgeX ?? 34;
  const maxTiers = Math.max(2, options.maxTiers ?? 3);

  const sorted = [...items].sort((a, b) => a.anchorCx - b.anchorCx || a.botId.localeCompare(b.botId));
  const tierBoxes: Array<Array<{ left: number; right: number }>> = [];
  const placed: NameplateBox[] = [];

  const collidesInTier = (tier: number, left: number, right: number): boolean => {
    const list = tierBoxes[tier];
    if (!list) return false;
    return list.some((b) => !(right + minGapX <= b.left || left - minGapX >= b.right));
  };

  const findNudgedX = (
    tier: number,
    idealLeft: number,
    pillW: number,
    maxAllowedNudge: number
  ): number | null => {
    const minLeft = marginX;
    const maxLeft = Math.max(marginX, options.canvasWidth - marginX - pillW);
    const list = tierBoxes[tier] ?? [];
    const candidates: number[] = [idealLeft];
    for (const b of list) {
      candidates.push(b.right + minGapX);
      candidates.push(b.left - minGapX - pillW);
    }
    let bestLeft: number | null = null;
    let bestDist = Infinity;
    for (const rawCand of candidates) {
      const cand = Math.max(minLeft, Math.min(maxLeft, rawCand));
      const dist = Math.abs(cand - idealLeft);
      if (dist > maxAllowedNudge) continue;
      if (!collidesInTier(tier, cand, cand + pillW) && dist < bestDist) {
        bestDist = dist;
        bestLeft = cand;
      }
    }
    return bestLeft;
  };

  for (const item of sorted) {
    const minLeft = marginX;
    const maxLeft = Math.max(marginX, options.canvasWidth - marginX - item.pillW);
    const idealLeft = Math.max(minLeft, Math.min(maxLeft, item.anchorCx - item.pillW * 0.5));

    let chosenTier = -1;
    let chosenLeft = idealLeft;

    // 1. Prefer centered placement (0 nudge) across primary tiers 0 and 1
    for (let t = 0; t < Math.min(2, maxTiers); t++) {
      if (!collidesInTier(t, idealLeft, idealLeft + item.pillW)) {
        chosenTier = t;
        chosenLeft = idealLeft;
        break;
      }
    }

    // 2. Otherwise try modest horizontal nudging within maxNudgeX across tiers 0..maxTiers-1
    if (chosenTier === -1) {
      for (let t = 0; t < maxTiers; t++) {
        const nudged = findNudgedX(t, idealLeft, item.pillW, maxNudgeX);
        if (nudged !== null) {
          chosenTier = t;
          chosenLeft = nudged;
          break;
        }
      }
    }

    // 3. Guaranteed fallback if severely crowded: expand search to full canvas width or extra tier
    if (chosenTier === -1) {
      for (let t = 0; t < maxTiers + 6; t++) {
        const nudged = findNudgedX(t, idealLeft, item.pillW, options.canvasWidth);
        if (nudged !== null) {
          chosenTier = t;
          chosenLeft = nudged;
          break;
        }
      }
    }

    if (chosenTier === -1) {
      chosenTier = maxTiers;
    }

    const right = chosenLeft + item.pillW;
    if (!tierBoxes[chosenTier]) tierBoxes[chosenTier] = [];
    tierBoxes[chosenTier].push({ left: chosenLeft, right });

    placed.push({
      ...item,
      left: chosenLeft,
      right,
      top: 0,
      bottom: 0,
      tier: chosenTier,
    });
  }

  const maxTierUsed = placed.reduce((acc, box) => Math.max(acc, box.tier), 0);
  const totalStackH = maxTierUsed * options.tierStepY + options.pillH;
  const maxStartY = Math.max(4, options.canvasHeight - 4 - totalStackH);
  const railStartY = Math.max(4, Math.min(options.railBaseY, maxStartY));

  for (const box of placed) {
    const top = Math.round(railStartY + box.tier * options.tierStepY);
    box.top = top;
    box.bottom = top + options.pillH;
  }

  return placed.sort((a, b) => Number(a.selected) - Number(b.selected));
}

const CANVAS_FONT_FAMILY =
  '"Pretendard", "Apple SD Gothic Neo", "Inter", system-ui, sans-serif';

export type PetAiState =
  | 'wandering'
  | 'sitting'
  | 'napping'
  | 'typing'
  | 'knocking'
  | 'flustered'
  | 'thinking'
  | 'chasing_toy'
  | 'drinking_coffee'
  | 'celebrating';

export type PetEntity = {
  botId: string;
  name: string;
  redactedAlias: string;
  characterId: CharacterId;
  status: BotActivityStatus;
  x: number;
  yOffset: number;
  vy: number;
  depthOffset: number;
  vx: number;
  facing: 'left' | 'right';
  aiState: PetAiState;
  stateTimer: number;
  walkPhase: number;
  knockPhase: number;
  knockCooldown: number;
  particleTimer: number;
  reactionText: string | null;
  reactionTtl: number;
  reactionMaxTtl: number;
  celebrateTtl: number;
  targetToyId: number | null;
  sipTimer: number;
};

export type PetToy = {
  id: number;
  kind: PetToyKind;
  x: number;
  yOffset: number;
  vx: number;
  vy: number;
  ttl: number;
  maxTtl: number;
  consumed: boolean;
};

export type PetParticleKind =
  | 'heart'
  | 'sparkle'
  | 'sweat'
  | 'smoke'
  | 'zzz'
  | 'steam'
  | 'letter';

export type PetParticle = {
  kind: PetParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  gravity: number;
  age: number;
  ttl: number;
  color: string;
  size: number;
};

export type PetKnockRipple = {
  x: number;
  y: number;
  age: number;
  ttl: number;
};

export class PocketPetEngine {
  width: number;
  height: number;
  pets: PetEntity[] = [];
  toys: PetToy[] = [];
  particles: PetParticle[] = [];
  ripples: PetKnockRipple[] = [];
  elapsedSecs = 0;

  private nextToyId = 1;
  private headpatIndex = 0;
  private rngSeed = 0x243f6a88;

  constructor(width = 640, height = 280) {
    this.width = Math.max(260, Math.round(width));
    this.height = Math.max(160, Math.round(height));
  }

  private nextRand(): number {
    this.rngSeed = (this.rngSeed * 1664525 + 1013904223) >>> 0;
    return this.rngSeed / 0x100000000;
  }

  floorY(): number {
    return this.height - 42;
  }

  private marginX(): number {
    return Math.min(44, Math.max(26, Math.round(this.width * 0.06)));
  }

  setBounds(width: number, height: number): void {
    const nextW = Math.max(260, Math.round(Number.isFinite(width) ? width : 640));
    const nextH = Math.max(160, Math.round(Number.isFinite(height) ? height : 280));
    if (nextW === this.width && nextH === this.height) return;
    const scaleX = this.width > 0 ? nextW / this.width : 1;
    this.width = nextW;
    this.height = nextH;
    const minX = this.marginX();
    const maxX = Math.max(minX, this.width - minX);
    for (const pet of this.pets) {
      pet.x = Math.max(minX, Math.min(maxX, pet.x * scaleX));
    }
    for (const toy of this.toys) {
      toy.x = Math.max(minX, Math.min(maxX, toy.x * scaleX));
    }
  }

  syncSnapshot(
    snapshot: WorldSnapshot,
    options: {
      botAppearances: Record<string, CharacterId>;
      redactMode: boolean;
      locale: UiLocale;
    }
  ): void {
    const orderedIds = orderedSnapshotBotIds(snapshot).slice(0, MAX_PETS);
    const existingMap = new Map<string, PetEntity>();
    for (const p of this.pets) {
      existingMap.set(p.botId, p);
    }

    const minX = this.marginX();
    const maxX = Math.max(minX + 1, this.width - minX);
    const span = maxX - minX;
    const count = Math.max(1, orderedIds.length);
    const nextPets: PetEntity[] = [];

    orderedIds.forEach((botId, idx) => {
      if (!isSafeKey(botId)) return;
      const bot: BotState | undefined = snapshot.bots[botId];
      if (!bot) return;

      const charId = resolveCharacterIdWithPrefs(options.botAppearances, bot.id, bot.name);
      const alias = getBotRedactedAlias(bot.id, snapshot, options.locale);
      const cleanName = scrubAll(bot.name);
      const prev = existingMap.get(botId);

      if (prev) {
        prev.name = cleanName;
        prev.redactedAlias = alias;
        prev.characterId = charId;
        prev.status = bot.status;
        prev.x = Math.max(minX, Math.min(maxX, prev.x));
        this.applyStatusToAiState(prev, false);
        nextPets.push(prev);
      } else {
        const spawnX =
          count === 1
            ? minX + span * 0.5
            : minX + (span * (idx + 0.5)) / count;
        const entity: PetEntity = {
          botId: bot.id,
          name: cleanName,
          redactedAlias: alias,
          characterId: charId,
          status: bot.status,
          x: Math.max(minX, Math.min(maxX, spawnX)),
          yOffset: 0,
          vy: 0,
          depthOffset: bot.status.kind === 'NeedsOwner' ? 0.9 : 0.15 + (idx % 3) * 0.15,
          vx: (idx % 2 === 0 ? 1 : -1) * (24 + (idx % 4) * 5),
          facing: idx % 2 === 0 ? 'right' : 'left',
          aiState: 'wandering',
          stateTimer: 1.5 + (idx % 5) * 0.8,
          walkPhase: idx * 0.7,
          knockPhase: idx * 0.5,
          knockCooldown: 0.3,
          particleTimer: 0.4 + (idx % 3) * 0.25,
          reactionText: null,
          reactionTtl: 0,
          reactionMaxTtl: 1,
          celebrateTtl: 0,
          targetToyId: null,
          sipTimer: 0,
        };
        this.applyStatusToAiState(entity, true);
        nextPets.push(entity);
      }
    });

    this.pets = nextPets;
  }

  private applyStatusToAiState(pet: PetEntity, initial: boolean): void {
    if (pet.celebrateTtl > 0) {
      pet.aiState = 'celebrating';
      return;
    }
    switch (pet.status.kind) {
      case 'NeedsOwner':
        pet.aiState = 'knocking';
        pet.targetToyId = null;
        break;
      case 'Working':
        pet.aiState = 'typing';
        pet.targetToyId = null;
        break;
      case 'Error':
        pet.aiState = 'flustered';
        pet.targetToyId = null;
        break;
      case 'WaitingAnswer':
      case 'Blocked':
        pet.aiState = 'thinking';
        pet.targetToyId = null;
        break;
      case 'Paused':
        pet.aiState = 'napping';
        pet.targetToyId = null;
        break;
      case 'Idle':
        if (
          initial ||
          (pet.aiState !== 'wandering' &&
            pet.aiState !== 'sitting' &&
            pet.aiState !== 'napping' &&
            pet.aiState !== 'chasing_toy' &&
            pet.aiState !== 'drinking_coffee')
        ) {
          pet.aiState = 'wandering';
          pet.stateTimer = 2.5 + this.nextRand() * 2.5;
        }
        break;
    }
  }

  onEvents(events: readonly WorldEvent[], locale: UiLocale): void {
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      if (ev.kind === 'ItemDone' && ev.botId) {
        this.triggerCelebration(ev.botId, locale);
      } else if (ev.kind === 'WorkerDone' && ev.parentBotId) {
        this.triggerCelebration(ev.parentBotId, locale);
      } else if (ev.kind === 'AutomationRun' && ev.success && ev.botId) {
        this.triggerCelebration(ev.botId, locale);
      }
    }
  }

  triggerCelebration(botId: string, locale: UiLocale = 'en'): boolean {
    const pet = this.pets.find((p) => p.botId === botId);
    if (!pet) return false;
    const s = tStrings(locale);
    pet.celebrateTtl = 2.2;
    pet.aiState = 'celebrating';
    pet.vy = -170;
    this.setReaction(pet, s.petReactionDone, 2.2);
    this.spawnBurst('heart', pet.x, this.floorY() - 36, 4);
    this.spawnBurst('sparkle', pet.x, this.floorY() - 32, 4);
    return true;
  }

  interactWithPet(botId: string, locale: UiLocale = 'en'): boolean {
    const pet = this.pets.find((p) => p.botId === botId);
    if (!pet) return false;
    const s = tStrings(locale);
    const phrases = s.petReactionsHeadpat;
    const phrase = phrases[this.headpatIndex % phrases.length] ?? 'Thanks!';
    this.headpatIndex += 1;

    pet.vy = -155;
    if (pet.yOffset > -1) pet.yOffset = -1;
    this.setReaction(pet, phrase, 2.1);
    this.spawnBurst('heart', pet.x, this.floorY() - 38 + pet.yOffset, 5);
    return true;
  }

  dropQuickMessageLetter(botId: string, locale: UiLocale = 'en'): boolean {
    const pet = this.pets.find((p) => p.botId === botId);
    if (!pet) return false;
    const s = tStrings(locale);
    pet.vy = -135;
    this.setReaction(pet, s.petReactionQuickMsg, 2.2);
    this.spawnParticle({
      kind: 'letter',
      x: pet.x,
      y: Math.max(24, this.floorY() - 96),
      vx: 0,
      vy: 42,
      gravity: 16,
      age: 0,
      ttl: 1.0,
      color: '#fde047',
      size: 11,
    });
    this.spawnBurst('sparkle', pet.x, this.floorY() - 40, 5);
    return true;
  }

  dropToy(kind: PetToyKind, targetX?: number): PetToy {
    while (this.toys.length >= MAX_PET_TOYS) {
      this.toys.shift();
    }
    const minX = this.marginX() + 14;
    const maxX = Math.max(minX + 1, this.width - minX);
    const x =
      typeof targetX === 'number' && Number.isFinite(targetX)
        ? Math.max(minX, Math.min(maxX, targetX))
        : minX + this.nextRand() * (maxX - minX);

    const toy: PetToy = {
      id: this.nextToyId++,
      kind,
      x,
      yOffset: kind === 'ball' ? -92 : -64,
      vx: kind === 'ball' ? (this.nextRand() > 0.5 ? 1 : -1) * (85 + this.nextRand() * 55) : 0,
      vy: kind === 'ball' ? -40 : 0,
      ttl: kind === 'ball' ? 14 : kind === 'coffee' ? 14 : 12,
      maxTtl: kind === 'ball' ? 14 : kind === 'coffee' ? 14 : 12,
      consumed: false,
    };
    this.toys.push(toy);
    this.spawnBurst('sparkle', x, this.floorY() - 36, 3);
    return toy;
  }

  private setReaction(pet: PetEntity, text: string, ttl: number): void {
    pet.reactionText = text;
    pet.reactionTtl = ttl;
    pet.reactionMaxTtl = Math.max(0.2, ttl);
  }

  private spawnParticle(p: PetParticle): void {
    while (this.particles.length >= MAX_PET_PARTICLES) {
      this.particles.shift();
    }
    this.particles.push(p);
  }

  private spawnBurst(
    kind: 'heart' | 'sparkle' | 'sweat' | 'smoke',
    x: number,
    y: number,
    count: number
  ): void {
    for (let i = 0; i < count; i++) {
      const r1 = this.nextRand();
      const r2 = this.nextRand();
      if (kind === 'heart') {
        this.spawnParticle({
          kind: 'heart',
          x: x + (r1 - 0.5) * 26,
          y: y + (r2 - 0.5) * 10,
          vx: (r1 - 0.5) * 28,
          vy: -36 - r2 * 24,
          gravity: -6,
          age: 0,
          ttl: 1.05 + r2 * 0.35,
          color: i % 2 === 0 ? '#f472b6' : '#fb7185',
          size: 7 + r1 * 3,
        });
      } else if (kind === 'sparkle') {
        this.spawnParticle({
          kind: 'sparkle',
          x: x + (r1 - 0.5) * 28,
          y: y + (r2 - 0.5) * 16,
          vx: (r1 - 0.5) * 42,
          vy: -24 - r2 * 26,
          gravity: 12,
          age: 0,
          ttl: 0.75 + r1 * 0.3,
          color: i % 2 === 0 ? '#fde047' : '#7dd3fc',
          size: 5 + r2 * 2.5,
        });
      } else if (kind === 'sweat') {
        this.spawnParticle({
          kind: 'sweat',
          x: x + (r1 - 0.5) * 18,
          y: y - 10,
          vx: (r1 - 0.5) * 34,
          vy: -30 - r2 * 18,
          gravity: 110,
          age: 0,
          ttl: 0.75,
          color: '#38bdf8',
          size: 4.5,
        });
      } else {
        this.spawnParticle({
          kind: 'smoke',
          x: x + (r1 - 0.5) * 14,
          y: y - 8,
          vx: (r1 - 0.5) * 14,
          vy: -24 - r2 * 14,
          gravity: -4,
          age: 0,
          ttl: 0.9,
          color: '#e2e8f0',
          size: 5.5 + r2 * 3,
        });
      }
    }
  }

  private spawnKnockRipple(x: number, y: number): void {
    while (this.ripples.length >= MAX_PET_RIPPLES) {
      this.ripples.shift();
    }
    this.ripples.push({ x, y, age: 0, ttl: 0.85 });
  }

  step(dtSecs: number, options?: { locale?: UiLocale }): void {
    const dt = Math.max(0, Math.min(MAX_PET_DT_SECS, Number.isFinite(dtSecs) ? dtSecs : 0));
    if (dt <= 0) return;

    const locale = options?.locale ?? 'en';
    const s = tStrings(locale);
    this.elapsedSecs += dt;

    const minX = this.marginX();
    const maxX = Math.max(minX + 1, this.width - minX);
    const floor = this.floorY();

    // Step toys with gravity & wall bounce
    const survivingToys: PetToy[] = [];
    for (const toy of this.toys) {
      toy.ttl -= dt;
      if (toy.ttl <= 0 || toy.consumed) continue;

      if (toy.yOffset < 0 || toy.vy !== 0) {
        toy.vy += 420 * dt;
        toy.yOffset += toy.vy * dt;
        if (toy.yOffset >= 0) {
          toy.yOffset = 0;
          if (toy.kind === 'ball' && Math.abs(toy.vy) > 45) {
            toy.vy = -toy.vy * 0.68;
          } else {
            toy.vy = 0;
          }
        }
      }
      if (toy.kind === 'ball') {
        toy.x += toy.vx * dt;
        if (toy.x <= minX) {
          toy.x = minX;
          toy.vx = Math.abs(toy.vx) * 0.86;
        } else if (toy.x >= maxX) {
          toy.x = maxX;
          toy.vx = -Math.abs(toy.vx) * 0.86;
        }
        if (toy.yOffset === 0) {
          toy.vx *= Math.max(0, 1 - dt * 1.15);
          if (Math.abs(toy.vx) < 4) toy.vx = 0;
        }
      } else if (toy.kind === 'coffee' && toy.yOffset === 0 && this.nextRand() < dt * 2.2) {
        this.spawnParticle({
          kind: 'steam',
          x: toy.x + (this.nextRand() - 0.5) * 6,
          y: floor - 14,
          vx: (this.nextRand() - 0.5) * 8,
          vy: -22,
          gravity: -3,
          age: 0,
          ttl: 0.85,
          color: '#fef3c7',
          size: 3.2,
        });
      }
      survivingToys.push(toy);
    }
    this.toys = survivingToys;

    // Assign idle pets to nearest unconsumed toy
    const claimedToyIds = new Set<number>();
    for (const pet of this.pets) {
      if (pet.targetToyId !== null) {
        const stillExists = this.toys.some((t) => t.id === pet.targetToyId && !t.consumed);
        if (!stillExists) {
          pet.targetToyId = null;
          if (pet.aiState === 'chasing_toy') pet.aiState = 'wandering';
        } else {
          claimedToyIds.add(pet.targetToyId);
        }
      }
    }

    for (const toy of this.toys) {
      if (toy.consumed || claimedToyIds.has(toy.id)) continue;
      let bestPet: PetEntity | null = null;
      let bestDist = Infinity;
      for (const pet of this.pets) {
        if (pet.status.kind !== 'Idle' || pet.celebrateTtl > 0) continue;
        if (pet.aiState === 'drinking_coffee' || pet.targetToyId !== null) continue;
        const dist = Math.abs(pet.x - toy.x);
        if (dist < bestDist) {
          bestDist = dist;
          bestPet = pet;
        }
      }
      if (bestPet) {
        bestPet.targetToyId = toy.id;
        bestPet.aiState = 'chasing_toy';
        claimedToyIds.add(toy.id);
      }
    }

    // Step pets
    for (const pet of this.pets) {
      if (pet.reactionTtl > 0) {
        pet.reactionTtl = Math.max(0, pet.reactionTtl - dt);
        if (pet.reactionTtl === 0) pet.reactionText = null;
      }
      if (pet.celebrateTtl > 0) {
        pet.celebrateTtl = Math.max(0, pet.celebrateTtl - dt);
        if (pet.celebrateTtl === 0) {
          this.applyStatusToAiState(pet, false);
        }
      }

      // Vertical jump physics
      if (pet.yOffset < 0 || pet.vy < 0) {
        pet.vy += 460 * dt;
        pet.yOffset += pet.vy * dt;
        if (pet.yOffset >= 0) {
          pet.yOffset = 0;
          pet.vy = 0;
        }
      }

      if (pet.aiState === 'knocking') {
        // Rush to front glass edge (depthOffset -> 1) and knock!
        pet.depthOffset = Math.min(1, pet.depthOffset + dt * 1.8);
        pet.knockPhase += dt * 7.5;
        pet.knockCooldown -= dt;
        if (pet.yOffset === 0 && pet.knockCooldown <= 0) {
          pet.vy = -105;
          pet.knockCooldown = 1.15;
          this.spawnKnockRipple(pet.x, floor - 18);
        }
        continue;
      }

      // Relax depthOffset back to cozy shelf depth
      pet.depthOffset += (0.25 - pet.depthOffset) * Math.min(1, dt * 3);

      if (pet.aiState === 'celebrating') {
        if (pet.yOffset === 0 && pet.celebrateTtl > 0.35) {
          pet.vy = -125;
        }
        continue;
      }

      if (pet.aiState === 'typing') {
        pet.walkPhase += dt * 8;
        pet.particleTimer -= dt;
        if (pet.particleTimer <= 0) {
          pet.particleTimer = 1.6 + this.nextRand() * 1.4;
          this.spawnBurst('sparkle', pet.x + (pet.facing === 'right' ? 14 : -14), floor - 28, 1);
        }
        continue;
      }

      if (pet.aiState === 'flustered') {
        pet.walkPhase += dt * 15;
        pet.particleTimer -= dt;
        if (pet.particleTimer <= 0) {
          pet.particleTimer = 0.85 + this.nextRand() * 0.5;
          this.spawnBurst(this.nextRand() > 0.45 ? 'sweat' : 'smoke', pet.x, floor - 32, 1);
        }
        continue;
      }

      if (pet.aiState === 'thinking') {
        pet.stateTimer -= dt;
        if (pet.stateTimer <= 0) {
          pet.facing = pet.facing === 'left' ? 'right' : 'left';
          pet.stateTimer = 1.8 + this.nextRand() * 1.4;
        }
        continue;
      }

      if (pet.aiState === 'drinking_coffee') {
        pet.sipTimer -= dt;
        pet.particleTimer -= dt;
        if (pet.particleTimer <= 0) {
          pet.particleTimer = 0.7;
          this.spawnBurst('sparkle', pet.x, floor - 32, 1);
        }
        if (pet.sipTimer <= 0) {
          pet.aiState = 'wandering';
          pet.stateTimer = 2.5 + this.nextRand() * 2;
        }
        continue;
      }

      if (pet.aiState === 'chasing_toy' && pet.targetToyId !== null) {
        const toy = this.toys.find((t) => t.id === pet.targetToyId && !t.consumed);
        if (!toy) {
          pet.targetToyId = null;
          pet.aiState = 'wandering';
          continue;
        }
        const dx = toy.x - pet.x;
        if (Math.abs(dx) > 16) {
          const dir = dx > 0 ? 1 : -1;
          pet.facing = dir > 0 ? 'right' : 'left';
          pet.x = Math.max(minX, Math.min(maxX, pet.x + dir * 68 * dt));
          pet.walkPhase += dt * 10;
        } else {
          if (toy.kind === 'ball') {
            const kickDir = pet.facing === 'right' ? 1 : -1;
            toy.vx = kickDir * (130 + this.nextRand() * 45);
            toy.vy = -155;
            toy.yOffset = -2;
            pet.vy = -90;
            this.setReaction(pet, s.petReactionBall, 1.5);
            this.spawnBurst('sparkle', toy.x, floor - 14, 3);
          } else if (toy.kind === 'treat') {
            toy.consumed = true;
            pet.targetToyId = null;
            pet.aiState = 'sitting';
            pet.stateTimer = 1.6;
            pet.vy = -125;
            this.setReaction(pet, s.petReactionTreat, 2.0);
            this.spawnBurst('heart', pet.x, floor - 34, 4);
          } else {
            toy.consumed = true;
            pet.targetToyId = null;
            pet.aiState = 'drinking_coffee';
            pet.sipTimer = 2.4;
            this.setReaction(pet, s.petReactionCoffee, 2.2);
            this.spawnBurst('sparkle', pet.x, floor - 30, 3);
          }
        }
        continue;
      }

      if (pet.aiState === 'napping' || pet.aiState === 'sitting') {
        pet.stateTimer -= dt;
        if (pet.aiState === 'napping') {
          pet.particleTimer -= dt;
          if (pet.particleTimer <= 0) {
            pet.particleTimer = 1.2;
            this.spawnParticle({
              kind: 'zzz',
              x: pet.x + 14,
              y: floor - 38,
              vx: 7,
              vy: -18,
              gravity: 0,
              age: 0,
              ttl: 1.35,
              color: '#bae6fd',
              size: 10,
            });
          }
        }
        if (pet.status.kind === 'Idle' && pet.stateTimer <= 0) {
          pet.aiState = 'wandering';
          pet.stateTimer = 2.5 + this.nextRand() * 3.5;
          pet.vx = (this.nextRand() > 0.5 ? 1 : -1) * (22 + this.nextRand() * 14);
          pet.facing = pet.vx >= 0 ? 'right' : 'left';
        }
        continue;
      }

      // Wandering across the terrarium floor
      pet.stateTimer -= dt;
      pet.x += pet.vx * dt;
      pet.walkPhase += dt * 7.5;
      if (pet.x <= minX) {
        pet.x = minX;
        pet.vx = Math.abs(pet.vx) || 26;
        pet.facing = 'right';
      } else if (pet.x >= maxX) {
        pet.x = maxX;
        pet.vx = -(Math.abs(pet.vx) || 26);
        pet.facing = 'left';
      }
      if (pet.stateTimer <= 0) {
        const roll = this.nextRand();
        if (roll < 0.35) {
          pet.aiState = 'sitting';
          pet.stateTimer = 1.8 + this.nextRand() * 2.2;
        } else if (roll < 0.55) {
          pet.aiState = 'napping';
          pet.stateTimer = 2.6 + this.nextRand() * 2.5;
        } else {
          pet.vx = (this.nextRand() > 0.5 ? 1 : -1) * (22 + this.nextRand() * 16);
          pet.facing = pet.vx >= 0 ? 'right' : 'left';
          pet.stateTimer = 2.4 + this.nextRand() * 3.0;
        }
      }
    }

    // Step particles
    const nextParticles: PetParticle[] = [];
    for (const p of this.particles) {
      p.age += dt;
      if (p.age >= p.ttl) continue;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      nextParticles.push(p);
    }
    this.particles = nextParticles;

    // Step knock ripples
    const nextRipples: PetKnockRipple[] = [];
    for (const r of this.ripples) {
      r.age += dt;
      if (r.age < r.ttl) nextRipples.push(r);
    }
    this.ripples = nextRipples;
  }

  findPetAt(x: number, y: number, spriteSize = 54): string | null {
    const floor = this.floorY();
    for (let i = this.pets.length - 1; i >= 0; i--) {
      const p = this.pets[i];
      const py = floor + p.yOffset + p.depthOffset * 8;
      const left = p.x - spriteSize * 0.55;
      const right = p.x + spriteSize * 0.55;
      const top = py - spriteSize * 1.1;
      const bottom = py + 10;
      if (x >= left && x <= right && y >= top && y <= bottom) {
        return p.botId;
      }
    }
    return null;
  }
}

export type PetRenderInput = {
  snapshot: WorldSnapshot;
  themeId: ThemeId;
  atmosphereMode?: AtmosphereMode;
  weatherMode?: WeatherMode;
  displayTimestampMs?: number;
  selectedBotId: string | null;
  redactMode: boolean;
  botAppearances: Record<string, CharacterId>;
  locale: UiLocale;
  filterMatchedBotIds?: ReadonlySet<string> | null;
  customAvatars?: Readonly<Record<string, string>>;
  rpgProfiles?: Readonly<Record<string, BotRpgProfile>>;
  broadcastMode?: boolean;
  broadcastChromaKey?: BroadcastChromaKey;
};

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

export const PET_THROTTLE_ACTIVE_MS = 0;
export const PET_THROTTLE_IDLE_MS = 33;
export const PET_THROTTLE_RESTING_MS = 80;

export function resolvePetThrottleIntervalMs(
  engine: Pick<PocketPetEngine, 'pets' | 'toys' | 'particles' | 'ripples'>,
  weatherKind: WeatherKind
): number {
  if (
    engine.toys.length > 0 ||
    engine.ripples.length > 0 ||
    engine.particles.some((p) => p.kind !== 'zzz')
  ) {
    return PET_THROTTLE_ACTIVE_MS;
  }
  for (const pet of engine.pets) {
    if (
      pet.status.kind === 'NeedsOwner' ||
      pet.aiState === 'knocking' ||
      pet.aiState === 'chasing_toy' ||
      pet.aiState === 'celebrating' ||
      pet.aiState === 'drinking_coffee' ||
      pet.celebrateTtl > 0 ||
      pet.reactionTtl > 0 ||
      pet.yOffset < 0 ||
      pet.vy !== 0
    ) {
      return PET_THROTTLE_ACTIVE_MS;
    }
  }
  if (weatherKind !== 'clear') {
    return PET_THROTTLE_IDLE_MS;
  }
  for (const pet of engine.pets) {
    if (
      pet.aiState === 'wandering' ||
      pet.aiState === 'typing' ||
      pet.aiState === 'flustered' ||
      pet.aiState === 'thinking' ||
      pet.status.kind === 'Working' ||
      pet.status.kind === 'Error' ||
      pet.status.kind === 'Blocked' ||
      pet.status.kind === 'WaitingAnswer'
    ) {
      return PET_THROTTLE_IDLE_MS;
    }
  }
  return PET_THROTTLE_RESTING_MS;
}

export class PetTerrariumRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly imageCache = new Map<string, HTMLImageElement>();
  private readonly onSelectAndPet: (botId: string) => void;
  private readonly onHoverBot?: (botId: string | null) => void;
  readonly engine = new PocketPetEngine();
  readonly weather = new WeatherSystem();

  private lastInput: PetRenderInput | null = null;
  private active = false;
  private pageVisible = typeof document !== 'undefined' ? !document.hidden : true;
  private rafId: number | null = null;
  private lastRenderMs = 0;
  private resizeObserver: ResizeObserver | null = null;
  private hasWindowResizeListener = false;
  private destroyed = false;
  private dpr = 1;
  private logicalW = 640;
  private logicalH = 280;
  private cssW = 640;
  private cssH = 280;
  private scale = 1;

  constructor(
    canvas: HTMLCanvasElement,
    options: {
      onSelectAndPet: (botId: string) => void;
      onHoverBot?: (botId: string | null) => void;
    }
  ) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('2D canvas context unavailable');
    }
    this.ctx = ctx;
    this.onSelectAndPet = options.onSelectAndPet;
    this.onHoverBot = options.onHoverBot;

    this.canvas.addEventListener('click', this.handleClick);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerleave', this.handlePointerLeave);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver((entries) => {
        const cr = entries[0]?.contentRect;
        this.resizeCanvas(cr ? { width: cr.width, height: cr.height } : undefined);
        if (this.active && this.pageVisible) this.renderNow();
      });
      this.resizeObserver.observe(this.canvas);
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('resize', this.handleWindowResize);
      this.hasWindowResizeListener = true;
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
    this.resizeCanvas();
  }

  private readonly handleWindowResize = (): void => {
    this.resizeCanvas();
    if (this.active && this.pageVisible) this.renderNow();
  };

  private readonly handleVisibilityChange = (): void => {
    if (typeof document !== 'undefined') {
      this.setPageVisible(!document.hidden);
    }
  };

  setPageVisible(visible: boolean): void {
    if (this.pageVisible === visible) return;
    this.pageVisible = visible;
    if (!visible) {
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      return;
    }
    if (this.active && !this.destroyed && this.lastInput) {
      this.lastRenderMs = 0;
      this.resizeCanvas();
      this.renderNow();
      this.ensureLoop();
    }
  }

  isPageVisible(): boolean {
    return this.pageVisible;
  }

  getTargetFrameIntervalMs(): number {
    if (!this.lastInput) return PET_THROTTLE_RESTING_MS;
    const displayTs =
      typeof this.lastInput.displayTimestampMs === 'number' &&
      Number.isFinite(this.lastInput.displayTimestampMs)
        ? this.lastInput.displayTimestampMs
        : this.lastInput.snapshot.capturedAt > 0
          ? this.lastInput.snapshot.capturedAt
          : Date.now();
    const phase = resolveAtmospherePhase(this.lastInput.atmosphereMode ?? 'auto', displayTs);
    const weatherKind = resolveWeatherKind(
      this.lastInput.weatherMode ?? 'auto',
      phase,
      this.lastInput.themeId
    );
    return resolvePetThrottleIntervalMs(this.engine, weatherKind);
  }

  private loadImage(safePath: string): HTMLImageElement | null {
    if (!safePath.startsWith('../assets/')) {
      const validCustom = validateCustomAssetDataUrl(safePath, 'avatar');
      if (!validCustom) return null;
    }
    const cached = this.imageCache.get(safePath);
    if (cached) {
      return cached.complete && cached.naturalWidth > 0 ? cached : null;
    }
    if (this.imageCache.size >= 64) {
      for (const key of this.imageCache.keys()) {
        if (key.startsWith('data:')) {
          this.imageCache.delete(key);
          if (this.imageCache.size < 48) break;
        }
      }
    }
    const img = new Image();
    img.onload = () => {
      if (!this.destroyed && this.active) {
        this.renderNow();
      }
    };
    img.src = safePath;
    this.imageCache.set(safePath, img);
    return img.complete && img.naturalWidth > 0 ? img : null;
  }

  private resizeCanvas(contentRect?: { width: number; height: number }): void {
    const rect =
      contentRect && contentRect.width > 0 && contentRect.height > 0
        ? contentRect
        : this.canvas.getBoundingClientRect();
    const rawDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const dpr = Math.max(1, Math.min(2, rawDpr));
    this.dpr = dpr;
    const cssW = Math.max(260, rect.width || (this.canvas.width > 0 ? this.canvas.width / dpr : 640));
    const cssH = Math.max(160, rect.height || (this.canvas.height > 0 ? this.canvas.height / dpr : 280));
    const targetW = Math.round(cssW * dpr);
    const targetH = Math.round(cssH * dpr);
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
    // Keep logical height comfortably scaled so sprites stay crisp in both narrow sidebar and wide editor
    const baseH = cssH >= 360 ? 320 : 240;
    this.cssW = cssW;
    this.cssH = cssH;
    this.scale = cssH / baseH;
    this.logicalH = baseH;
    this.logicalW = Math.max(280, Math.round(cssW / Math.max(0.4, this.scale)));
    this.engine.setBounds(this.logicalW, this.logicalH);
  }

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (active) {
      this.lastRenderMs = 0;
      this.resizeCanvas();
      if (this.pageVisible) {
        this.renderNow();
        this.ensureLoop();
      }
    } else if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  update(input: PetRenderInput): void {
    this.lastInput = input;
    this.engine.syncSnapshot(input.snapshot, {
      botAppearances: input.botAppearances,
      redactMode: input.redactMode,
      locale: input.locale,
    });
    if (this.active && this.pageVisible) {
      this.renderNow();
      this.ensureLoop();
    }
  }

  private ensureLoop(): void {
    if (this.destroyed || !this.active || !this.pageVisible) return;
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(this.frameLoop);
    }
  }

  private readonly frameLoop = (nowMs: number): void => {
    this.rafId = null;
    if (this.destroyed || !this.active || !this.pageVisible || !this.lastInput) return;

    const displayTs =
      typeof this.lastInput.displayTimestampMs === 'number' &&
      Number.isFinite(this.lastInput.displayTimestampMs)
        ? this.lastInput.displayTimestampMs
        : this.lastInput.snapshot.capturedAt > 0
          ? this.lastInput.snapshot.capturedAt
          : Date.now();
    const phase = resolveAtmospherePhase(this.lastInput.atmosphereMode ?? 'auto', displayTs);
    const weatherKind = resolveWeatherKind(
      this.lastInput.weatherMode ?? 'auto',
      phase,
      this.lastInput.themeId
    );
    const targetIntervalMs = resolvePetThrottleIntervalMs(this.engine, weatherKind);
    if (
      this.lastRenderMs > 0 &&
      targetIntervalMs > 0 &&
      nowMs - this.lastRenderMs < targetIntervalMs
    ) {
      this.ensureLoop();
      return;
    }

    const dtMs =
      this.lastRenderMs > 0 ? Math.max(0, Math.min(250, nowMs - this.lastRenderMs)) : 16;
    this.lastRenderMs = nowMs;
    const dtSecs = dtMs / 1000;

    this.engine.step(dtSecs, { locale: this.lastInput.locale });
    this.weather.step(dtSecs, weatherKind, [this.logicalW, this.logicalH]);
    this.renderNow();
    this.ensureLoop();
  };

  private clientToLogical(clientX: number, clientY: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const s = Math.max(0.4, this.scale);
    return [(clientX - rect.left) / s, (clientY - rect.top) / s];
  }

  private readonly handleClick = (ev: MouseEvent): void => {
    if (!this.active || !this.lastInput) return;
    const [lx, ly] = this.clientToLogical(ev.clientX, ev.clientY);
    const botId = this.engine.findPetAt(lx, ly);
    if (botId) {
      this.engine.interactWithPet(botId, this.lastInput.locale);
      this.lastRenderMs = 0;
      this.onSelectAndPet(botId);
      this.renderNow();
    }
  };

  private readonly handlePointerMove = (ev: PointerEvent): void => {
    if (!this.active) return;
    const [lx, ly] = this.clientToLogical(ev.clientX, ev.clientY);
    const botId = this.engine.findPetAt(lx, ly);
    this.canvas.style.cursor = botId ? 'pointer' : 'default';
    this.onHoverBot?.(botId);
  };

  private readonly handlePointerLeave = (): void => {
    this.canvas.style.cursor = 'default';
    this.onHoverBot?.(null);
  };

  renderNow(): void {
    const input = this.lastInput;
    if (!input) return;
    if (!this.resizeObserver && !this.hasWindowResizeListener) {
      this.resizeCanvas();
    }

    const dpr = this.dpr;
    const ctx = this.ctx;
    const s = Math.max(0.4, this.scale);
    const w = this.logicalW;
    const h = this.logicalH;
    const floor = this.engine.floorY();

    const displayTs =
      typeof input.displayTimestampMs === 'number' && Number.isFinite(input.displayTimestampMs)
        ? input.displayTimestampMs
        : input.snapshot.capturedAt > 0
          ? input.snapshot.capturedAt
          : Date.now();
    const phase = resolveAtmospherePhase(input.atmosphereMode ?? 'auto', displayTs);
    const weatherKind = resolveWeatherKind(input.weatherMode ?? 'auto', phase, input.themeId);
    this.weather.syncKind(weatherKind, [w, h]);

    ctx.save();
    ctx.setTransform(dpr * s, 0, 0, dpr * s, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const broadcastMode = Boolean(input.broadcastMode);
    if (broadcastMode) {
      const chromaHex = getBroadcastChromaColor(input.broadcastChromaKey ?? 'green');
      ctx.fillStyle = chromaHex;
      ctx.fillRect(0, 0, w, h);

      // Subtle grounded strip line for OBS / screen-recording clarity without green halo
      ctx.fillStyle = 'rgba(11, 15, 23, 0.35)';
      ctx.fillRect(0, floor - 2, w, 4);
      ctx.fillStyle = 'rgba(248, 250, 252, 0.22)';
      ctx.fillRect(0, floor - 2, w, 1);
    } else {
      // 1. Terrarium Sky / Atmosphere Backdrop
      this.paintTerrariumBackdrop(ctx, w, h, floor, input.themeId, phase);

      // 2. Weather particles inside habitat glass
      this.paintTerrariumWeather(ctx, w, h, weatherKind, phase);

      // 3. Shelf / Habitat Floor
      this.paintShelfFloor(ctx, w, h, floor, input.themeId, phase);
    }

    // 4. Dropped Toys (coffee, ball, treat)
    for (const toy of this.engine.toys) {
      this.paintToy(ctx, toy, floor);
    }

    // 5. Pets (sorted back-to-front by depthOffset)
    const sortedPets = [...this.engine.pets].sort((a, b) => a.depthOffset - b.depthOffset);
    const loc = tStrings(input.locale);
    const filterSet = input.filterMatchedBotIds ?? null;
    const isNarrow = this.cssW < PET_NARROW_WIDTH_PX || w < PET_NARROW_WIDTH_PX;
    const placedBadges: PlacedBadgeRect[] = [];
    const nameplateCandidates: Array<{
      pet: PetEntity;
      px: number;
      baseY: number;
      selected: boolean;
      dimmed: boolean;
      plateLabel: string;
      statusDotColor: string;
    }> = [];

    for (const pet of sortedPets) {
      const dimmed = filterSet !== null && !filterSet.has(pet.botId);
      const selected = input.selectedBotId === pet.botId;
      const customAvatarUrl =
        input.customAvatars && isSafeKey(pet.botId) && Object.hasOwn(input.customAvatars, pet.botId)
          ? validateCustomAssetDataUrl(input.customAvatars[pet.botId], 'avatar')
          : null;
      const rpgLevel =
        input.rpgProfiles && isSafeKey(pet.botId) && Object.hasOwn(input.rpgProfiles, pet.botId)
          ? input.rpgProfiles[pet.botId].level
          : null;
      const plateInfo = this.paintPet(ctx, pet, floor, selected, dimmed, input.redactMode, phase, loc, {
        narrow: isNarrow,
        maxW: w,
        placedBadges,
        customAvatarUrl,
        rpgLevel,
        broadcastMode,
        dpr,
      });
      nameplateCandidates.push({
        pet,
        px: plateInfo.px,
        baseY: plateInfo.baseY,
        selected,
        dimmed,
        plateLabel: plateInfo.plateLabel,
        statusDotColor: plateInfo.statusDotColor,
      });
    }

    // 5b. Screen-calibrated ground nameplates (crisp CSS-pixel sizing + overlap resolution)
    this.paintNameplateRail(ctx, dpr, s, floor, nameplateCandidates, {
      broadcastMode,
      narrow: isNarrow,
    });

    // 6. Front glass knock ripples
    for (const r of this.engine.ripples) {
      const t = Math.max(0, Math.min(1, r.age / Math.max(0.01, r.ttl)));
      ctx.save();
      ctx.globalAlpha = (1 - t) * 0.85;
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 8 + t * 24, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // 7. Pet Particles (hearts, sparkles, sweat, smoke, steam, zzz, quick-send letter)
    for (const p of this.engine.particles) {
      this.paintParticle(ctx, p);
    }

    // 8. Front Terrarium Glass Frame & Specular Highlight (omitted in Broadcast chroma mode)
    if (!broadcastMode) {
      this.paintGlassFrame(ctx, w, h, input.themeId);
    }

    ctx.restore();
  }

  private paintTerrariumBackdrop(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    floor: number,
    themeId: ThemeId,
    phase: AtmospherePhase
  ): void {
    const sky = ctx.createLinearGradient(0, 0, 0, floor);
    if (themeId === 'cyber_ops') {
      if (phase === 'day') {
        sky.addColorStop(0, '#0f172a');
        sky.addColorStop(1, '#1e293b');
      } else if (phase === 'sunset') {
        sky.addColorStop(0, '#1e1b4b');
        sky.addColorStop(1, '#4c1d95');
      } else {
        sky.addColorStop(0, '#090d1a');
        sky.addColorStop(1, '#17153b');
      }
    } else if (phase === 'day') {
      sky.addColorStop(0, '#1e3a5f');
      sky.addColorStop(0.55, '#3b6d9c');
      sky.addColorStop(1, '#7fb3d5');
    } else if (phase === 'sunset') {
      sky.addColorStop(0, '#2e1a47');
      sky.addColorStop(0.55, '#9d4452');
      sky.addColorStop(1, '#f4a261');
    } else {
      sky.addColorStop(0, '#0b1026');
      sky.addColorStop(0.65, '#172554');
      sky.addColorStop(1, '#1e293b');
    }
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    // Night stars
    if (phase === 'night') {
      ctx.save();
      for (let i = 0; i < 18; i++) {
        const sx = ((i * 173 + 37) % Math.max(40, w - 24)) + 12;
        const sy = ((i * 89 + 19) % Math.max(30, floor * 0.55)) + 10;
        const twinkle = 0.35 + 0.55 * Math.sin(this.engine.elapsedSecs * 2 + i);
        ctx.globalAlpha = twinkle;
        ctx.fillStyle = '#fef9c3';
        ctx.beginPath();
        ctx.arc(sx, sy, i % 3 === 0 ? 1.5 : 1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // Theme-specific habitat scenery
    if (themeId === 'corporate_office') {
      this.paintCorporateOfficeBackdrop(ctx, w, floor, phase);
    } else if (themeId === 'cozy_cafe') {
      this.paintCozyCafeBackdrop(ctx, w, floor, phase);
    } else if (themeId === 'cyber_ops') {
      this.paintCyberOpsBackdrop(ctx, w, floor);
    } else {
      this.paintStartupOfficeBackdrop(ctx, w, floor, phase);
    }
  }

  private paintStartupOfficeBackdrop(
    ctx: CanvasRenderingContext2D,
    w: number,
    floor: number,
    phase: AtmospherePhase
  ): void {
    ctx.save();
    // Warm brick-tinted loft wall wash & subtle brick course lines
    ctx.fillStyle =
      phase === 'day'
        ? 'rgba(180, 110, 76, 0.22)'
        : phase === 'sunset'
          ? 'rgba(154, 72, 54, 0.28)'
          : 'rgba(92, 46, 36, 0.36)';
    ctx.fillRect(0, 0, w, floor);

    const brickH = 12;
    const brickW = 28;
    ctx.strokeStyle =
      phase === 'day' ? 'rgba(255, 228, 196, 0.085)' : 'rgba(255, 228, 196, 0.05)';
    ctx.lineWidth = 1;
    for (let by = 24, row = 0; by < floor - 4; by += brickH, row++) {
      ctx.beginPath();
      ctx.moveTo(0, by);
      ctx.lineTo(w, by);
      ctx.stroke();
      const offset = (row % 2) * (brickW * 0.5);
      for (let bx = offset; bx < w; bx += brickW) {
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx, Math.min(floor - 2, by + brickH));
        ctx.stroke();
      }
    }

    // Soft glowing arched loft window silhouettes
    const winCount = w < 520 ? 2 : 3;
    const winW = Math.min(54, Math.max(38, Math.round(w * 0.1)));
    const winBottom = floor - 14;
    const winBodyH = Math.min(54, Math.max(34, Math.round(floor * 0.32)));
    const archR = winW * 0.5;
    const archCy = winBottom - winBodyH;
    const windowFractions = winCount === 2 ? [0.28, 0.72] : [0.22, 0.5, 0.78];

    for (const frac of windowFractions) {
      const cx = w * frac;
      const glow = ctx.createRadialGradient(cx, archCy + 14, 4, cx, archCy + 14, winW * 1.15);
      glow.addColorStop(
        0,
        phase === 'day' ? 'rgba(186, 230, 253, 0.24)' : 'rgba(253, 224, 71, 0.2)'
      );
      glow.addColorStop(1, 'rgba(253, 224, 71, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, archCy + 14, winW * 1.15, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(cx, archCy, archR, Math.PI, 0);
      ctx.lineTo(cx + archR, winBottom);
      ctx.lineTo(cx - archR, winBottom);
      ctx.closePath();
      ctx.fillStyle =
        phase === 'day'
          ? 'rgba(186, 230, 253, 0.26)'
          : phase === 'sunset'
            ? 'rgba(251, 146, 60, 0.2)'
            : 'rgba(253, 224, 71, 0.14)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(41, 37, 36, 0.6)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Window muntin crossbars
      ctx.strokeStyle = 'rgba(41, 37, 36, 0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, archCy - archR);
      ctx.lineTo(cx, winBottom);
      ctx.moveTo(cx - archR, archCy + 4);
      ctx.lineTo(cx + archR, archCy + 4);
      ctx.moveTo(cx - archR, archCy + winBodyH * 0.52);
      ctx.lineTo(cx + archR, archCy + winBodyH * 0.52);
      ctx.stroke();
    }

    // Mini hanging wall shelf with tiny pixel books & potted vine
    const shelfX = Math.round(w < 520 ? w * 0.5 - 23 : w * 0.36 - 23);
    const shelfY = Math.max(66, Math.round(floor * 0.44));
    const shelfW = 46;
    ctx.fillStyle = '#78350f';
    ctx.fillRect(shelfX, shelfY, shelfW, 4);
    ctx.fillStyle = '#b45309';
    ctx.fillRect(shelfX, shelfY, shelfW, 1.5);
    ctx.fillStyle = 'rgba(28, 25, 23, 0.55)';
    ctx.fillRect(shelfX + 5, shelfY + 4, 3, 5);
    ctx.fillRect(shelfX + shelfW - 8, shelfY + 4, 3, 5);

    const bookColors = ['#ef4444', '#38bdf8', '#f59e0b', '#a78bfa'];
    const bookHeights = [9, 11, 8, 10];
    for (let i = 0; i < bookColors.length; i++) {
      const bh = bookHeights[i] ?? 9;
      ctx.fillStyle = bookColors[i] ?? '#38bdf8';
      ctx.fillRect(shelfX + 5 + i * 5, shelfY - bh, 4, bh);
    }

    const potX = shelfX + shelfW - 13;
    ctx.fillStyle = '#c2410c';
    ctx.fillRect(potX, shelfY - 6, 7, 6);
    ctx.fillStyle = '#22c55e';
    ctx.beginPath();
    ctx.arc(potX + 3.5, shelfY - 8, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#4ade80';
    ctx.beginPath();
    ctx.arc(potX + 6, shelfY - 2, 2.2, 0, Math.PI * 2);
    ctx.arc(potX + 7.5, shelfY + 3, 2, 0, Math.PI * 2);
    ctx.arc(potX + 6.5, shelfY + 8, 1.8, 0, Math.PI * 2);
    ctx.fill();

    // Twinkling string fairy lights strung across upper loft wall
    ctx.strokeStyle = 'rgba(255, 243, 199, 0.35)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    const bulblets = Math.max(6, Math.floor(w / 64));
    for (let i = 0; i <= bulblets; i++) {
      const fx = (i * w) / bulblets;
      const fy = 12 + Math.sin((i / bulblets) * Math.PI * 3) * 6;
      if (i === 0) ctx.moveTo(fx, fy);
      else ctx.lineTo(fx, fy);
    }
    ctx.stroke();
    for (let i = 1; i < bulblets; i++) {
      const fx = (i * w) / bulblets;
      const fy = 12 + Math.sin((i / bulblets) * Math.PI * 3) * 6;
      const pulse = 0.55 + 0.45 * Math.sin(this.engine.elapsedSecs * 2.5 + i * 0.9);
      if (phase !== 'day') {
        ctx.globalAlpha = 0.24 * pulse;
        ctx.fillStyle = '#fde68a';
        ctx.beginPath();
        ctx.arc(fx, fy + 2, 7.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = phase === 'day' ? 0.45 * pulse : 0.92 * pulse;
      ctx.fillStyle = i % 2 === 0 ? '#fde68a' : '#fed7aa';
      ctx.beginPath();
      ctx.arc(fx, fy + 2, 2.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private paintCorporateOfficeBackdrop(
    ctx: CanvasRenderingContext2D,
    w: number,
    floor: number,
    phase: AtmospherePhase
  ): void {
    ctx.save();
    // Distant skyline layer
    const bgCount = Math.max(6, Math.floor(w / 52));
    for (let i = 0; i < bgCount; i++) {
      const bw = 34 + (i % 4) * 10;
      const bh = Math.min(floor - 20, 44 + ((i * 37) % 68));
      const bx = i * (w / bgCount) + 2;
      const by = floor - bh;
      ctx.fillStyle = phase === 'day' ? 'rgba(51, 65, 85, 0.26)' : 'rgba(15, 23, 42, 0.48)';
      ctx.fillRect(bx, by, bw, bh);
    }

    // Foreground skyscrapers with twinkling office windows & rooftop spires
    const bCount = Math.max(5, Math.floor(w / 62));
    for (let i = 0; i < bCount; i++) {
      const bw = 38 + (i % 3) * 14;
      const bh = Math.min(floor - 24, 52 + ((i * 29) % 70));
      const bx = i * (w / bCount) + 6;
      const by = floor - bh;
      ctx.fillStyle = phase === 'night' ? 'rgba(15, 23, 42, 0.78)' : 'rgba(30, 41, 59, 0.5)';
      ctx.fillRect(bx, by, bw, bh);
      if (i % 3 === 1) {
        ctx.fillRect(bx + bw * 0.25, by - 7, bw * 0.5, 7);
        ctx.fillRect(bx + bw * 0.5 - 0.75, by - 16, 1.5, 9);
      }

      if (phase !== 'day') {
        for (let wy = by + 8; wy < floor - 10; wy += 11) {
          for (let wx = bx + 6; wx < bx + bw - 8; wx += 9) {
            if ((wx + wy + i) % 3 !== 0) {
              const twinkle = 0.35 + 0.55 * (0.5 + 0.5 * Math.sin(this.engine.elapsedSecs * 1.4 + wx * 0.3 + wy * 0.2 + i));
              ctx.globalAlpha = twinkle;
              ctx.fillStyle = (wx + i) % 5 === 0 ? '#7dd3fc' : '#fde047';
              ctx.fillRect(wx, wy, 3.5, 4.5);
            }
          }
        }
        ctx.globalAlpha = 1;
      }
    }

    // Sleek architectural window panes & soft glass reflections
    const paneStep = Math.max(88, Math.round(w / 5));
    for (let px = paneStep, idx = 0; px < w - 20; px += paneStep, idx++) {
      if (idx % 2 === 0) {
        ctx.fillStyle = 'rgba(241, 245, 249, 0.045)';
        ctx.beginPath();
        ctx.moveTo(px - paneStep * 0.6, 0);
        ctx.lineTo(px - paneStep * 0.32, 0);
        ctx.lineTo(px - paneStep * 0.65, floor);
        ctx.lineTo(px - paneStep * 0.9, floor);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(15, 23, 42, 0.42)';
      ctx.fillRect(px, 0, 2, floor);
      ctx.fillStyle = 'rgba(148, 163, 184, 0.14)';
      ctx.fillRect(px + 2, 0, 1, floor);
    }
    const transomY = Math.round(floor * 0.34);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.38)';
    ctx.fillRect(0, transomY, w, 2);
    ctx.fillStyle = 'rgba(148, 163, 184, 0.12)';
    ctx.fillRect(0, transomY + 2, w, 1);
    ctx.restore();
  }

  private paintCozyCafeBackdrop(
    ctx: CanvasRenderingContext2D,
    w: number,
    floor: number,
    phase: AtmospherePhase
  ): void {
    ctx.save();
    // Warm cafe wall tint + lower wood wainscot paneling
    ctx.fillStyle = phase === 'day' ? 'rgba(120, 53, 15, 0.12)' : 'rgba(92, 45, 16, 0.24)';
    ctx.fillRect(0, 0, w, floor);

    const wainscotY = floor - Math.min(54, Math.round(floor * 0.34));
    const woodGrad = ctx.createLinearGradient(0, wainscotY, 0, floor);
    woodGrad.addColorStop(0, '#5c3a21');
    woodGrad.addColorStop(1, '#3b2313');
    ctx.fillStyle = woodGrad;
    ctx.fillRect(0, wainscotY, w, floor - wainscotY);

    ctx.strokeStyle = 'rgba(28, 16, 8, 0.42)';
    ctx.lineWidth = 1;
    for (let px = 18; px < w; px += 18) {
      ctx.beginPath();
      ctx.moveTo(px, wainscotY + 3);
      ctx.lineTo(px, floor);
      ctx.stroke();
    }
    ctx.fillStyle = '#85583a';
    ctx.fillRect(0, wainscotY, w, 3);
    ctx.fillStyle = 'rgba(28, 16, 8, 0.45)';
    ctx.fillRect(0, wainscotY + 3, w, 1.5);

    // Chalkboard menu silhouette on upper-left wall
    const boardW = Math.min(64, Math.max(46, Math.round(w * 0.14)));
    const boardH = Math.min(44, Math.max(32, Math.round(floor * 0.24)));
    const boardX = Math.max(20, Math.round(w * 0.11));
    const boardY = Math.max(44, wainscotY - boardH - 18);
    drawRoundedRect(ctx, boardX - 3, boardY - 3, boardW + 6, boardH + 6, 3);
    ctx.fillStyle = '#78350f';
    ctx.fill();
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(boardX, boardY, boardW, boardH);
    ctx.fillStyle = 'rgba(248, 250, 252, 0.48)';
    ctx.fillRect(boardX + 6, boardY + 6, boardW * 0.55, 2);
    ctx.fillStyle = 'rgba(226, 232, 240, 0.32)';
    ctx.fillRect(boardX + 6, boardY + 13, boardW * 0.68, 1.5);
    ctx.fillRect(boardX + 6, boardY + 19, boardW * 0.58, 1.5);
    ctx.fillRect(boardX + 6, boardY + 25, boardW * 0.64, 1.5);
    // Tiny chalk mug doodle
    ctx.strokeStyle = 'rgba(253, 224, 71, 0.45)';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(boardX + boardW - 14, boardY + boardH - 13, 8, 7);

    // Tiny coffee shelf with mugs on upper-right wall
    const shelfW = 50;
    const shelfX = Math.round(w - Math.max(74, w * 0.18));
    const shelfY = Math.max(54, wainscotY - 18);
    ctx.fillStyle = '#78350f';
    ctx.fillRect(shelfX, shelfY, shelfW, 4);
    ctx.fillStyle = '#a16207';
    ctx.fillRect(shelfX, shelfY, shelfW, 1.5);
    const mugColors = ['#f8fafc', '#6ee7b7', '#fb923c'];
    for (let i = 0; i < mugColors.length; i++) {
      const mx = shelfX + 6 + i * 13;
      ctx.fillStyle = mugColors[i] ?? '#f8fafc';
      ctx.fillRect(mx, shelfY - 7, 7, 7);
      ctx.strokeStyle = mugColors[i] ?? '#f8fafc';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.arc(mx + 7.5, shelfY - 3.5, 2, -Math.PI * 0.5, Math.PI * 0.5);
      ctx.stroke();
    }

    // Pendant Edison bulbs with warm radial glow halos
    const lamps = Math.max(3, Math.floor(w / 145));
    for (let i = 0; i < lamps; i++) {
      const lx = ((i + 0.5) * w) / lamps;
      ctx.strokeStyle = 'rgba(120, 53, 15, 0.8)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(lx, 0);
      ctx.lineTo(lx, 24);
      ctx.stroke();

      ctx.fillStyle = '#92400e';
      ctx.fillRect(lx - 2.5, 21, 5, 4);

      const glow = ctx.createRadialGradient(lx, 28, 2, lx, 28, 38);
      glow.addColorStop(0, phase === 'day' ? 'rgba(254, 240, 138, 0.45)' : 'rgba(251, 191, 36, 0.78)');
      glow.addColorStop(1, 'rgba(251, 191, 36, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(lx, 28, 38, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#fef08a';
      ctx.beginPath();
      ctx.arc(lx, 27, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private paintCyberOpsBackdrop(
    ctx: CanvasRenderingContext2D,
    w: number,
    floor: number
  ): void {
    ctx.save();
    // Subtle orthogonal glass grid
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.08)';
    ctx.lineWidth = 1;
    for (let gx = 0; gx < w; gx += 32) {
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, floor);
      ctx.stroke();
    }
    for (let gy = 28; gy < floor; gy += 28) {
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(w, gy);
      ctx.stroke();
    }

    // Isometric hex honeycomb lattice on glass wall
    const hexR = 18;
    const hexH = Math.sqrt(3) * hexR;
    const stepX = hexR * 1.5;
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.11)';
    ctx.lineWidth = 1;
    for (let col = 0, cx = hexR; cx < w + hexR; col++, cx += stepX) {
      const yOffset = (col % 2) * (hexH * 0.5);
      for (let cy = 22 + yOffset; cy < floor - 14; cy += hexH) {
        ctx.beginPath();
        for (let k = 0; k < 6; k++) {
          const angle = (Math.PI / 3) * k;
          const vx = cx + Math.cos(angle) * (hexR - 2);
          const vy = cy + Math.sin(angle) * (hexR - 2);
          if (k === 0) ctx.moveTo(vx, vy);
          else ctx.lineTo(vx, vy);
        }
        ctx.closePath();
        ctx.stroke();
      }
    }

    // Subtle holographic monitor silhouettes
    const holoFracs = w < 520 ? [0.24, 0.76] : [0.2, 0.5, 0.8];
    const holoW = Math.min(58, Math.max(42, Math.round(w * 0.11)));
    const holoH = Math.min(34, Math.max(24, Math.round(floor * 0.18)));
    const holoY = Math.max(44, Math.round(floor * 0.34));
    for (let i = 0; i < holoFracs.length; i++) {
      const hx = Math.round(w * (holoFracs[i] ?? 0.5) - holoW * 0.5);
      const pulse = 0.65 + 0.3 * Math.sin(this.engine.elapsedSecs * 1.8 + i * 1.3);
      ctx.globalAlpha = pulse;
      drawRoundedRect(ctx, hx, holoY, holoW, holoH, 3);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.42)';
      ctx.fill();
      ctx.strokeStyle = i % 2 === 0 ? 'rgba(34, 211, 238, 0.32)' : 'rgba(232, 121, 249, 0.28)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Tiny holographic telemetry bars inside monitor
      for (let b = 0; b < 5; b++) {
        const barH = 5 + ((b * 7 + i * 3) % Math.max(6, holoH - 12));
        ctx.fillStyle = i % 2 === 0 ? 'rgba(34, 211, 238, 0.38)' : 'rgba(232, 121, 249, 0.35)';
        ctx.fillRect(hx + 7 + b * 8, holoY + holoH - 5 - barH, 4, barH);
      }
    }
    ctx.globalAlpha = 1;

    // Cyan / magenta neon horizon tubes
    const drawNeonTube = (y: number, glowColor: string, coreColor: string): void => {
      ctx.strokeStyle = glowColor;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(10, y);
      ctx.lineTo(w - 10, y);
      ctx.stroke();

      ctx.strokeStyle = coreColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(10, y);
      ctx.lineTo(w - 10, y);
      ctx.stroke();
    };
    drawNeonTube(floor - 18, 'rgba(34, 211, 238, 0.22)', 'rgba(34, 211, 238, 0.72)');
    drawNeonTube(floor - 12, 'rgba(232, 121, 249, 0.18)', 'rgba(232, 121, 249, 0.62)');
    ctx.restore();
  }

  private paintTerrariumWeather(
    ctx: CanvasRenderingContext2D,
    _w: number,
    _h: number,
    kind: WeatherKind,
    phase: AtmospherePhase
  ): void {
    if (kind === 'clear') return;
    ctx.save();
    if (kind === 'rain') {
      ctx.lineCap = 'round';
      for (const p of this.weather.particles) {
        ctx.globalAlpha = p.alpha * 0.85;
        ctx.strokeStyle = p.tint;
        ctx.lineWidth = p.radius;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.length * 0.2, p.y + p.length);
        ctx.stroke();
      }
    } else if (kind === 'snow') {
      for (const p of this.weather.particles) {
        ctx.globalAlpha = p.alpha * 0.9;
        ctx.fillStyle = p.tint;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      const boost = phase === 'night' ? 1 : 0.65;
      for (const p of this.weather.particles) {
        const twinkle = 0.45 + 0.55 * Math.sin(this.engine.elapsedSecs * 2.4 + p.phase);
        ctx.globalAlpha = p.alpha * twinkle * boost;
        ctx.fillStyle = p.tint;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private paintShelfFloor(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    floor: number,
    themeId: ThemeId,
    phase: AtmospherePhase
  ): void {
    const shelfH = h - floor;
    const grad = ctx.createLinearGradient(0, floor - 6, 0, h);
    if (themeId === 'cyber_ops') {
      grad.addColorStop(0, '#1e293b');
      grad.addColorStop(0.22, '#0f172a');
      grad.addColorStop(1, '#020617');
    } else if (themeId === 'corporate_office') {
      grad.addColorStop(0, '#475569');
      grad.addColorStop(0.22, '#334155');
      grad.addColorStop(1, '#1e293b');
    } else if (themeId === 'cozy_cafe') {
      grad.addColorStop(0, '#9a6b43');
      grad.addColorStop(0.24, '#7c502d');
      grad.addColorStop(1, '#4a2e19');
    } else {
      grad.addColorStop(0, '#85583a');
      grad.addColorStop(0.24, '#6b442a');
      grad.addColorStop(1, '#3f2718');
    }

    ctx.fillStyle = grad;
    ctx.fillRect(0, floor - 6, w, shelfH + 6);

    // Top shelf highlight edge
    ctx.fillStyle =
      themeId === 'cyber_ops'
        ? 'rgba(34, 211, 238, 0.55)'
        : phase === 'night'
          ? 'rgba(255, 255, 255, 0.12)'
          : 'rgba(255, 255, 255, 0.22)';
    ctx.fillRect(0, floor - 6, w, 2);

    // Potted succulent on left corner
    ctx.save();
    const px = 22;
    const py = floor + 2;
    ctx.fillStyle = themeId === 'cyber_ops' ? '#0ea5e9' : '#c2410c';
    drawRoundedRect(ctx, px - 8, py - 14, 16, 14, 3);
    ctx.fill();
    ctx.fillStyle = '#22c55e';
    ctx.beginPath();
    ctx.arc(px - 4, py - 17, 5, 0, Math.PI * 2);
    ctx.arc(px + 4, py - 17, 5, 0, Math.PI * 2);
    ctx.arc(px, py - 21, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private paintToy(ctx: CanvasRenderingContext2D, toy: PetToy, floor: number): void {
    const x = toy.x;
    const y = floor + toy.yOffset;
    ctx.save();
    // Shadow
    const shadowScale = Math.max(0.35, 1 + toy.yOffset / 100);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.3)';
    ctx.beginPath();
    ctx.ellipse(x, floor + 2, 10 * shadowScale, 3.5 * shadowScale, 0, 0, Math.PI * 2);
    ctx.fill();

    if (toy.kind === 'ball') {
      ctx.beginPath();
      ctx.arc(x, y - 8, 8.5, 0, Math.PI * 2);
      ctx.fillStyle = '#a3e635';
      ctx.fill();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = '#3f6212';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x - 2.5, y - 10.5, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = '#ecfccb';
      ctx.fill();
    } else if (toy.kind === 'coffee') {
      drawRoundedRect(ctx, x - 7, y - 14, 14, 13, 3);
      ctx.fillStyle = '#f8fafc';
      ctx.fill();
      ctx.strokeStyle = '#78350f';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.fillStyle = '#6b3e1f';
      ctx.fillRect(x - 5.5, y - 13, 11, 2.5);
      ctx.beginPath();
      ctx.arc(x + 7.5, y - 7.5, 3.2, -Math.PI * 0.5, Math.PI * 0.5);
      ctx.strokeStyle = '#e2e8f0';
      ctx.stroke();
    } else {
      // Cookie treat
      ctx.beginPath();
      ctx.arc(x, y - 7, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#d97706';
      ctx.fill();
      ctx.strokeStyle = '#78350f';
      ctx.lineWidth = 1.3;
      ctx.stroke();
      ctx.fillStyle = '#451a03';
      ctx.beginPath();
      ctx.arc(x - 3, y - 9, 1.4, 0, Math.PI * 2);
      ctx.arc(x + 2.5, y - 8, 1.4, 0, Math.PI * 2);
      ctx.arc(x, y - 4.5, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private paintPet(
    ctx: CanvasRenderingContext2D,
    pet: PetEntity,
    floor: number,
    selected: boolean,
    dimmed: boolean,
    redactMode: boolean,
    phase: AtmospherePhase,
    loc: ReturnType<typeof tStrings>,
    layout: {
      narrow: boolean;
      maxW: number;
      placedBadges: PlacedBadgeRect[];
      customAvatarUrl?: string | null;
      rpgLevel?: number | null;
      broadcastMode?: boolean;
      dpr: number;
    }
  ): { px: number; baseY: number; plateLabel: string; statusDotColor: string } {
    const spriteSize = 52;
    const baseY = floor + pet.depthOffset * 8;
    const walkBob =
      pet.aiState === 'wandering' || pet.aiState === 'chasing_toy'
        ? -Math.abs(Math.sin(pet.walkPhase)) * 4.5
        : pet.aiState === 'typing'
          ? (Math.sin(pet.walkPhase) > 0 ? -1.4 : 0.8)
          : 0;
    const shakeX = pet.aiState === 'flustered' ? Math.sin(pet.walkPhase * 1.4) * 2.4 : 0;
    const px = pet.x + shakeX;
    const py = baseY + pet.yOffset + walkBob;

    ctx.save();
    if (dimmed) {
      ctx.globalAlpha = 0.25;
    }

    // Ground shadow
    const shadowW = 34 * Math.max(0.55, 1 + pet.yOffset / 120);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.34)';
    ctx.beginPath();
    ctx.ellipse(px, baseY + 2, shadowW * 0.5, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Selection or NeedsOwner floor ring
    if (selected) {
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(px, baseY + 2, 24, 7, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (pet.aiState === 'knocking') {
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(px, baseY + 2, 24, 7, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Miniature glowing laptop for Working pets
    if (pet.aiState === 'typing') {
      const lx = px + (pet.facing === 'right' ? 18 : -18);
      const ly = baseY - 2;
      ctx.save();
      if (phase === 'night' || phase === 'sunset') {
        const glow = ctx.createRadialGradient(lx, ly - 8, 2, lx, ly - 8, 26);
        glow.addColorStop(0, 'rgba(56, 189, 248, 0.32)');
        glow.addColorStop(1, 'rgba(56, 189, 248, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(lx, ly - 8, 26, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#334155';
      ctx.fillRect(lx - 8, ly - 2, 16, 3);
      ctx.fillStyle = '#0ea5e9';
      drawRoundedRect(ctx, lx - 7, ly - 13, 14, 10, 2);
      ctx.fill();
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }

    // Character sprite (or custom uploaded raster avatar)
    const customImg = layout.customAvatarUrl ? this.loadImage(layout.customAvatarUrl) : null;
    const spritePath = resolveCharacterSpritePath(pet.characterId);
    const img = customImg ?? this.loadImage(spritePath);
    const spec = CHARACTER_SPECS[pet.characterId];
    const drawW = customImg ? spriteSize * 0.88 : spriteSize * spec.scale;
    const drawH = customImg ? spriteSize * 0.88 : spriteSize * spec.scale;

    ctx.save();
    if (pet.status.kind === 'Paused') {
      ctx.filter = 'grayscale(85%) opacity(78%)';
    }
    ctx.translate(px, py);
    if (customImg) {
      const ax = -drawW * 0.5;
      const ay = -drawH * 0.96;
      const rad = Math.max(8, drawW * 0.28);
      ctx.save();
      drawRoundedRect(ctx, ax, ay, drawW, drawH, rad);
      ctx.fillStyle = '#0f141e';
      ctx.fill();
      ctx.clip();
      if (pet.facing === 'left') {
        ctx.scale(-1, 1);
      }
      ctx.drawImage(customImg, ax, ay, drawW, drawH);
      ctx.restore();
      drawRoundedRect(ctx, ax, ay, drawW, drawH, rad);
      ctx.lineWidth = layout.broadcastMode ? 2.2 : 1.6;
      ctx.strokeStyle = selected ? '#38bdf8' : '#0b0f17';
      ctx.stroke();
    } else {
      if (pet.facing === 'left') {
        ctx.scale(-1, 1);
      }
      if (img) {
        ctx.drawImage(img, -drawW * 0.5, -drawH * 0.92, drawW, drawH);
      } else {
        drawRoundedRect(ctx, -18, -38, 36, 36, 10);
        ctx.fillStyle = '#475569';
        ctx.fill();
      }
    }
    ctx.restore();

    // Status indicators above pet
    const topY = py - drawH * 0.92;
    let statusPillY = topY - 10;
    const s = Math.max(0.4, this.scale);
    if (pet.aiState === 'knocking') {
      statusPillY = this.paintBadgePill(
        ctx,
        px,
        topY - 12,
        `★ ${loc.petNeedsYouSign}`,
        '#eab308',
        '#422006',
        layout
      );
      ctx.save();
      ctx.setTransform(layout.dpr, 0, 0, layout.dpr, 0, 0);
      ctx.font = `700 11px ${CANVAS_FONT_FAMILY}`;
      ctx.fillStyle = '#fef08a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        loc.petKnockLabel,
        Math.max(24, Math.min(this.cssW - 24, px * s)),
        Math.max(10, statusPillY * s - 16)
      );
      ctx.restore();
    } else if (pet.aiState === 'flustered') {
      statusPillY = this.paintBadgePill(ctx, px, topY - 10, '!', '#dc2626', '#ffffff', layout);
    } else if (pet.aiState === 'thinking') {
      statusPillY = this.paintBadgePill(
        ctx,
        px,
        topY - 10,
        pet.status.kind === 'Blocked' ? '■ ?' : '?',
        '#b45309',
        '#fef3c7',
        layout
      );
    } else if (pet.aiState === 'typing' && !redactMode && pet.status.kind === 'Working' && pet.status.tool) {
      const toolLabel = formatPetToolLabel(pet.status.tool, layout.narrow);
      if (toolLabel) {
        statusPillY = this.paintBadgePill(
          ctx,
          px,
          topY - 10,
          `▶ ${toolLabel}`,
          '#1d4ed8',
          '#ffffff',
          layout
        );
      }
    }

    // Reaction bubble (bilingual, generic safe text)
    if (pet.reactionText && pet.reactionTtl > 0) {
      const alpha = Math.min(1, pet.reactionTtl / 0.35);
      ctx.save();
      ctx.globalAlpha *= alpha;
      const reactionGapLogical = (this.cssW >= 900 ? 25 : 21) / s;
      const reactionTargetY = Math.min(topY - 26, statusPillY - reactionGapLogical);
      this.paintBadgePill(
        ctx,
        px,
        reactionTargetY,
        pet.reactionText,
        'rgba(255, 251, 235, 0.96)',
        '#451a03',
        layout
      );
      ctx.restore();
    }

    // Compute nameplate metadata for global rail layout
    const rawPlateLabel = redactMode ? pet.redactedAlias : pet.name;
    const plateLabel =
      layout.broadcastMode && layout.rpgLevel && layout.rpgLevel >= 1
        ? `${rawPlateLabel} · Lv.${layout.rpgLevel}`
        : rawPlateLabel;
    const statusDotColor =
      pet.status.kind === 'Working'
        ? '#38bdf8'
        : pet.status.kind === 'NeedsOwner'
          ? '#facc15'
          : pet.status.kind === 'Error'
            ? '#ef4444'
            : pet.status.kind === 'Blocked' || pet.status.kind === 'WaitingAnswer'
              ? '#fb923c'
              : pet.status.kind === 'Paused'
                ? '#64748b'
                : '#4ade80';

    ctx.restore();
    return { px, baseY, plateLabel, statusDotColor };
  }

  private paintNameplateRail(
    ctx: CanvasRenderingContext2D,
    dpr: number,
    scale: number,
    floorLogicalY: number,
    candidates: ReadonlyArray<{
      pet: PetEntity;
      px: number;
      baseY: number;
      selected: boolean;
      dimmed: boolean;
      plateLabel: string;
      statusDotColor: string;
    }>,
    options: { broadcastMode: boolean; narrow: boolean }
  ): void {
    if (candidates.length === 0) return;

    const cssW = this.cssW;
    const cssH = this.cssH;
    const isWide = cssW >= 900;
    const fontSize = options.broadcastMode
      ? isWide
        ? 13.5
        : options.narrow
          ? 10.5
          : 12
      : isWide
        ? 12
        : 10.5;
    const pillH = isWide ? 24 : 19;
    const dotPad = options.broadcastMode ? 17 : 8;
    const padRight = options.broadcastMode ? 9 : 8;
    const chromePad = dotPad + padRight;
    const count = Math.max(1, candidates.length);
    const maxPillW = options.broadcastMode
      ? isWide
        ? Math.max(96, Math.min(168, Math.floor(((cssW - 24) / count) * 1.32)))
        : Math.max(76, Math.min(136, Math.floor(((cssW - 16) / count) * 1.4)))
      : isWide
        ? 136
        : 98;
    const maxTextW = Math.max(36, maxPillW - chromePad);

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `700 ${fontSize}px ${CANVAS_FONT_FAMILY}`;

    const floorCss = floorLogicalY * scale;
    const railGap = options.broadcastMode
      ? Math.min(28, Math.max(14, (cssH - floorCss) * 0.25))
      : Math.min(22, Math.max(10, (cssH - floorCss) * 0.24));
    const railBaseY = Math.round(floorCss + railGap);

    const inputs: NameplateItemInput[] = candidates.map((c) => {
      const label = truncateCanvasLabel(ctx, c.plateLabel, maxTextW);
      const measuredW = Math.min(maxTextW, ctx.measureText(label).width);
      const pillW = Math.min(maxPillW, Math.ceil(measuredW + chromePad));
      return {
        botId: c.pet.botId,
        label,
        anchorCx: c.px * scale,
        pillW,
        baseY: c.baseY * scale,
        statusDotColor: c.statusDotColor,
        selected: c.selected,
        dimmed: c.dimmed,
      };
    });

    const boxes = resolveNameplateBoxes(inputs, {
      canvasWidth: cssW,
      canvasHeight: cssH,
      railBaseY,
      pillH,
      tierStepY: pillH + 5,
      minGapX: 6,
      maxNudgeX: options.broadcastMode ? 36 : 24,
      marginX: 6,
      maxTiers: 3,
    });

    for (const box of boxes) {
      ctx.save();
      if (box.dimmed) {
        ctx.globalAlpha = 0.28;
      }
      const radius = options.broadcastMode ? 8 : 6;
      drawRoundedRect(ctx, box.left, box.top, box.pillW, pillH, radius);
      ctx.fillStyle = options.broadcastMode
        ? '#0b0f17'
        : box.selected
          ? 'rgba(14, 165, 233, 0.92)'
          : 'rgba(15, 23, 42, 0.84)';
      ctx.fill();
      ctx.strokeStyle = box.selected
        ? '#7dd3fc'
        : options.broadcastMode
          ? '#020617'
          : 'rgba(148, 163, 184, 0.35)';
      ctx.lineWidth = options.broadcastMode ? 1.5 : 1;
      ctx.stroke();

      if (options.broadcastMode) {
        ctx.fillStyle = box.statusDotColor;
        ctx.beginPath();
        ctx.arc(box.left + 9, box.top + pillH * 0.5, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = options.broadcastMode ? 'left' : 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        box.label,
        options.broadcastMode ? box.left + dotPad : box.left + box.pillW * 0.5,
        box.top + pillH * 0.52
      );
      ctx.restore();
    }

    ctx.restore();
  }

  private paintBadgePill(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    text: string,
    bg: string,
    fg: string,
    layout?: { narrow: boolean; maxW: number; placedBadges: PlacedBadgeRect[]; dpr?: number }
  ): number {
    const narrow = layout?.narrow ?? false;
    const cssW = this.cssW;
    const s = Math.max(0.4, this.scale);
    const dpr = layout?.dpr ?? (typeof window !== 'undefined' ? Math.max(1, Math.min(2, window.devicePixelRatio || 1)) : 1);
    const isWide = cssW >= 900;
    const fontSize = narrow ? 10 : isWide ? 12.5 : 11;
    const padX = isWide ? 9 : 7;
    const maxTextW = narrow ? 92 : isWide ? 156 : 124;
    const pillH = isWide ? 21 : 17;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `700 ${fontSize}px ${CANVAS_FONT_FAMILY}`;
    const displayText = truncateCanvasLabel(ctx, text, maxTextW);
    const textW = Math.min(maxTextW, ctx.measureText(displayText).width);
    const pillW = textW + padX * 2;
    const cxCss = cx * s;
    const cyCss = cy * s;
    const clampedCx = Math.max(pillW * 0.5 + 6, Math.min(cssW - pillW * 0.5 - 6, cxCss));

    let resolvedCx = clampedCx;
    let resolvedCy = Math.max(pillH * 0.5 + 4, cyCss);
    const halfH = pillH * 0.5;

    if (layout?.placedBadges) {
      const collidesAt = (candCx: number, candCy: number): boolean => {
        const left = candCx - pillW * 0.5;
        const right = candCx + pillW * 0.5;
        return layout.placedBadges.some(
          (b) =>
            Math.abs(b.cy - candCy) < halfH + b.halfH + 3 &&
            !(right + 4 <= b.left || left - 4 >= b.right)
        );
      };

      let found = false;
      // 1. Prefer straight vertical stacking above pet first (keeps horizontal alignment & narrow badge spacing clear)
      for (let attempt = 0; attempt < 7; attempt++) {
        const candCy = Math.max(pillH * 0.5 + 4, cyCss - attempt * (pillH + 4));
        if (!collidesAt(clampedCx, candCy)) {
          resolvedCx = clampedCx;
          resolvedCy = candCy;
          found = true;
          break;
        }
      }

      // 2. If vertical ceiling reached on crowded canvas, nudge horizontally across tiers
      if (!found) {
        const nudges = [-28, 28, -56, 56, -84, 84];
        outer: for (let attempt = 0; attempt < 7; attempt++) {
          const candCy = Math.max(pillH * 0.5 + 4, cyCss - attempt * (pillH + 4));
          for (const dx of nudges) {
            const candCx = Math.max(pillW * 0.5 + 6, Math.min(cssW - pillW * 0.5 - 6, clampedCx + dx));
            if (!collidesAt(candCx, candCy)) {
              resolvedCx = candCx;
              resolvedCy = candCy;
              found = true;
              break outer;
            }
          }
        }
      }

      layout.placedBadges.push({
        left: resolvedCx - pillW * 0.5,
        right: resolvedCx + pillW * 0.5,
        cy: resolvedCy,
        halfH,
      });
    }

    drawRoundedRect(ctx, resolvedCx - pillW * 0.5, resolvedCy - halfH, pillW, pillH, 999);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(displayText, resolvedCx, resolvedCy + 0.5);
    ctx.restore();
    return resolvedCy / s;
  }

  private paintParticle(ctx: CanvasRenderingContext2D, p: PetParticle): void {
    const t = Math.max(0, Math.min(1, p.age / Math.max(0.01, p.ttl)));
    const alpha = t < 0.15 ? t / 0.15 : Math.max(0, 1 - (t - 0.15) / 0.85);
    ctx.save();
    ctx.globalAlpha = alpha;
    if (p.kind === 'heart') {
      ctx.fillStyle = p.color;
      ctx.font = `700 ${Math.round(p.size + 4)}px ${CANVAS_FONT_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('♥', p.x, p.y);
    } else if (p.kind === 'zzz') {
      ctx.fillStyle = p.color;
      ctx.font = `700 ${Math.round(p.size)}px ${CANVAS_FONT_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.fillText('Z', p.x, p.y);
    } else if (p.kind === 'letter') {
      ctx.fillStyle = '#fef9c3';
      drawRoundedRect(ctx, p.x - 8, p.y - 5.5, 16, 11, 2);
      ctx.fill();
      ctx.strokeStyle = '#d97706';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.x - 7, p.y - 4.5);
      ctx.lineTo(p.x, p.y + 1);
      ctx.lineTo(p.x + 7, p.y - 4.5);
      ctx.stroke();
    } else {
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 0.48, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private paintGlassFrame(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    themeId: ThemeId
  ): void {
    ctx.save();
    // Subtle diagonal glass glare
    const glare = ctx.createLinearGradient(0, 0, w * 0.35, h * 0.55);
    glare.addColorStop(0, 'rgba(255, 255, 255, 0.08)');
    glare.addColorStop(0.5, 'rgba(255, 255, 255, 0.02)');
    glare.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = glare;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(w * 0.42, 0);
    ctx.lineTo(w * 0.14, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fill();

    // Outer glass rim
    ctx.strokeStyle =
      themeId === 'cyber_ops' ? 'rgba(34, 211, 238, 0.42)' : 'rgba(226, 232, 240, 0.24)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, w - 2, h - 2);
    ctx.restore();
  }

  dispose(): void {
    this.destroyed = true;
    this.active = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', this.handleWindowResize);
    }
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
    this.canvas.removeEventListener('click', this.handleClick);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerleave', this.handlePointerLeave);
    this.imageCache.clear();
  }
}
