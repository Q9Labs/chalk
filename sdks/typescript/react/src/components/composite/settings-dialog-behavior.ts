import { useEffect, useMemo, useState } from "react";
import type React from "react";

import { useMediaQuery, usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { getParticipantThemeVariables } from "../../utils/colorGenerator";
import { Message01Icon, Microphone01Icon, Monitor01Icon } from "../../utils/icons";
import { resolvePortalThemeFromDocument } from "../../utils/theme";
import { getThemeMode, isDarkThemePalette, type ThemeMode, type ThemePalette, type ThemeSkin, type ThemeTexture } from "../theme";
import { useSkin } from "../skin-context";
import type { BackgroundEffect } from "./BackgroundEffectsPicker";

export type SettingsSectionId = "audio-video" | "audio" | "video" | "appearance" | "experience";

export interface SettingsDialogValue {
  identity: {
    displayName: string;
  };
  join: {
    videoEnabled: boolean;
    audioEnabled: boolean;
  };
  audio: {
    selectedInput?: string;
    selectedOutput?: string;
    outputVolume: number;
    noiseSuppression: boolean;
    echoCancellation: boolean;
    autoGainControl: boolean;
  };
  video: {
    selectedInput?: string;
    quality: string;
  };
  appearance: {
    layout: string;
    theme: "light" | "dark" | "system";
    skin?: ThemeSkin;
    palette?: ThemePalette;
    texture?: ThemeTexture;
    gradient: "default" | "darker";
    showFilmstrip: boolean;
    reducedMotion: boolean;
    generatedAvatars: boolean;
    profileGradient: {
      mode: "auto" | "custom";
      from?: string;
      to?: string;
    };
    ambientBackground: boolean;
  };
  experience: {
    captions: boolean;
    compactMode: boolean;
    showInviteToast: boolean;
    defaultOpenChat: boolean;
    defaultOpenParticipants: boolean;
    defaultOpenTranscription: boolean;
    autoOpenPictureInPicture: boolean;
    /** Join, leave, message, hand-raise and reaction cues. */
    sounds: boolean;
  };
}

type SelectableDevice = Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">;

export interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  settings: SettingsDialogValue;
  onUpdateIdentity: (updates: Partial<SettingsDialogValue["identity"]>) => void;
  onUpdateJoin: (updates: Partial<SettingsDialogValue["join"]>) => void;
  onUpdateAudio: (updates: Partial<SettingsDialogValue["audio"]>) => void;
  onUpdateVideo: (updates: Partial<SettingsDialogValue["video"]>) => void;
  onUpdateAppearance: (updates: Partial<SettingsDialogValue["appearance"]>) => void;
  onUpdateExperience: (updates: Partial<SettingsDialogValue["experience"]>) => void;
  enablePictureInPicture?: boolean;
  isPictureInPictureSupported?: boolean;
  isPictureInPictureActive?: boolean;
  onOpenPictureInPicture?: () => Promise<void> | void;
  enableBackgroundEffects?: boolean;
  isBackgroundEffectsSupported?: boolean;
  isApplyingBackgroundEffect?: boolean;
  backgroundEffects?: readonly BackgroundEffect[];
  selectedBackgroundEffectId?: string;
  onSelectBackgroundEffect?: (effectId: string) => void;
  onUploadBackgroundEffect?: (file: File) => void;
  audioInputDevices?: readonly SelectableDevice[];
  audioOutputDevices?: readonly SelectableDevice[];
  videoInputDevices?: readonly SelectableDevice[];
  audioLevel?: number;
  videoTrack?: MediaStreamTrack | null;
  reducedMotion?: boolean;
  participantColorSeed?: string;
  isDarkMode?: boolean;
  initialSection?: SettingsSectionId;
}

interface SettingsSection {
  readonly id: SettingsSectionId;
  readonly label: string;
  readonly description: string;
  readonly icon: React.ComponentType<{ className?: string }>;
  readonly keywords: readonly string[];
}

export const SETTINGS_SECTIONS = [
  {
    id: "audio-video",
    label: "Audio & video",
    description: "Microphone, speakers, camera",
    icon: Microphone01Icon,
    keywords: ["audio", "video", "mic", "microphone", "speaker", "volume", "noise", "camera", "preview", "background", "blur"],
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Skin, palette, texture, avatars",
    icon: Monitor01Icon,
    keywords: ["theme", "skin", "classic", "chalk", "palette", "texture", "paper", "slate", "motion", "dark", "light", "color", "avatar", "facehash", "generated", "initials", "fun"],
  },
  {
    id: "experience",
    label: "Experience",
    description: "Picture-in-Picture and device extras",
    icon: Message01Icon,
    keywords: ["picture", "picture-in-picture", "pip"],
  },
] as const satisfies readonly SettingsSection[];

interface DeviceGroups {
  readonly audioinput: SelectableDevice[];
  readonly audiooutput: SelectableDevice[];
  readonly videoinput: SelectableDevice[];
}

const EMPTY_DEVICE_GROUPS: DeviceGroups = {
  audioinput: [],
  audiooutput: [],
  videoinput: [],
};

function mergeDevices(...deviceGroups: ReadonlyArray<readonly SelectableDevice[]>): SelectableDevice[] {
  const devicesById = new Map<string, SelectableDevice>();

  for (const deviceGroup of deviceGroups) {
    for (const device of deviceGroup) {
      const existingDevice = devicesById.get(device.deviceId);
      if (!existingDevice || (!existingDevice.label && device.label)) {
        devicesById.set(device.deviceId, device);
      }
    }
  }

  return Array.from(devicesById.values());
}

function normalizeSection(section: SettingsSectionId): Exclude<SettingsSectionId, "audio" | "video"> {
  return section === "audio" || section === "video" ? "audio-video" : section;
}

interface SettingsDialogBehaviorOptions {
  readonly isOpen: boolean;
  readonly settings: SettingsDialogValue;
  readonly audioInputDevices: readonly SelectableDevice[];
  readonly audioOutputDevices: readonly SelectableDevice[];
  readonly videoInputDevices: readonly SelectableDevice[];
  readonly reducedMotion: boolean;
  readonly participantColorSeed?: string;
  readonly isDarkMode: boolean;
  readonly initialSection: SettingsSectionId;
}

interface SettingsDialogBehavior {
  readonly disableMotion: boolean;
  readonly isDesktop: boolean;
  readonly resolvedSkin: ThemeSkin;
  readonly resolvedPalette: ThemePalette;
  readonly resolvedTexture: ThemeTexture;
  readonly resolvedTheme: ThemeMode;
  readonly usesDarkPalette: boolean;
  readonly activeSection: SettingsSectionId;
  readonly setActiveSection: React.Dispatch<React.SetStateAction<SettingsSectionId>>;
  readonly isNavOpen: boolean;
  readonly setIsNavOpen: React.Dispatch<React.SetStateAction<boolean>>;
  readonly searchQuery: string;
  readonly setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  readonly effectiveAudioInputDevices: readonly SelectableDevice[];
  readonly effectiveAudioOutputDevices: readonly SelectableDevice[];
  readonly effectiveVideoInputDevices: readonly SelectableDevice[];
  readonly settingsChromeVariables: React.CSSProperties;
  readonly filteredSections: readonly SettingsSection[];
}

export function useSettingsDialogBehavior({ isOpen, settings, audioInputDevices, audioOutputDevices, videoInputDevices, reducedMotion, participantColorSeed, isDarkMode, initialSection }: SettingsDialogBehaviorOptions): SettingsDialogBehavior {
  const prefersReducedMotion = usePrefersReducedMotion();
  const portalTheme = resolvePortalThemeFromDocument();
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const disableMotion = prefersReducedMotion || reducedMotion;
  const fallbackPalette: ThemePalette = settings.appearance.theme === "dark" || (settings.appearance.theme === "system" && portalTheme === "dark") ? "warm-charcoal" : "light";
  const inheritedSkin = useSkin();
  const resolvedSkin = settings.appearance.skin ?? inheritedSkin;
  const resolvedPalette = settings.appearance.palette ?? fallbackPalette;
  const resolvedTexture = settings.appearance.texture ?? "none";
  const resolvedTheme = getThemeMode(resolvedPalette);
  const usesDarkPalette = isDarkMode || isDarkThemePalette(resolvedPalette);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(normalizeSection(initialSection));
  const [isNavOpen, setIsNavOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [detectedDevices, setDetectedDevices] = useState(EMPTY_DEVICE_GROUPS);
  const effectiveParticipantSeed = useMemo(() => participantColorSeed?.trim() || settings.identity.displayName.trim() || "You", [participantColorSeed, settings.identity.displayName]);
  const effectiveAudioInputDevices = useMemo(() => mergeDevices(audioInputDevices, detectedDevices.audioinput), [audioInputDevices, detectedDevices.audioinput]);
  const effectiveAudioOutputDevices = useMemo(() => mergeDevices(audioOutputDevices, detectedDevices.audiooutput), [audioOutputDevices, detectedDevices.audiooutput]);
  const effectiveVideoInputDevices = useMemo(() => mergeDevices(videoInputDevices, detectedDevices.videoinput), [detectedDevices.videoinput, videoInputDevices]);
  const settingsChromeVariables = useMemo(() => getParticipantThemeVariables(effectiveParticipantSeed, settings.appearance.profileGradient), [effectiveParticipantSeed, settings.appearance.profileGradient]);
  const filteredSections = useMemo(() => {
    if (!searchQuery.trim()) {
      return SETTINGS_SECTIONS;
    }

    const query = searchQuery.toLowerCase();
    return SETTINGS_SECTIONS.filter((section) => section.label.toLowerCase().includes(query) || section.description.toLowerCase().includes(query) || section.keywords.some((keyword) => keyword.includes(query)));
  }, [searchQuery]);

  useEffect(() => {
    if (!filteredSections.some((section) => section.id === activeSection)) {
      setActiveSection(filteredSections[0]?.id ?? "audio-video");
    }
  }, [activeSection, filteredSections]);

  useEffect(() => {
    if (isOpen) {
      setIsNavOpen(true);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices) return;

    let isCancelled = false;

    const syncDevices = async () => {
      try {
        const devices = await mediaDevices.enumerateDevices();
        if (isCancelled) return;

        setDetectedDevices({
          audioinput: devices.filter((device) => device.kind === "audioinput"),
          audiooutput: devices.filter((device) => device.kind === "audiooutput"),
          videoinput: devices.filter((device) => device.kind === "videoinput"),
        });
      } catch {
        // Prop-driven device lists remain authoritative when browser enumeration fails.
      }
    };

    void syncDevices();
    mediaDevices.addEventListener?.("devicechange", syncDevices);

    return () => {
      isCancelled = true;
      mediaDevices.removeEventListener?.("devicechange", syncDevices);
    };
  }, [isOpen]);

  return {
    disableMotion,
    isDesktop,
    resolvedSkin,
    resolvedPalette,
    resolvedTexture,
    resolvedTheme,
    usesDarkPalette,
    activeSection,
    setActiveSection,
    isNavOpen,
    setIsNavOpen,
    searchQuery,
    setSearchQuery,
    effectiveAudioInputDevices,
    effectiveAudioOutputDevices,
    effectiveVideoInputDevices,
    settingsChromeVariables,
    filteredSections,
  };
}
