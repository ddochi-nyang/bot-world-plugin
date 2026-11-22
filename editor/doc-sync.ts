import {
  type AtmosphereMode,
  type BotWorldDocumentData,
  type CharacterId,
  DEFAULT_BOTWORLD_DOCUMENT,
  type DeskCoordinate,
  MAX_BOT_APPEARANCES,
  MAX_CUSTOM_DESK_POSITIONS,
  isPoolCharacterId,
  isSafeKey,
  isValidAtmosphereMode,
  isValidThemeId,
  sanitizeCustomDeskPositions,
  toPlainSafeRecord,
  validateBotWorldDocument,
} from '../src/types.ts';

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

function sanitizeSelectedBotId(val: unknown): string | null {
  return typeof val === 'string' &&
    isSafeKey(val) &&
    val.length <= 128 &&
    !CONTROL_CHAR_RE.test(val)
    ? val
    : null;
}

function normalizeAppearances(raw: unknown): Record<string, CharacterId> {
  const map = new Map<string, CharacterId>();
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [botId, charId] of Object.entries(raw as Record<string, unknown>)) {
      if (map.size >= MAX_BOT_APPEARANCES) break;
      if (
        isSafeKey(botId) &&
        botId.length <= 128 &&
        !CONTROL_CHAR_RE.test(botId) &&
        isPoolCharacterId(charId)
      ) {
        map.set(botId, charId);
      }
    }
  }
  return toPlainSafeRecord(map);
}

function deskCoordEquals(a: DeskCoordinate | undefined, b: DeskCoordinate | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.x === b.x && a.y === b.y;
}

export function mergeBotWorldDocuments(
  base: BotWorldDocumentData,
  outside: BotWorldDocumentData,
  mine: BotWorldDocumentData
): BotWorldDocumentData {
  const baseTheme = isValidThemeId(base?.themeId) ? base.themeId : DEFAULT_BOTWORLD_DOCUMENT.themeId;
  const mineTheme = isValidThemeId(mine?.themeId) ? mine.themeId : baseTheme;
  const outsideTheme = isValidThemeId(outside?.themeId) ? outside.themeId : baseTheme;
  const themeId = mineTheme !== baseTheme ? mineTheme : outsideTheme;

  const baseAtm: AtmosphereMode = isValidAtmosphereMode(base?.atmosphereMode)
    ? base.atmosphereMode
    : 'auto';
  const mineAtm: AtmosphereMode = isValidAtmosphereMode(mine?.atmosphereMode)
    ? mine.atmosphereMode
    : baseAtm;
  const outsideAtm: AtmosphereMode = isValidAtmosphereMode(outside?.atmosphereMode)
    ? outside.atmosphereMode
    : baseAtm;
  const atmosphereMode = mineAtm !== baseAtm ? mineAtm : outsideAtm;

  const baseRedact =
    typeof base?.redactMode === 'boolean' ? base.redactMode : DEFAULT_BOTWORLD_DOCUMENT.redactMode;
  const mineRedact = typeof mine?.redactMode === 'boolean' ? mine.redactMode : baseRedact;
  const outsideRedact = typeof outside?.redactMode === 'boolean' ? outside.redactMode : baseRedact;
  const redactMode = mineRedact !== baseRedact ? mineRedact : outsideRedact;

  const baseSelected = sanitizeSelectedBotId(base?.selectedBotId);
  const mineSelected = sanitizeSelectedBotId(mine?.selectedBotId);
  const outsideSelected = sanitizeSelectedBotId(outside?.selectedBotId);
  const selectedBotId = mineSelected !== baseSelected ? mineSelected : outsideSelected;

  const baseApp = normalizeAppearances(base?.botAppearances);
  const outApp = normalizeAppearances(outside?.botAppearances);
  const mineApp = normalizeAppearances(mine?.botAppearances);

  const mergedAppearances = new Map<string, CharacterId>();
  const allBotIds = new Set<string>([
    ...Object.keys(baseApp),
    ...Object.keys(outApp),
    ...Object.keys(mineApp),
  ]);

  for (const botId of allBotIds) {
    if (mergedAppearances.size >= MAX_BOT_APPEARANCES) break;
    if (!isSafeKey(botId)) continue;
    const baseVal = Object.hasOwn(baseApp, botId) ? baseApp[botId] : undefined;
    const outVal = Object.hasOwn(outApp, botId) ? outApp[botId] : undefined;
    const mineVal = Object.hasOwn(mineApp, botId) ? mineApp[botId] : undefined;

    const chosen = mineVal !== baseVal ? mineVal : outVal;
    if (isPoolCharacterId(chosen)) {
      mergedAppearances.set(botId, chosen);
    }
  }

  const basePos = sanitizeCustomDeskPositions(base?.customDeskPositions);
  const outPos = sanitizeCustomDeskPositions(outside?.customDeskPositions);
  const minePos = sanitizeCustomDeskPositions(mine?.customDeskPositions);

  const mergedPositions = new Map<string, DeskCoordinate>();
  const allPosBotIds = new Set<string>([
    ...Object.keys(basePos),
    ...Object.keys(outPos),
    ...Object.keys(minePos),
  ]);

  for (const botId of allPosBotIds) {
    if (mergedPositions.size >= MAX_CUSTOM_DESK_POSITIONS) break;
    if (!isSafeKey(botId)) continue;
    const baseVal = Object.hasOwn(basePos, botId) ? basePos[botId] : undefined;
    const outVal = Object.hasOwn(outPos, botId) ? outPos[botId] : undefined;
    const mineVal = Object.hasOwn(minePos, botId) ? minePos[botId] : undefined;

    const chosen = !deskCoordEquals(mineVal, baseVal) ? mineVal : outVal;
    if (chosen !== undefined) {
      mergedPositions.set(botId, chosen);
    }
  }

  return {
    version: 1,
    themeId,
    atmosphereMode,
    redactMode,
    selectedBotId,
    botAppearances: toPlainSafeRecord(mergedAppearances),
    customDeskPositions: toPlainSafeRecord(mergedPositions),
  };
}

export function decodeBotWorldContent(content: { kind: 'text'; text: string } | { kind: 'bytes'; bytes: ArrayBuffer }): BotWorldDocumentData {
  if (content.kind !== 'text') {
    return {
      ...DEFAULT_BOTWORLD_DOCUMENT,
      botAppearances: {},
      customDeskPositions: {},
    };
  }
  return validateBotWorldDocument(content.text).data;
}

export function encodeBotWorldContent(data: BotWorldDocumentData): { kind: 'text'; text: string } {
  const safeDoc: BotWorldDocumentData = {
    version: 1,
    themeId: isValidThemeId(data.themeId) ? data.themeId : 'startup_office',
    atmosphereMode: isValidAtmosphereMode(data.atmosphereMode) ? data.atmosphereMode : 'auto',
    redactMode: typeof data.redactMode === 'boolean' ? data.redactMode : false,
    selectedBotId: sanitizeSelectedBotId(data.selectedBotId),
    botAppearances: normalizeAppearances(data.botAppearances),
    customDeskPositions: sanitizeCustomDeskPositions(data.customDeskPositions),
  };
  return {
    kind: 'text',
    text: `${JSON.stringify(safeDoc, null, 2)}\n`,
  };
}

export function startBotWorldDocSession() {
  const doc = orca.document;
  if (!doc) {
    throw new Error('This script must run inside an Orca custom editor');
  }
  return doc.session<BotWorldDocumentData>({
    decode: decodeBotWorldContent,
    encode: encodeBotWorldContent,
    merge: mergeBotWorldDocuments,
    debounceMs: 250,
  });
}
