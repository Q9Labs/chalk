import { useCallback, useEffect, useMemo, useState } from "react";

import type { MeetingLayout } from "../components/full/meeting-room/types";
import { DEFAULT_STORED_VIDEO_BACKGROUND_EFFECT, type StoredVideoBackgroundEffect, type VideoBackgroundPresetId } from "../utils/videoBackgrounds";

export interface MeetingRoomSettings {
  version: number;
  audio: {
    selectedInput?: string;
    selectedOutput?: string;
    outputVolume: number;
    noiseSuppression: boolean;
  };
  video: {
    selectedInput?: string;
    backgroundEffect: StoredVideoBackgroundEffect;
  };
  appearance: {
    theme: "light" | "dark" | "system";
    gradient: "default" | "darker";
    profileGradient: {
      mode: "auto" | "custom";
      from?: string;
      to?: string;
    };
    layout: MeetingLayout;
    showFilmstrip: boolean;
    reducedMotion: boolean;
    ambientBackground: boolean;
  };
  experience: {
    showInviteToast: boolean;
    defaultOpenChat: boolean;
    defaultOpenParticipants: boolean;
    defaultOpenTranscription: boolean;
    autoOpenPictureInPicture: boolean;
  };
}

interface StoredMeetingRoomSettings {
  version: number;
  audio?: Partial<MeetingRoomSettings["audio"]>;
  video?: Partial<MeetingRoomSettings["video"]>;
  appearance?: Omit<Partial<MeetingRoomSettings["appearance"]>, "profileGradient"> & {
    profileGradient?: Partial<MeetingRoomSettings["appearance"]["profileGradient"]>;
  };
  experience?: Partial<MeetingRoomSettings["experience"]>;
}

interface UseMeetingRoomSettingsOptions {
  defaults?: Omit<StoredMeetingRoomSettings, "version">;
}

const SETTINGS_KEY = "chalk-meeting-settings";
const SETTINGS_VERSION = 5;
const SUPPORTED_SETTINGS_VERSIONS = new Set([SETTINGS_VERSION, 4, 3, 2]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function withDefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function isVideoBackgroundPresetId(value: unknown): value is VideoBackgroundPresetId {
  return typeof value === "string" && value.startsWith("preset-");
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function sanitizeStoredVideoBackgroundEffect(value: unknown): StoredVideoBackgroundEffect | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }

  if (value.type === "none") {
    return { type: "none" };
  }

  if (value.type === "blur") {
    return {
      type: "blur",
      blurStrength: typeof value.blurStrength === "number" ? value.blurStrength : undefined,
    };
  }

  if (value.type === "preset" && isVideoBackgroundPresetId(value.presetId)) {
    return {
      type: "preset",
      presetId: value.presetId,
    };
  }

  if (value.type === "custom" && typeof value.assetKey === "string") {
    return {
      type: "custom",
      assetKey: value.assetKey,
      fileName: typeof value.fileName === "string" ? value.fileName : undefined,
    };
  }

  return undefined;
}

function sanitizeStoredSettings(value: unknown): StoredMeetingRoomSettings | null {
  if (!isRecord(value)) {
    return null;
  }

  const version = value.version;
  if (!SUPPORTED_SETTINGS_VERSIONS.has(Number(version))) {
    return null;
  }

  const audio = isRecord(value.audio) ? value.audio : undefined;
  const video = isRecord(value.video) ? value.video : undefined;
  const appearance = isRecord(value.appearance) ? value.appearance : undefined;
  const experience = isRecord(value.experience) ? value.experience : undefined;

  return {
    version: SETTINGS_VERSION,
    audio: audio
      ? withDefined({
          selectedInput: typeof audio.selectedInput === "string" ? audio.selectedInput : undefined,
          selectedOutput: typeof audio.selectedOutput === "string" ? audio.selectedOutput : undefined,
          outputVolume: typeof audio.outputVolume === "number" ? audio.outputVolume : undefined,
          noiseSuppression: typeof audio.noiseSuppression === "boolean" ? audio.noiseSuppression : undefined,
        })
      : undefined,
    video: video
      ? withDefined({
          selectedInput: typeof video.selectedInput === "string" ? video.selectedInput : undefined,
          backgroundEffect: sanitizeStoredVideoBackgroundEffect(video.backgroundEffect),
        })
      : undefined,
    appearance: appearance
      ? withDefined({
          theme: appearance.theme === "light" || appearance.theme === "dark" || appearance.theme === "system" ? appearance.theme : undefined,
          gradient: appearance.gradient === "default" || appearance.gradient === "darker" ? appearance.gradient : undefined,
          profileGradient: isRecord(appearance.profileGradient)
            ? withDefined({
                mode: appearance.profileGradient.mode === "auto" || appearance.profileGradient.mode === "custom" ? appearance.profileGradient.mode : undefined,
                from: isHexColor(appearance.profileGradient.from) ? appearance.profileGradient.from : undefined,
                to: isHexColor(appearance.profileGradient.to) ? appearance.profileGradient.to : undefined,
              })
            : undefined,
          layout: appearance.layout === "grid" || appearance.layout === "spotlight" || appearance.layout === "sidebar" ? appearance.layout : undefined,
          showFilmstrip: typeof appearance.showFilmstrip === "boolean" ? appearance.showFilmstrip : undefined,
          reducedMotion: typeof appearance.reducedMotion === "boolean" ? appearance.reducedMotion : undefined,
          ambientBackground: typeof appearance.ambientBackground === "boolean" ? appearance.ambientBackground : undefined,
        })
      : undefined,
    experience: experience
      ? withDefined({
          showInviteToast: typeof experience.showInviteToast === "boolean" ? experience.showInviteToast : undefined,
          defaultOpenChat: typeof experience.defaultOpenChat === "boolean" ? experience.defaultOpenChat : undefined,
          defaultOpenParticipants: typeof experience.defaultOpenParticipants === "boolean" ? experience.defaultOpenParticipants : undefined,
          defaultOpenTranscription: typeof experience.defaultOpenTranscription === "boolean" ? experience.defaultOpenTranscription : undefined,
          autoOpenPictureInPicture: typeof experience.autoOpenPictureInPicture === "boolean" ? experience.autoOpenPictureInPicture : undefined,
        })
      : undefined,
  };
}

const createDefaultSettings = (defaults?: UseMeetingRoomSettingsOptions["defaults"]): MeetingRoomSettings => {
  const defaultAppearance = defaults?.appearance;

  return {
    version: SETTINGS_VERSION,
    audio: {
      outputVolume: 100,
      noiseSuppression: true,
      ...defaults?.audio,
    },
    video: {
      backgroundEffect: DEFAULT_STORED_VIDEO_BACKGROUND_EFFECT,
      ...defaults?.video,
    },
    appearance: {
      theme: defaultAppearance?.theme ?? "system",
      gradient: defaultAppearance?.gradient ?? "default",
      profileGradient: {
        mode: defaultAppearance?.profileGradient?.mode ?? "auto",
        from: defaultAppearance?.profileGradient?.from,
        to: defaultAppearance?.profileGradient?.to,
      },
      layout: defaultAppearance?.layout ?? "grid",
      showFilmstrip: defaultAppearance?.showFilmstrip ?? true,
      reducedMotion: defaultAppearance?.reducedMotion ?? false,
      ambientBackground: defaultAppearance?.ambientBackground ?? true,
    },
    experience: {
      showInviteToast: true,
      defaultOpenChat: false,
      defaultOpenParticipants: false,
      defaultOpenTranscription: false,
      autoOpenPictureInPicture: true,
      ...defaults?.experience,
    },
  };
};

const mergeSettings = (base: MeetingRoomSettings, stored: StoredMeetingRoomSettings | null): MeetingRoomSettings => {
  if (!stored) {
    return base;
  }

  return {
    ...base,
    ...stored,
    audio: { ...base.audio, ...stored.audio },
    video: { ...base.video, ...stored.video },
    appearance: {
      ...base.appearance,
      ...stored.appearance,
      profileGradient: {
        ...base.appearance.profileGradient,
        ...stored.appearance?.profileGradient,
        mode: stored.appearance?.profileGradient?.mode ?? base.appearance.profileGradient.mode,
      },
    },
    experience: { ...base.experience, ...stored.experience },
  };
};

export function useMeetingRoomSettings({ defaults }: UseMeetingRoomSettingsOptions = {}) {
  const baseSettings = useMemo(() => createDefaultSettings(defaults), [defaults]);

  const [settings, setSettings] = useState<MeetingRoomSettings>(() => {
    if (typeof window === "undefined") {
      return baseSettings;
    }

    try {
      const stored = localStorage.getItem(SETTINGS_KEY);
      if (!stored) {
        return baseSettings;
      }

      return mergeSettings(baseSettings, sanitizeStoredSettings(JSON.parse(stored)));
    } catch {
      try {
        localStorage.removeItem(SETTINGS_KEY);
      } catch {
        // Ignore storage cleanup failures.
      }
      return baseSettings;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleSync = () => {
      try {
        const stored = localStorage.getItem(SETTINGS_KEY);
        if (stored) {
          setSettings(() => mergeSettings(baseSettings, sanitizeStoredSettings(JSON.parse(stored))));
        }
      } catch {
        // Ignore
      }
    };

    const handleStorage = (e: StorageEvent) => {
      if (e.key === SETTINGS_KEY) handleSync();
    };

    window.addEventListener("chalk-settings-updated", handleSync);
    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener("chalk-settings-updated", handleSync);
      window.removeEventListener("storage", handleStorage);
    };
  }, [baseSettings]);

  const persist = useCallback((next: MeetingRoomSettings) => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      window.dispatchEvent(new Event("chalk-settings-updated"));
    } catch {
      // Ignore storage failures; keep the in-memory settings usable.
    }
  }, []);

  const updateSettings = useCallback(
    (updater: Partial<MeetingRoomSettings> | ((previous: MeetingRoomSettings) => MeetingRoomSettings)) => {
      setSettings((previous) => {
        const next =
          typeof updater === "function"
            ? updater(previous)
            : {
                ...previous,
                ...updater,
              };

        persist(next);
        return next;
      });
    },
    [persist],
  );

  const updateAudioSettings = useCallback(
    (updates: Partial<MeetingRoomSettings["audio"]>) => {
      updateSettings((previous) => ({
        ...previous,
        audio: { ...previous.audio, ...updates },
      }));
    },
    [updateSettings],
  );

  const updateVideoSettings = useCallback(
    (updates: Partial<MeetingRoomSettings["video"]>) => {
      updateSettings((previous) => ({
        ...previous,
        video: { ...previous.video, ...updates },
      }));
    },
    [updateSettings],
  );

  const updateAppearanceSettings = useCallback(
    (updates: Partial<MeetingRoomSettings["appearance"]>) => {
      updateSettings((previous) => ({
        ...previous,
        appearance: { ...previous.appearance, ...updates },
      }));
    },
    [updateSettings],
  );

  const updateExperienceSettings = useCallback(
    (updates: Partial<MeetingRoomSettings["experience"]>) => {
      updateSettings((previous) => ({
        ...previous,
        experience: { ...previous.experience, ...updates },
      }));
    },
    [updateSettings],
  );

  return {
    settings,
    updateSettings,
    updateAudioSettings,
    updateVideoSettings,
    updateAppearanceSettings,
    updateExperienceSettings,
  };
}
