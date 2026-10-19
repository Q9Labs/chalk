import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { ColorScheme } from "../theme/tokens";

/** Choices the person makes inside the call. The app stores them; `Chalk` reports every change. */
export type CallPreferences = {
  readonly colorScheme: ColorScheme;
  readonly setColorScheme: (scheme: ColorScheme) => void;
  readonly soundsEnabled: boolean;
  readonly setSoundsEnabled: (enabled: boolean) => void;
};

const PreferencesContext = createContext<CallPreferences | null>(null);

type ProviderProps = {
  readonly colorScheme?: ColorScheme;
  readonly onColorSchemeChange?: (scheme: ColorScheme) => void;
  readonly soundsEnabled?: boolean;
  readonly onSoundsEnabledChange?: (enabled: boolean) => void;
  readonly children: (preferences: CallPreferences) => ReactNode;
};

/** Each preference is controlled when its prop is set, and kept inside the call otherwise. */
export function PreferencesProvider({ colorScheme, onColorSchemeChange, soundsEnabled, onSoundsEnabledChange, children }: ProviderProps): React.JSX.Element {
  const [ownScheme, setOwnScheme] = useState<ColorScheme>("dark");
  const [ownSounds, setOwnSounds] = useState(true);
  const setColorScheme = useCallback(
    (scheme: ColorScheme) => {
      setOwnScheme(scheme);
      onColorSchemeChange?.(scheme);
    },
    [onColorSchemeChange],
  );
  const setSoundsEnabled = useCallback(
    (enabled: boolean) => {
      setOwnSounds(enabled);
      onSoundsEnabledChange?.(enabled);
    },
    [onSoundsEnabledChange],
  );
  const value = useMemo<CallPreferences>(() => ({ colorScheme: colorScheme ?? ownScheme, setColorScheme, soundsEnabled: soundsEnabled ?? ownSounds, setSoundsEnabled }), [colorScheme, ownScheme, ownSounds, setColorScheme, setSoundsEnabled, soundsEnabled]);
  return <PreferencesContext.Provider value={value}>{children(value)}</PreferencesContext.Provider>;
}

export function usePreferences(): CallPreferences {
  const preferences = useContext(PreferencesContext);
  if (!preferences) throw new Error("usePreferences must be used inside <Chalk>.");
  return preferences;
}
