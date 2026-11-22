import {
  CHARACTER_SPRITE_PATHS,
  type CharacterId,
  POOL_CHARACTER_IDS,
  THEME_BG_PATHS,
  type ThemeId,
  type UiLocale,
  isPoolCharacterId,
  isValidCharacterId,
  isValidThemeId,
} from '../src/types.ts';
import {
  CHARACTER_TEXTS,
  type CharacterTextSpec,
  type LandmarkKind,
  pickLocale,
  tStrings,
} from './i18n.ts';

export type CharacterSpec = {
  id: CharacterId;
  displayName: string;
  shortName: string;
  roleHint: string;
  spritePath: string;
  scale: number;
  anchor: [number, number];
};

export type Landmark = {
  x: number;
  y: number;
  label: string;
};

export type BotDeskSlot = {
  slot: number;
  x: number;
  y: number;
  facing: 'left' | 'right';
  workerOffset: [number, number];
};

export type OverflowGrid = {
  originX: number;
  originY: number;
  stepX: number;
  stepY: number;
  cols: number;
};

export type ThemeConfig = {
  id: ThemeId;
  name: string;
  bgPath: string;
  designSize: [number, number];
  bossDesk: Landmark;
  officeDoor: Landmark;
  automationBoard: Landmark;
  botDesks: readonly BotDeskSlot[];
  overflowGrid: OverflowGrid;
};

const CHARACTER_BASE_GEOMETRY: Readonly<
  Record<CharacterId, { scale: number; anchor: [number, number] }>
> = Object.freeze({
  ddochi: { scale: 1.0, anchor: [0.5, 0.9] },
  security: { scale: 1.0, anchor: [0.5, 0.9] },
  iac: { scale: 1.0, anchor: [0.5, 0.9] },
  cloud_ops: { scale: 1.0, anchor: [0.5, 0.9] },
  cost: { scale: 1.0, anchor: [0.5, 0.9] },
  internal_tools: { scale: 1.0, anchor: [0.5, 0.9] },
  personal_assist: { scale: 1.0, anchor: [0.5, 0.9] },
  cve: { scale: 1.0, anchor: [0.5, 0.9] },
  doc_review: { scale: 1.0, anchor: [0.5, 0.9] },
  bot_world: { scale: 1.0, anchor: [0.5, 0.9] },
  worker_helper: { scale: 0.72, anchor: [0.5, 0.9] },
});

function buildCharacterSpecs(locale: UiLocale): Readonly<Record<CharacterId, CharacterSpec>> {
  const texts = pickLocale(CHARACTER_TEXTS, locale);
  const entries = (Object.keys(CHARACTER_BASE_GEOMETRY) as CharacterId[]).map((id) => {
    const geom = CHARACTER_BASE_GEOMETRY[id];
    const txt = texts[id];
    const spec: CharacterSpec = {
      id,
      displayName: txt.displayName,
      shortName: txt.shortName,
      roleHint: txt.roleHint,
      spritePath: CHARACTER_SPRITE_PATHS[id],
      scale: geom.scale,
      anchor: geom.anchor,
    };
    return [id, spec] as const;
  });
  return Object.freeze(Object.fromEntries(entries) as Record<CharacterId, CharacterSpec>);
}

const CHARACTER_SPECS_BY_LOCALE: Readonly<
  Record<UiLocale, Readonly<Record<CharacterId, CharacterSpec>>>
> = Object.freeze({
  en: buildCharacterSpecs('en'),
  ko: buildCharacterSpecs('ko'),
});

export const CHARACTER_SPECS: Readonly<Record<CharacterId, CharacterSpec>> =
  CHARACTER_SPECS_BY_LOCALE.en;

export function getCharacterSpecs(
  locale: UiLocale = 'en'
): Readonly<Record<CharacterId, CharacterSpec>> {
  return pickLocale(CHARACTER_SPECS_BY_LOCALE, locale);
}

export function getCharacterSpec(
  id: CharacterId,
  locale: UiLocale = 'en'
): CharacterSpec {
  const specs = getCharacterSpecs(locale);
  return specs[id] ?? specs.ddochi;
}

export function resolveCharacterText(
  id: CharacterId,
  locale: UiLocale = 'en'
): CharacterTextSpec {
  const texts = pickLocale(CHARACTER_TEXTS, locale);
  return texts[id] ?? texts.ddochi;
}

const NAME_OVERRIDES = new Map<string, CharacterId>([
  ['ops lead', 'ddochi'],
  ['coordinator', 'ddochi'],
  ['총괄', 'ddochi'],
  ['보안', 'security'],
  ['security', 'security'],
  ['iac', 'iac'],
  ['클라우드 운영', 'cloud_ops'],
  ['cloud ops', 'cloud_ops'],
  ['cloud_ops', 'cloud_ops'],
  ['비용', 'cost'],
  ['cost', 'cost'],
  ['사내 도구', 'internal_tools'],
  ['internal tools', 'internal_tools'],
  ['internal_tools', 'internal_tools'],
  ['업무 보조', 'personal_assist'],
  ['personal assist', 'personal_assist'],
  ['personal_assist', 'personal_assist'],
  ['cve', 'cve'],
  ['문서 리뷰', 'doc_review'],
  ['doc review', 'doc_review'],
  ['doc_review', 'doc_review'],
  ['봇 월드', 'bot_world'],
  ['bot world', 'bot_world'],
  ['bot-world', 'bot_world'],
  ['bot_world', 'bot_world'],
]);

type ThemeGeometry = {
  id: ThemeId;
  bgPath: string;
  designSize: [number, number];
  bossDeskPos: [number, number];
  officeDoorPos: [number, number];
  automationBoardPos: [number, number];
  botDesks: readonly BotDeskSlot[];
  overflowGrid: OverflowGrid;
};

const THEME_GEOMETRIES: Readonly<Record<ThemeId, ThemeGeometry>> = Object.freeze({
  startup_office: {
    id: 'startup_office',
    bgPath: THEME_BG_PATHS.startup_office,
    designSize: [1376, 768],
    bossDeskPos: [825, 215],
    officeDoorPos: [1140, 625],
    automationBoardPos: [175, 320],
    botDesks: [
      { slot: 0, x: 318, y: 402, facing: 'right', workerOffset: [-42, 22] },
      { slot: 1, x: 462, y: 486, facing: 'right', workerOffset: [-42, 22] },
      { slot: 2, x: 588, y: 318, facing: 'left', workerOffset: [42, -18] },
      { slot: 3, x: 698, y: 388, facing: 'left', workerOffset: [42, 18] },
      { slot: 4, x: 222, y: 642, facing: 'right', workerOffset: [-42, 20] },
      { slot: 5, x: 742, y: 588, facing: 'left', workerOffset: [40, 18] },
      { slot: 6, x: 348, y: 706, facing: 'right', workerOffset: [-42, 10] },
      { slot: 7, x: 492, y: 622, facing: 'right', workerOffset: [-42, 18] },
      { slot: 8, x: 622, y: 702, facing: 'left', workerOffset: [42, 10] },
      { slot: 9, x: 825, y: 704, facing: 'left', workerOffset: [44, -6] },
      { slot: 10, x: 152, y: 495, facing: 'right', workerOffset: [-38, 22] },
      { slot: 11, x: 258, y: 432, facing: 'right', workerOffset: [-38, 22] },
      { slot: 12, x: 502, y: 565, facing: 'left', workerOffset: [40, 18] },
      { slot: 13, x: 308, y: 586, facing: 'right', workerOffset: [-42, 20] },
    ],
    overflowGrid: { originX: 905, originY: 155, stepX: 132, stepY: 74, cols: 3 },
  },
  corporate_office: {
    id: 'corporate_office',
    bgPath: THEME_BG_PATHS.corporate_office,
    designSize: [1376, 768],
    bossDeskPos: [750, 200],
    officeDoorPos: [1015, 625],
    automationBoardPos: [245, 195],
    botDesks: [
      { slot: 0, x: 468, y: 276, facing: 'right', workerOffset: [-42, 22] },
      { slot: 1, x: 885, y: 458, facing: 'right', workerOffset: [-42, 20] },
      { slot: 2, x: 356, y: 448, facing: 'right', workerOffset: [-42, -18] },
      { slot: 3, x: 618, y: 320, facing: 'right', workerOffset: [42, 22] },
      { slot: 4, x: 202, y: 368, facing: 'left', workerOffset: [38, 18] },
      { slot: 5, x: 604, y: 466, facing: 'left', workerOffset: [42, 18] },
      { slot: 6, x: 456, y: 560, facing: 'left', workerOffset: [-42, 20] },
      { slot: 7, x: 1078, y: 422, facing: 'left', workerOffset: [42, 18] },
      { slot: 8, x: 760, y: 668, facing: 'right', workerOffset: [-42, 10] },
      { slot: 9, x: 602, y: 612, facing: 'right', workerOffset: [-42, 16] },
      { slot: 10, x: 472, y: 392, facing: 'right', workerOffset: [42, -18] },
      { slot: 11, x: 108, y: 428, facing: 'right', workerOffset: [-38, 18] },
      { slot: 12, x: 794, y: 538, facing: 'left', workerOffset: [42, 16] },
      { slot: 13, x: 910, y: 578, facing: 'left', workerOffset: [42, -10] },
    ],
    overflowGrid: { originX: 890, originY: 160, stepX: 130, stepY: 74, cols: 3 },
  },
});

function buildThemeConfig(themeId: ThemeId, locale: UiLocale): ThemeConfig {
  const geom = THEME_GEOMETRIES[themeId];
  const s = tStrings(locale);
  return {
    id: geom.id,
    name: s.themeFull[themeId],
    bgPath: geom.bgPath,
    designSize: geom.designSize,
    bossDesk: { x: geom.bossDeskPos[0], y: geom.bossDeskPos[1], label: s.landmarks.bossDesk },
    officeDoor: { x: geom.officeDoorPos[0], y: geom.officeDoorPos[1], label: s.landmarks.officeDoor },
    automationBoard: {
      x: geom.automationBoardPos[0],
      y: geom.automationBoardPos[1],
      label: s.landmarks.automationBoard,
    },
    botDesks: geom.botDesks,
    overflowGrid: geom.overflowGrid,
  };
}

const THEME_CONFIGS_BY_LOCALE: Readonly<Record<UiLocale, Readonly<Record<ThemeId, ThemeConfig>>>> =
  Object.freeze({
    en: Object.freeze({
      startup_office: buildThemeConfig('startup_office', 'en'),
      corporate_office: buildThemeConfig('corporate_office', 'en'),
    }),
    ko: Object.freeze({
      startup_office: buildThemeConfig('startup_office', 'ko'),
      corporate_office: buildThemeConfig('corporate_office', 'ko'),
    }),
  });

export const THEME_CONFIGS: Readonly<Record<ThemeId, ThemeConfig>> = THEME_CONFIGS_BY_LOCALE.en;

export function resolveThemeName(themeId: ThemeId, locale: UiLocale = 'en'): string {
  return tStrings(locale).themeFull[themeId];
}

export function resolveLandmarkLabel(kind: LandmarkKind, locale: UiLocale = 'en'): string {
  return tStrings(locale).landmarks[kind];
}

export function getThemeConfig(themeId: string, locale: UiLocale = 'en'): ThemeConfig {
  const configs = pickLocale(THEME_CONFIGS_BY_LOCALE, locale);
  return isValidThemeId(themeId) ? configs[themeId] : configs.startup_office;
}

export function resolveThemeAssetPath(themeId: string): string {
  return isValidThemeId(themeId) ? THEME_BG_PATHS[themeId] : THEME_BG_PATHS.startup_office;
}

export function resolveCharacterSpritePath(charId: string): string {
  return isValidCharacterId(charId) ? CHARACTER_SPRITE_PATHS[charId] : CHARACTER_SPRITE_PATHS.ddochi;
}

export function fnv1aHash(text: string): number {
  const bytes = new TextEncoder().encode(text);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const b of bytes) {
    hash ^= BigInt(b);
    hash = (hash * prime) & mask;
  }
  return Number(hash % BigInt(POOL_CHARACTER_IDS.length));
}

const KEYWORD_CHARACTER_RULES: ReadonlyArray<readonly [CharacterId, RegExp]> = [
  ['cost', /(?:cost|finops|billing|budget|비용|예산)/],
  ['cve', /(?:cve|advisory|vuln|audit|scan|취약점|감사)/],
  ['ddochi', /(?:coord|lead|orchestr|manager|dispatcher|조율|총괄|리더|팀장)/],
  ['iac', /(?:(?:^|[^a-z])iac(?:$|[^a-z])|infra|terraform|pulumi|ansible|k8s|kubernetes|devops|인프라)/],
  [
    'security',
    /(?:security|appsec|infosec|secops|(?:^|[^a-z])sec(?:$|[^a-z]|bot)|(?:^|[^a-z])o?auth(?!or)|guard|보안|인증)/,
  ],
  [
    'cloud_ops',
    /(?:cloud|(?:^|[^a-z])ops(?:$|[^a-z])|(?:^|[^a-z])sre(?:$|[^a-z])|deploy|on-?call|monitor|운영|온콜)/,
  ],
  ['internal_tools', /(?:tool|(?:^|[^a-z])ci(?:$|[^a-z])|cicd|ci\/cd|build|(?:^|[^a-z])auto|도구|자동화)/],
  ['doc_review', /(?:(?:^|[^a-z])docs?(?:$|[^a-z])|document|review|(?:^|[^a-z])qa(?:$|[^a-z])|(?:^|[^a-z])test|리뷰|문서)/],
  ['personal_assist', /(?:assist|help|plan|note|(?:^|[^a-z])pm(?:$|[^a-z])|보조|기획)/],
  ['bot_world', /(?:bot[\s_-]?world|(?:^|[^a-z])world(?:$|[^a-z])|월드)/],
];

export function resolveCharacterId(botId: string, botName: string): CharacterId {
  const safeBotId = typeof botId === 'string' ? botId : '';
  const safeBotName = typeof botName === 'string' ? botName : '';
  const normalized = safeBotName.trim().toLowerCase();
  const override = NAME_OVERRIDES.get(normalized) ?? NAME_OVERRIDES.get(safeBotName);
  if (override) return override;
  for (const [charId, pattern] of KEYWORD_CHARACTER_RULES) {
    if (pattern.test(normalized)) {
      return charId;
    }
  }
  const idx = fnv1aHash(safeBotId);
  return POOL_CHARACTER_IDS[idx] ?? 'ddochi';
}

export function resolveCharacterIdWithPrefs(
  botAppearances: Record<string, CharacterId>,
  botId: string,
  botName: string
): CharacterId {
  if (botAppearances && typeof botId === 'string' && Object.hasOwn(botAppearances, botId)) {
    const custom = botAppearances[botId];
    if (isPoolCharacterId(custom)) {
      return custom;
    }
  }
  return resolveCharacterId(botId, botName);
}

const OVERFLOW_MIN_SEPARATION_PX = 72;

function isHudExclusionZone(x: number, y: number, designH: number): boolean {
  return x < 260 && y > designH - 110;
}

function isClearOverflowCell(
  x: number,
  y: number,
  theme: ThemeConfig,
  placed: ReadonlyArray<readonly [number, number]>,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  designH: number,
  minPeerSpacingX: number,
  minPeerSpacingY: number
): boolean {
  if (x < minX || x > maxX || y < minY || y > maxY) return false;
  if (isHudExclusionZone(x, y, designH)) return false;

  for (const desk of theme.botDesks) {
    if (Math.hypot(x - desk.x, y - desk.y) < OVERFLOW_MIN_SEPARATION_PX) {
      return false;
    }
  }
  for (const landmark of [theme.officeDoor, theme.bossDesk, theme.automationBoard]) {
    if (Math.hypot(x - landmark.x, y - landmark.y) < OVERFLOW_MIN_SEPARATION_PX) {
      return false;
    }
  }
  for (const [px, py] of placed) {
    if (Math.abs(px - x) < minPeerSpacingX && Math.abs(py - y) < minPeerSpacingY) {
      return false;
    }
    if (Math.hypot(px - x, py - y) < OVERFLOW_MIN_SEPARATION_PX) {
      return false;
    }
  }
  return true;
}

export function deskPosition(theme: ThemeConfig, index: number): [number, number, [number, number]] {
  if (index < theme.botDesks.length) {
    const slot = theme.botDesks[index];
    return [slot.x, slot.y, slot.workerOffset];
  }
  const designW = Math.max(200, theme.designSize[0]);
  const designH = Math.max(200, theme.designSize[1]);
  const minX = 95;
  const maxX = Math.max(minX, designW - 95);
  const minY = 145;
  const maxY = Math.max(minY, designH - 72);

  const overflowIdx = Math.max(0, index - theme.botDesks.length);
  const cols = Math.max(1, theme.overflowGrid.cols);
  const stepX = Math.max(124, theme.overflowGrid.stepX);
  const stepY = Math.max(68, theme.overflowGrid.stepY);
  const clampedOriginX = Math.max(minX, Math.min(maxX, theme.overflowGrid.originX));
  const clampedOriginY = Math.max(minY, Math.min(maxY, theme.overflowGrid.originY));

  const placed: Array<[number, number]> = [];
  const minPeerSpacingX = Math.max(118, stepX * 0.9);
  const minPeerSpacingY = Math.max(60, stepY * 0.85);

  // Pass 1: primary overflowGrid area on the right/configured zone
  for (let y = clampedOriginY; y <= maxY && placed.length <= overflowIdx; y += stepY) {
    for (let col = 0; col < cols && placed.length <= overflowIdx; col++) {
      const x = clampedOriginX + col * stepX;
      if (
        isClearOverflowCell(
          x,
          y,
          theme,
          placed,
          minX,
          maxX,
          minY,
          maxY,
          designH,
          minPeerSpacingX,
          minPeerSpacingY
        )
      ) {
        placed.push([x, y]);
      }
    }
  }

  // Pass 2: secondary full-canvas scan for large fleets (e.g. 30-45+ bots)
  if (placed.length <= overflowIdx) {
    const scanStartX = minX + 15;
    for (let y = clampedOriginY; y <= maxY && placed.length <= overflowIdx; y += stepY) {
      for (let x = scanStartX; x <= maxX && placed.length <= overflowIdx; x += stepX) {
        if (
          isClearOverflowCell(
            x,
            y,
            theme,
            placed,
            minX,
            maxX,
            minY,
            maxY,
            designH,
            minPeerSpacingX,
            minPeerSpacingY
          )
        ) {
          placed.push([x, y]);
        }
      }
    }
  }

  if (overflowIdx < placed.length) {
    const [x, y] = placed[overflowIdx];
    return [x, y, [-38, 20]];
  }

  // Pass 3: deterministic lap-offset fallback if every non-overlapping cell is occupied
  const baseList: Array<[number, number]> =
    placed.length > 0 ? placed : [[clampedOriginX, clampedOriginY]];
  const baseIdx = overflowIdx % baseList.length;
  const lap = Math.floor(overflowIdx / baseList.length);
  const [baseX, baseY] = baseList[baseIdx];
  const lapOffsetX = (lap % 2 === 1 ? 1 : -1) * Math.min(28, lap * 16);
  const lapOffsetY = (lap * 14) % Math.max(16, Math.floor(stepY * 0.5));
  let x = Math.max(minX, Math.min(maxX, baseX + lapOffsetX));
  let y = Math.max(minY, Math.min(maxY, baseY + lapOffsetY));

  if (
    !isClearOverflowCell(x, y, theme, [], minX, maxX, minY, maxY, designH, 0, 0)
  ) {
    x = baseX;
    y = baseY;
  }
  return [x, y, [-38, 20]];
}
