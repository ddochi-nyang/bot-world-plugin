import type {
  AtmosphereMode,
  BotWorldStatePayload,
  CharacterId,
  LanguageSetting,
  SoundMode,
  ThemeId,
  UiLocale,
  WeatherMode,
} from './types.ts';

declare module 'orca' {
  interface PluginRequests {
    'botWorld.getState': {
      input?: { sinceMs?: number; locale?: string };
      output: BotWorldStatePayload;
    };
    'botWorld.refresh': {
      input?: { locale?: string };
      output: BotWorldStatePayload;
    };
    'botWorld.setTheme': {
      input: { themeId: string };
      output: { themeId: ThemeId };
    };
    'botWorld.setAtmosphereMode': {
      input: { atmosphereMode: AtmosphereMode };
      output: { atmosphereMode: AtmosphereMode };
    };
    'botWorld.setWeatherMode': {
      input: { weatherMode: WeatherMode };
      output: { weatherMode: WeatherMode };
    };
    'botWorld.setSoundMode': {
      input: { soundMode: SoundMode };
      output: { soundMode: SoundMode };
    };
    'botWorld.setRedactMode': {
      input: { redactMode: boolean };
      output: { redactMode: boolean };
    };
    'botWorld.setBotAppearance': {
      input: { botId: string; characterId: string };
      output: { botAppearances: Record<string, CharacterId> };
    };
    'botWorld.setLanguage': {
      input: { language: LanguageSetting; hostLocale?: string };
      output: { languageSetting: LanguageSetting; locale: UiLocale };
    };
  }

  interface PluginPanelEvents {
    'botWorld.stateUpdated': BotWorldStatePayload;
  }
}

export {};
