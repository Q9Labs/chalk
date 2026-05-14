import { useCallback, useEffect, useState } from "react";

import type { MeetingLayout } from "../components/full/meeting-room/types";
import { DEFAULT_STORED_VIDEO_BACKGROUND_EFFECT, type StoredVideoBackgroundEffect, type VideoBackgroundPresetId } from "../utils/videoBackgrounds";

export interface MeetingRoomSettings {
  version: number;
  identity: {
    displayName: string;
  };
  join: {
    audioEnabled: boolean;
    videoEnabled: boolean;
  };
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
    generatedAvatars: boolean;
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
  identity?: Partial<MeetingRoomSettings["identity"]>;
  join?: Partial<MeetingRoomSettings["join"]>;
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
const SETTINGS_VERSION = 7;
const SUPPORTED_SETTINGS_VERSIONS = new Set([SETTINGS_VERSION, 6, 5, 4, 3, 2]);
const LEGACY_DISPLAY_NAME_KEY = "chalk_default_name";
const LEGACY_JOIN_MUTED_KEY = "chalk_join_muted";
const LEGACY_JOIN_NO_VIDEO_KEY = "chalk_join_no_video";
const LEGACY_SESSION_DISPLAY_NAME_KEY = "chalk_display_name";

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

function getBrowserStorage(kind: "localStorage" | "sessionStorage") {
  const globalStorage = globalThis[kind] as Storage | undefined;
  if (globalStorage) {
    return globalStorage;
  }

  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    return window[kind] ?? undefined;
  } catch {
    return undefined;
  }
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

  const identity = isRecord(value.identity) ? value.identity : undefined;
  const join = isRecord(value.join) ? value.join : undefined;
  const audio = isRecord(value.audio) ? value.audio : undefined;
  const video = isRecord(value.video) ? value.video : undefined;
  const appearance = isRecord(value.appearance) ? value.appearance : undefined;
  const experience = isRecord(value.experience) ? value.experience : undefined;

  return {
    version: SETTINGS_VERSION,
    identity: identity
      ? withDefined({
          displayName: typeof identity.displayName === "string" ? identity.displayName : undefined,
        })
      : undefined,
    join: join
      ? withDefined({
          audioEnabled: typeof join.audioEnabled === "boolean" ? join.audioEnabled : undefined,
          videoEnabled: typeof join.videoEnabled === "boolean" ? join.videoEnabled : undefined,
        })
      : undefined,
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
          generatedAvatars: typeof appearance.generatedAvatars === "boolean" ? appearance.generatedAvatars : undefined,
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

function readLegacySettings(): Omit<StoredMeetingRoomSettings, "version"> {
  const local = getBrowserStorage("localStorage");
  const session = getBrowserStorage("sessionStorage");
  if (!local && !session) {
    return {};
  }

  const localDisplayName = local?.getItem(LEGACY_DISPLAY_NAME_KEY);
  const sessionDisplayName = session?.getItem(LEGACY_SESSION_DISPLAY_NAME_KEY);
  const storedMuted = local?.getItem(LEGACY_JOIN_MUTED_KEY);
  const storedNoVideo = local?.getItem(LEGACY_JOIN_NO_VIDEO_KEY);

  return withDefined({
    identity: withDefined({
      displayName: localDisplayName ?? sessionDisplayName ?? undefined,
    }),
    join: withDefined({
      audioEnabled: storedMuted === null ? undefined : storedMuted !== "true",
      videoEnabled: storedNoVideo === null ? undefined : storedNoVideo !== "true",
    }),
  });
}

const createDefaultSettings = (defaults?: UseMeetingRoomSettingsOptions["defaults"]): MeetingRoomSettings => {
  const defaultAppearance = defaults?.appearance;

  return {
    version: SETTINGS_VERSION,
    identity: {
      displayName: defaults?.identity?.displayName ?? "",
    },
    join: {
      audioEnabled: defaults?.join?.audioEnabled ?? false,
      videoEnabled: defaults?.join?.videoEnabled ?? false,
    },
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
      generatedAvatars: defaultAppearance?.generatedAvatars ?? true,
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

const mergeSettings = (base: MeetingRoomSettings, ...partials: ReadonlyArray<Omit<StoredMeetingRoomSettings, "version"> | StoredMeetingRoomSettings | null | undefined>): MeetingRoomSettings => {
  return partials.reduce<MeetingRoomSettings>((current, partial) => {
    if (!partial) {
      return current;
    }

    return {
      ...current,
      identity: {
        ...current.identity,
        ...partial.identity,
      },
      join: {
        ...current.join,
        ...partial.join,
      },
      audio: {
        ...current.audio,
        ...partial.audio,
      },
      video: {
        ...current.video,
        ...partial.video,
      },
      appearance: {
        ...current.appearance,
        ...partial.appearance,
        profileGradient: {
          ...current.appearance.profileGradient,
          ...partial.appearance?.profileGradient,
          mode: partial.appearance?.profileGradient?.mode ?? current.appearance.profileGradient.mode,
        },
      },
      experience: {
        ...current.experience,
        ...partial.experience,
      },
    };
  }, base);
};

export function getStoredMeetingRoomSettings(defaults?: UseMeetingRoomSettingsOptions["defaults"]): MeetingRoomSettings {
  const baseSettings = createDefaultSettings(defaults);
  const local = getBrowserStorage("localStorage");
  if (!local) {
    return baseSettings;
  }

  const legacySettings = readLegacySettings();

  try {
    const stored = local.getItem(SETTINGS_KEY);
    if (!stored) {
      return mergeSettings(baseSettings, legacySettings);
    }

    return mergeSettings(baseSettings, legacySettings, sanitizeStoredSettings(JSON.parse(stored)));
  } catch {
    try {
      local.removeItem(SETTINGS_KEY);
    } catch {
      // Ignore storage cleanup failures.
    }
    return mergeSettings(baseSettings, legacySettings);
  }
}

function clearLegacySettings() {
  const local = getBrowserStorage("localStorage");
  if (!local) {
    return;
  }

  try {
    local.removeItem(LEGACY_DISPLAY_NAME_KEY);
    local.removeItem(LEGACY_JOIN_MUTED_KEY);
    local.removeItem(LEGACY_JOIN_NO_VIDEO_KEY);
  } catch {
    // Ignore storage cleanup failures.
  }
}

export function useMeetingRoomSettings({ defaults }: UseMeetingRoomSettingsOptions = {}) {
  const [settings, setSettings] = useState<MeetingRoomSettings>(() => getStoredMeetingRoomSettings(defaults));

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleSync = () => {
      setSettings(() => getStoredMeetingRoomSettings(defaults));
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key === SETTINGS_KEY || event.key === LEGACY_DISPLAY_NAME_KEY || event.key === LEGACY_JOIN_MUTED_KEY || event.key === LEGACY_JOIN_NO_VIDEO_KEY) {
        handleSync();
      }
    };

    window.addEventListener("chalk-settings-updated", handleSync);
    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener("chalk-settings-updated", handleSync);
      window.removeEventListener("storage", handleStorage);
    };
  }, [defaults]);

  const persist = useCallback((next: MeetingRoomSettings) => {
    const local = getBrowserStorage("localStorage");
    if (typeof window === "undefined" || !local) {
      return;
    }

    try {
      local.setItem(SETTINGS_KEY, JSON.stringify(next));
      clearLegacySettings();
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

  const updateIdentitySettings = useCallback(
    (updates: Partial<MeetingRoomSettings["identity"]>) => {
      updateSettings((previous) => ({
        ...previous,
        identity: { ...previous.identity, ...updates },
      }));
    },
    [updateSettings],
  );

  const updateJoinSettings = useCallback(
    (updates: Partial<MeetingRoomSettings["join"]>) => {
      updateSettings((previous) => ({
        ...previous,
        join: { ...previous.join, ...updates },
      }));
    },
    [updateSettings],
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
    updateIdentitySettings,
    updateJoinSettings,
    updateAudioSettings,
    updateVideoSettings,
    updateAppearanceSettings,
    updateExperienceSettings,
  };
}
