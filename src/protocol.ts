import type { BotWorldStatePayload, CharacterId, ThemeId } from './types.ts';

declare module 'orca' {
  interface PluginRequests {
    'botWorld.getState': {
      input?: { sinceMs?: number };
      output: BotWorldStatePayload;
    };
    'botWorld.refresh': {
      output: BotWorldStatePayload;
    };
    'botWorld.setTheme': {
      input: { themeId: string };
      output: { themeId: ThemeId };
    };
    'botWorld.setRedactMode': {
      input: { redactMode: boolean };
      output: { redactMode: boolean };
    };
    'botWorld.setBotAppearance': {
      input: { botId: string; characterId: string };
      output: { botAppearances: Record<string, CharacterId> };
    };
  }

  interface PluginPanelEvents {
    'botWorld.stateUpdated': BotWorldStatePayload;
  }
}

export {};
