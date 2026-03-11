export const AVATAR_GRADIENT_STORAGE_KEY = "chalk_avatar_gradient";
export const USER_SETTINGS_UPDATED_EVENT = "chalk-user-settings-updated";

export const AVATAR_GRADIENT_PRESETS = [
  { id: "ocean", label: "Ocean", start: "#3b82f6", end: "#22d3ee" },
  { id: "orchid", label: "Orchid", start: "#8b5cf6", end: "#ec4899" },
  { id: "mint", label: "Mint", start: "#10b981", end: "#14b8a6" },
  { id: "sunset", label: "Sunset", start: "#f97316", end: "#eab308" },
  { id: "iris", label: "Iris", start: "#6366f1", end: "#8b5cf6" },
  { id: "ember", label: "Ember", start: "#f43f5e", end: "#fb923c" },
] as const;

export const DEFAULT_AVATAR_GRADIENT_PREFERENCE = { mode: "derived" } as const;
export type AvatarGradientPresetId = (typeof AVATAR_GRADIENT_PRESETS)[number]["id"];

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

function hashString(value: string): number {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash);
}

function getPresetById(presetId: AvatarGradientPresetId) {
  return AVATAR_GRADIENT_PRESETS.find((preset) => preset.id === presetId);
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
  const normalizedSeed = seed?.trim();
  if (!normalizedSeed) {
    return "CU";
  }

  const isEmailSeed = normalizedSeed.includes("@");
  const localPart = isEmailSeed ? (normalizedSeed.split("@")[0] ?? normalizedSeed) : normalizedSeed;
  const segments = localPart
    .split(/[\s._-]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (isEmailSeed && segments.length <= 1) {
    return localPart.slice(0, 2).toUpperCase() || "CU";
  }

  if (segments.length === 0) {
    return localPart.slice(0, 2).toUpperCase() || "CU";
  }

  return segments
    .slice(0, 2)
    .map((segment) => segment[0] ?? "")
    .join("")
    .toUpperCase();
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

  return window.localStorage.getItem("chalk_default_name") || "";
}

export function notifyUserSettingsUpdated() {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new Event(USER_SETTINGS_UPDATED_EVENT));
}

export function getAvatarGradientCss(colors: AvatarGradientColors): string {
  return `linear-gradient(135deg, ${colors.start} 0%, ${colors.end} 100%)`;
}

export function resolveAvatarGradient(seed: string, preference: AvatarGradientPreference = DEFAULT_AVATAR_GRADIENT_PREFERENCE) {
  const derivedPreset = AVATAR_GRADIENT_PRESETS[hashString(seed) % AVATAR_GRADIENT_PRESETS.length] ?? AVATAR_GRADIENT_PRESETS[0]!;
  const selectedPreset = preference.mode === "preset" ? (getPresetById(preference.presetId) ?? derivedPreset) : derivedPreset;
  const colors = {
    start: selectedPreset.start,
    end: selectedPreset.end,
  };

  return {
    seed,
    initials: getAvatarInitials(seed),
    colors,
    css: getAvatarGradientCss(colors),
    label: preference.mode === "derived" ? `Derived from ${seed}` : selectedPreset.label,
    selection: preference.mode === "derived" ? "derived" : selectedPreset.id,
  } as const;
}
