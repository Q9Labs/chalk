import { getParticipantAvatarGradient, getParticipantAvatarRecipe, getParticipantInitials, PARTICIPANT_GRADIENT_PRESETS, type ParticipantGradientPreference } from "@q9labs/chalk-core";

export const AVATAR_GRADIENT_STORAGE_KEY = "chalk_avatar_gradient";
export const USER_SETTINGS_UPDATED_EVENT = "chalk-user-settings-updated";
const SDK_MEETING_SETTINGS_STORAGE_KEY = "chalk-meeting-settings";

export const AVATAR_GRADIENT_PRESETS = PARTICIPANT_GRADIENT_PRESETS.map((preset) => ({
  id: preset.id,
  label: preset.label,
  start: preset.from,
  end: preset.to,
}));

export const DEFAULT_AVATAR_GRADIENT_PREFERENCE = { mode: "derived" } as const;
export type AvatarGradientPresetId = (typeof PARTICIPANT_GRADIENT_PRESETS)[number]["id"];

export type AvatarGradientColors = {
  start: string;
  end: string;
};

export type AvatarGradientPreference =
  | typeof DEFAULT_AVATAR_GRADIENT_PREFERENCE
  | {
      mode: "preset";
      presetId: AvatarGradientPresetId;
    };

function getPresetById(presetId: AvatarGradientPresetId) {
  return AVATAR_GRADIENT_PRESETS.find((preset) => preset.id === presetId);
}

function toSdkGradientPreference(preference: AvatarGradientPreference): ParticipantGradientPreference | undefined {
  if (preference.mode !== "preset") {
    return undefined;
  }

  const preset = getPresetById(preference.presetId);
  if (!preset) {
    return undefined;
  }

  return {
    mode: "custom",
    from: preset.start,
    to: preset.end,
  };
}

export function getAvatarSeed(displayName?: string, fallback?: string): string {
  const normalizedDisplayName = displayName?.trim();
  if (normalizedDisplayName) {
    return normalizedDisplayName;
  }

  const normalizedFallback = fallback?.trim();
  if (normalizedFallback) {
    return normalizedFallback;
  }

  return "Chalk User";
}

export function getAvatarInitials(seed?: string): string {
  const initials = getParticipantInitials(seed);
  return initials === "?" ? "CU" : initials;
}

export function sanitizeAvatarGradientPreference(value: unknown): AvatarGradientPreference {
  if (value && typeof value === "object" && "mode" in value) {
    const mode = (value as { mode?: unknown }).mode;

    if (mode === "derived") {
      return DEFAULT_AVATAR_GRADIENT_PREFERENCE;
    }

    if (mode === "preset") {
      const presetId = (value as { presetId?: unknown }).presetId;

      if (typeof presetId === "string" && getPresetById(presetId as AvatarGradientPresetId)) {
        return {
          mode: "preset",
          presetId: presetId as AvatarGradientPresetId,
        };
      }
    }
  }

  return DEFAULT_AVATAR_GRADIENT_PREFERENCE;
}

export function readStoredAvatarGradientPreference(): AvatarGradientPreference {
  if (typeof window === "undefined") {
    return DEFAULT_AVATAR_GRADIENT_PREFERENCE;
  }

  try {
    const stored = window.localStorage.getItem(AVATAR_GRADIENT_STORAGE_KEY);
    if (!stored) {
      return DEFAULT_AVATAR_GRADIENT_PREFERENCE;
    }

    return sanitizeAvatarGradientPreference(JSON.parse(stored));
  } catch {
    return DEFAULT_AVATAR_GRADIENT_PREFERENCE;
  }
}

export function writeStoredAvatarGradientPreference(preference: AvatarGradientPreference) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(AVATAR_GRADIENT_STORAGE_KEY, JSON.stringify(preference));
  window.dispatchEvent(new Event(USER_SETTINGS_UPDATED_EVENT));
}

export function readStoredDisplayName() {
  if (typeof window === "undefined") {
    return "";
  }

  try {
    const storedSettings = window.localStorage.getItem(SDK_MEETING_SETTINGS_STORAGE_KEY);
    if (storedSettings) {
      const parsed = JSON.parse(storedSettings) as {
        identity?: {
          displayName?: string;
        };
      };
      const displayName = parsed.identity?.displayName?.trim();
      if (displayName) {
        return displayName;
      }
    }
  } catch {
    // Ignore malformed SDK settings and fall back to the legacy key.
  }

  return window.localStorage.getItem("chalk_default_name") || "";
}

export function notifyUserSettingsUpdated() {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new Event(USER_SETTINGS_UPDATED_EVENT));
  window.dispatchEvent(new Event("chalk-settings-updated"));
}

export function getAvatarGradientCss(colors: AvatarGradientColors): string {
  return getParticipantAvatarGradient("Chalk User", {
    mode: "custom",
    from: colors.start,
    to: colors.end,
  });
}

export function resolveAvatarGradient(seed: string, preference: AvatarGradientPreference = DEFAULT_AVATAR_GRADIENT_PREFERENCE) {
  const sdkPreference = toSdkGradientPreference(preference);
  const avatarRecipe = getParticipantAvatarRecipe(seed, sdkPreference);
  const selectedPreset = preference.mode === "preset" ? getPresetById(preference.presetId) : undefined;
  const colors = {
    start: avatarRecipe.colors.primary,
    end: avatarRecipe.colors.gradientEnd,
  };

  return {
    seed,
    initials: avatarRecipe.initials === "?" ? "CU" : avatarRecipe.initials,
    colors,
    css: avatarRecipe.avatarGradient,
    label: preference.mode === "derived" || !selectedPreset ? `Derived from ${seed}` : selectedPreset.label,
    selection: preference.mode === "derived" || !selectedPreset ? "derived" : selectedPreset.id,
  } as const;
}
