import { useCallback, useEffect, useMemo, useState } from "react";

import { USER_SETTINGS_UPDATED_EVENT, getAvatarSeed, readStoredDisplayName, readStoredAvatarGradientPreference, resolveAvatarGradient, writeStoredAvatarGradientPreference, type AvatarGradientPreference } from "./avatarGradient";

export function useProfileAvatar({
  displayNameOverride,
  fallbackSeed,
}: {
  displayNameOverride?: string;
  fallbackSeed?: string;
} = {}) {
  const [storedDisplayName, setStoredDisplayName] = useState(readStoredDisplayName);
  const [preference, setPreferenceState] = useState<AvatarGradientPreference>(readStoredAvatarGradientPreference);

  const syncFromStorage = useCallback(() => {
    setStoredDisplayName(readStoredDisplayName());
    setPreferenceState(readStoredAvatarGradientPreference());
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    syncFromStorage();
    window.addEventListener(USER_SETTINGS_UPDATED_EVENT, syncFromStorage);
    window.addEventListener("storage", syncFromStorage);

    return () => {
      window.removeEventListener(USER_SETTINGS_UPDATED_EVENT, syncFromStorage);
      window.removeEventListener("storage", syncFromStorage);
    };
  }, [syncFromStorage]);

  const seed = useMemo(() => getAvatarSeed(displayNameOverride ?? storedDisplayName, fallbackSeed), [displayNameOverride, fallbackSeed, storedDisplayName]);
  const resolvedAvatar = useMemo(() => resolveAvatarGradient(seed, preference), [preference, seed]);

  const setPreference = useCallback((nextPreference: AvatarGradientPreference) => {
    setPreferenceState(nextPreference);
    writeStoredAvatarGradientPreference(nextPreference);
  }, []);

  return {
    ...resolvedAvatar,
    preference,
    backgroundImage: resolvedAvatar.css,
    title: preference.mode === "derived" ? "Derived from your name" : resolvedAvatar.label,
    description: preference.mode === "derived" ? `Based on ${resolvedAvatar.seed}` : `${resolvedAvatar.label} preset`,
    gradient: resolvedAvatar.colors,
    setPreference,
    storedDisplayName,
  };
}
