import {
  CHARACTER_SPRITE_PATHS,
  type CharacterId,
  POOL_CHARACTER_IDS,
  THEME_BG_PATHS,
  type ThemeId,
  isPoolCharacterId,
  isValidCharacterId,
  isValidThemeId,
} from '../src/types.ts';

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

export const CHARACTER_SPECS: Readonly<Record<CharacterId, CharacterSpec>> = Object.freeze({
  ddochi: {
    id: 'ddochi',
    displayName: '또치 캐릭터',
    shortName: '또치',
    roleHint: '전체 조율',
    spritePath: CHARACTER_SPRITE_PATHS.ddochi,
    scale: 1.0,
    anchor: [0.5, 0.9],
  },
  security: {
    id: 'security',
    displayName: '보안 캐릭터',
    shortName: '보안',
    roleHint: '인증·보안·패치',
    spritePath: CHARACTER_SPRITE_PATHS.security,
    scale: 1.0,
    anchor: [0.5, 0.9],
  },
  iac: {
    id: 'iac',
    displayName: 'IaC 캐릭터',
    shortName: 'IaC',
    roleHint: '인프라 코드·재편',
    spritePath: CHARACTER_SPRITE_PATHS.iac,
    scale: 1.0,
    anchor: [0.5, 0.9],
  },
  cloud_ops: {
    id: 'cloud_ops',
    displayName: '클라우드 운영 캐릭터',
    shortName: '클라우드 운영',
    roleHint: '클러스터·배포·관측',
    spritePath: CHARACTER_SPRITE_PATHS.cloud_ops,
    scale: 1.0,
    anchor: [0.5, 0.9],
  },
  cost: {
    id: 'cost',
    displayName: '비용 캐릭터',
    shortName: '비용',
    roleHint: '클라우드 비용·절감',
    spritePath: CHARACTER_SPRITE_PATHS.cost,
    scale: 1.0,
    anchor: [0.5, 0.9],
  },
  internal_tools: {
    id: 'internal_tools',
    displayName: '사내 도구 캐릭터',
    shortName: '사내 도구',
    roleHint: '사내 도구·자동화',
    spritePath: CHARACTER_SPRITE_PATHS.internal_tools,
    scale: 1.0,
    anchor: [0.5, 0.9],
  },
  personal_assist: {
    id: 'personal_assist',
    displayName: '업무 보조 캐릭터',
    shortName: '업무 보조',
    roleHint: '개발환경·지식 정리',
    spritePath: CHARACTER_SPRITE_PATHS.personal_assist,
    scale: 1.0,
    anchor: [0.5, 0.9],
  },
  cve: {
    id: 'cve',
    displayName: 'CVE 캐릭터',
    shortName: 'CVE',
    roleHint: '취약점 노출·영향 분석',
    spritePath: CHARACTER_SPRITE_PATHS.cve,
    scale: 1.0,
    anchor: [0.5, 0.9],
  },
  doc_review: {
    id: 'doc_review',
    displayName: '문서 리뷰 캐릭터',
    shortName: '문서 리뷰',
    roleHint: '설계·문서 사전 검토',
    spritePath: CHARACTER_SPRITE_PATHS.doc_review,
    scale: 1.0,
    anchor: [0.5, 0.9],
  },
  bot_world: {
    id: 'bot_world',
    displayName: '봇 월드 캐릭터',
    shortName: '봇 월드',
    roleHint: '가상 사무실 앱 개발',
    spritePath: CHARACTER_SPRITE_PATHS.bot_world,
    scale: 1.0,
    anchor: [0.5, 0.9],
  },
  worker_helper: {
    id: 'worker_helper',
    displayName: '워커 도우미',
    shortName: '도우미',
    roleHint: '하위 작업 도우미',
    spritePath: CHARACTER_SPRITE_PATHS.worker_helper,
    scale: 0.72,
    anchor: [0.5, 0.9],
  },
});

const NAME_OVERRIDES = new Map<string, CharacterId>([
  ['또치', 'ddochi'],
  ['보안', 'security'],
  ['IaC', 'iac'],
  ['클라우드 운영', 'cloud_ops'],
  ['비용', 'cost'],
  ['사내 도구', 'internal_tools'],
  ['업무 보조', 'personal_assist'],
  ['CVE', 'cve'],
  ['문서 리뷰', 'doc_review'],
  ['봇 월드', 'bot_world'],
]);

export const THEME_CONFIGS: Readonly<Record<ThemeId, ThemeConfig>> = Object.freeze({
  startup_office: {
    id: 'startup_office',
    name: '스타트업 사무실',
    bgPath: THEME_BG_PATHS.startup_office,
    designSize: [1376, 768],
    bossDesk: { x: 825, y: 215, label: '사장님 책상' },
    officeDoor: { x: 1140, y: 625, label: '출입구' },
    automationBoard: { x: 175, y: 320, label: '자동화 보드' },
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
    overflowGrid: { originX: 860, originY: 480, stepX: 96, stepY: 68, cols: 3 },
  },
  corporate_office: {
    id: 'corporate_office',
    name: '대기업 사무실',
    bgPath: THEME_BG_PATHS.corporate_office,
    designSize: [1376, 768],
    bossDesk: { x: 750, y: 200, label: '사장님 책상' },
    officeDoor: { x: 1015, y: 625, label: '출입구' },
    automationBoard: { x: 245, y: 195, label: '자동화 보드' },
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
    overflowGrid: { originX: 770, originY: 295, stepX: 115, stepY: 76, cols: 3 },
  },
});

export function getThemeConfig(themeId: string): ThemeConfig {
  return isValidThemeId(themeId) ? THEME_CONFIGS[themeId] : THEME_CONFIGS.startup_office;
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

export function resolveCharacterId(botId: string, botName: string): CharacterId {
  const override = NAME_OVERRIDES.get(botName);
  if (override) return override;
  const idx = fnv1aHash(botId);
  return POOL_CHARACTER_IDS[idx] ?? 'ddochi';
}

export function resolveCharacterIdWithPrefs(
  botAppearances: Record<string, CharacterId>,
  botId: string,
  botName: string
): CharacterId {
  if (Object.hasOwn(botAppearances, botId)) {
    const custom = botAppearances[botId];
    if (isPoolCharacterId(custom)) {
      return custom;
    }
  }
  return resolveCharacterId(botId, botName);
}

export function deskPosition(theme: ThemeConfig, index: number): [number, number, [number, number]] {
  if (index < theme.botDesks.length) {
    const slot = theme.botDesks[index];
    return [slot.x, slot.y, slot.workerOffset];
  }
  const overflowIdx = Math.max(0, index - theme.botDesks.length);
  const cols = Math.max(1, theme.overflowGrid.cols);
  const col = overflowIdx % cols;
  const row = Math.floor(overflowIdx / cols);
  const x = theme.overflowGrid.originX + col * theme.overflowGrid.stepX;
  const y = theme.overflowGrid.originY + row * theme.overflowGrid.stepY;
  return [x, y, [-38, 20]];
}
