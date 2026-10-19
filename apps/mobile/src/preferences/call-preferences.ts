import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ColorScheme } from "@q9labsai/chalk-react-native";
import { useCallback, useEffect, useState } from "react";

export const CALL_PREFERENCES_STORAGE_KEY = "chalk.mobile.call-preferences.v1";

export type CallPreferences = {
  readonly colorScheme: ColorScheme;
  readonly soundsEnabled: boolean;
};

export interface CallPreferencesStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** The call opens dark with sounds on until the person picks otherwise. */
export const DEFAULT_CALL_PREFERENCES: CallPreferences = { colorScheme: "dark", soundsEnabled: true };

export function parseCallPreferences(value: string | null): CallPreferences {
  if (!value) return DEFAULT_CALL_PREFERENCES;

  try {
    const parsed = JSON.parse(value) as { colorScheme?: unknown; soundsEnabled?: unknown };
    return {
      colorScheme: parsed.colorScheme === "light" ? "light" : "dark",
      soundsEnabled: parsed.soundsEnabled !== false,
    };
  } catch {
    return DEFAULT_CALL_PREFERENCES;
  }
}

export async function loadCallPreferences(storage: CallPreferencesStorage = AsyncStorage): Promise<CallPreferences> {
  return parseCallPreferences(await storage.getItem(CALL_PREFERENCES_STORAGE_KEY));
}

export async function saveCallPreferences(preferences: CallPreferences, storage: CallPreferencesStorage = AsyncStorage): Promise<void> {
  await storage.setItem(CALL_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
}

export type StoredCallPreferences = CallPreferences & {
  readonly setColorScheme: (colorScheme: ColorScheme) => void;
  readonly setSoundsEnabled: (enabled: boolean) => void;
};

/**
 * The stored call preferences, or `null` while they load. Render `Chalk` only once this is set,
 * so a person who chose Light never sees a dark first frame.
 */
export function useCallPreferences(onError: (cause: unknown) => void): StoredCallPreferences | null {
  const [preferences, setPreferences] = useState<CallPreferences | null>(null);

  useEffect(() => {
    let mounted = true;
    void loadCallPreferences()
      .catch((cause: unknown) => {
        onError(cause);
        return DEFAULT_CALL_PREFERENCES;
      })
      .then((loaded) => {
        if (mounted) setPreferences(loaded);
      });
    return () => {
      mounted = false;
    };
  }, [onError]);

  const update = useCallback(
    (change: Partial<CallPreferences>) => {
      const next = { ...(preferences ?? DEFAULT_CALL_PREFERENCES), ...change };
      setPreferences(next);
      saveCallPreferences(next).catch(onError);
    },
    [onError, preferences],
  );
  const setColorScheme = useCallback((colorScheme: ColorScheme) => update({ colorScheme }), [update]);
  const setSoundsEnabled = useCallback((soundsEnabled: boolean) => update({ soundsEnabled }), [update]);

  return preferences ? { ...preferences, setColorScheme, setSoundsEnabled } : null;
}
