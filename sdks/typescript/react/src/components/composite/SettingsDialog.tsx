import { Dialog } from "@base-ui/react/dialog";
import React, { useEffect, useMemo, useState } from "react";

import { usePrefersReducedMotion, useMediaQuery } from "../../internal/useMediaQuery";
import { cn } from "../../utils/cn";
import { getParticipantThemeVariables } from "../../utils/colorGenerator";
import { ArrowLeft02Icon, Cancel01Icon, Message01Icon, Microphone01Icon, Monitor01Icon, PictureInPictureIcon, Search01Icon, Settings01Icon, VolumeHighIcon } from "../../utils/icons";
import { resolvePortalThemeFromDocument } from "../../utils/theme";
import { VolumeSlider } from "../atomic";
import { getThemeMode, isDarkThemePalette, THEME_PALETTES, THEME_SKINS, THEME_TEXTURES, type ThemePalette, type ThemeSkin, type ThemeTexture } from "../theme";
import { BackgroundEffectsPicker, type BackgroundEffect } from "./BackgroundEffectsPicker";
import { DeviceSelector } from "./DeviceSelector";
import { NoiseSuppressionToggle } from "./NoiseSuppressionToggle";
import { ChalkBackdrop, ChalkButton, ChalkDialogPanel, ChalkIconButton, ChalkInput, ChalkPanel, ChalkToggle } from "../chalk-ui";
import { SkinProvider } from "../skin-context";
import { useSkin } from "../skin-context";
import { ClassicSettingsDialog } from "./ClassicSettingsDialog";

type SectionId = "audio-video" | "audio" | "video" | "appearance" | "experience";
type SelectableDevice = Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">;

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

const EMPTY_DEVICE_GROUPS = {
  audioinput: [] as SelectableDevice[],
  audiooutput: [] as SelectableDevice[],
  videoinput: [] as SelectableDevice[],
};

function mergeDevices(...deviceGroups: ReadonlyArray<readonly SelectableDevice[]>) {
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

interface SettingsDialogProps {
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
  audioInputDevices?: readonly Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">[];
  audioOutputDevices?: readonly Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">[];
  videoInputDevices?: readonly Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">[];
  audioLevel?: number;
  videoTrack?: MediaStreamTrack | null;
  reducedMotion?: boolean;
  participantColorSeed?: string;
  isDarkMode?: boolean;
  initialSection?: SectionId;
}

const SECTIONS = [
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
] as const satisfies ReadonlyArray<{
  id: SectionId;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  keywords: readonly string[];
}>;

function normalizeSection(section: SectionId): Exclude<SectionId, "audio" | "video"> {
  return section === "audio" || section === "video" ? "audio-video" : section;
}

function SectionCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section>
      <ChalkPanel className="!rounded-[10px] !border border-[var(--chalk-app-line)] bg-[var(--chalk-app-panel)] !p-3.5 shadow-none sm:!p-4">
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-[var(--chalk-app-text)]">{title}</h3>
          <p className="mt-1 text-xs text-[var(--chalk-app-text-muted)]">{description}</p>
        </div>
        <div className="space-y-3">{children}</div>
      </ChalkPanel>
    </section>
  );
}

function ToggleRow({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
  const titleId = React.useId();

  return (
    <ChalkPanel className="flex items-center justify-between gap-4 !rounded-[10px] !border border-[var(--chalk-app-line)] bg-[var(--chalk-app-panel)] !p-3">
      <div className="min-w-0 flex-1">
        <div id={titleId} className="text-sm font-medium text-[var(--chalk-app-text)]">
          {title}
        </div>
        <div className="text-xs text-[var(--chalk-app-text-muted)]">{description}</div>
      </div>
      <ChalkToggle pressed={checked} onPressedChange={onChange} aria-labelledby={titleId} />
    </ChalkPanel>
  );
}

const ChalkSettingsDialog = React.memo(
  ({
    isOpen,
    onClose,
    settings,
    onUpdateIdentity,
    onUpdateJoin,
    onUpdateAudio,
    onUpdateVideo,
    onUpdateAppearance,
    onUpdateExperience,
    enablePictureInPicture = false,
    isPictureInPictureSupported = false,
    isPictureInPictureActive = false,
    onOpenPictureInPicture,
    enableBackgroundEffects = false,
    isBackgroundEffectsSupported = false,
    isApplyingBackgroundEffect = false,
    backgroundEffects = [],
    selectedBackgroundEffectId,
    onSelectBackgroundEffect,
    onUploadBackgroundEffect,
    audioInputDevices = [],
    audioOutputDevices = [],
    videoInputDevices = [],
    audioLevel = 0,
    videoTrack,
    reducedMotion = false,
    participantColorSeed,
    isDarkMode = false,
    initialSection = "audio-video",
  }: SettingsDialogProps) => {
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
    const [activeSection, setActiveSection] = useState<SectionId>(normalizeSection(initialSection));
    const [isNavOpen, setIsNavOpen] = useState(true);
    const [searchQuery, setSearchQuery] = useState("");
    const [detectedDevices, setDetectedDevices] = useState(EMPTY_DEVICE_GROUPS);
    const effectiveParticipantSeed = useMemo(() => participantColorSeed?.trim() || settings.identity.displayName.trim() || "You", [participantColorSeed, settings.identity.displayName]);
    const effectiveAudioInputDevices = useMemo(() => mergeDevices(audioInputDevices, detectedDevices.audioinput), [audioInputDevices, detectedDevices.audioinput]);
    const effectiveAudioOutputDevices = useMemo(() => mergeDevices(audioOutputDevices, detectedDevices.audiooutput), [audioOutputDevices, detectedDevices.audiooutput]);
    const effectiveVideoInputDevices = useMemo(() => mergeDevices(videoInputDevices, detectedDevices.videoinput), [detectedDevices.videoinput, videoInputDevices]);
    const settingsChromeVariables = useMemo(() => {
      const vars = getParticipantThemeVariables(effectiveParticipantSeed, settings.appearance.profileGradient);
      return vars as React.CSSProperties;
    }, [effectiveParticipantSeed, settings.appearance.profileGradient]);

    const filteredSections = useMemo(() => {
      if (!searchQuery.trim()) {
        return SECTIONS;
      }

      const query = searchQuery.toLowerCase();
      return SECTIONS.filter((section) => {
        return section.label.toLowerCase().includes(query) || section.description.toLowerCase().includes(query) || section.keywords.some((keyword) => keyword.includes(query));
      });
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
      if (!isOpen) {
        return;
      }

      const mediaDevices = navigator.mediaDevices;
      if (!mediaDevices?.enumerateDevices) {
        return;
      }

      let isCancelled = false;

      const syncDevices = async () => {
        try {
          const devices = await mediaDevices.enumerateDevices();
          if (isCancelled) {
            return;
          }

          setDetectedDevices({
            audioinput: devices.filter((device) => device.kind === "audioinput"),
            audiooutput: devices.filter((device) => device.kind === "audiooutput"),
            videoinput: devices.filter((device) => device.kind === "videoinput"),
          });
        } catch {
          // Keep prop-driven device lists if enumeration fails.
        }
      };

      void syncDevices();
      mediaDevices.addEventListener?.("devicechange", syncDevices);

      return () => {
        isCancelled = true;
        mediaDevices.removeEventListener?.("devicechange", syncDevices);
      };
    }, [isOpen]);

    const renderSectionContent = () => {
      switch (activeSection) {
        case "audio-video":
          return (
            <div className="space-y-4 sm:space-y-5">
              <SectionCard title="Microphone" description="Choose the live input device and clean up background noise.">
                <DeviceSelector
                  type="audioinput"
                  devices={effectiveAudioInputDevices}
                  selectedDeviceId={settings.audio.selectedInput}
                  onChange={(deviceId) => onUpdateAudio({ selectedInput: deviceId })}
                  label="Input device"
                  audioLevel={audioLevel}
                  participantColorSeed={participantColorSeed}
                  participantGradientPreference={settings.appearance.profileGradient}
                />
                <NoiseSuppressionToggle enabled={settings.audio.noiseSuppression} onChange={(enabled) => onUpdateAudio({ noiseSuppression: enabled })} level="medium" />
              </SectionCard>

              <SectionCard title="Speakers" description="Route audio where you want it and tune playback volume.">
                <DeviceSelector
                  type="audiooutput"
                  devices={effectiveAudioOutputDevices}
                  selectedDeviceId={settings.audio.selectedOutput}
                  onChange={(deviceId) => onUpdateAudio({ selectedOutput: deviceId })}
                  label="Output device"
                  participantColorSeed={participantColorSeed}
                  participantGradientPreference={settings.appearance.profileGradient}
                />
                <div className="rounded-2xl border border-[var(--chalk-line)] bg-[var(--chalk-surface)] p-4">
                  <div className="mb-3 flex items-center gap-2 text-sm font-medium text-[var(--chalk-text)]">
                    <VolumeHighIcon className="h-4 w-4 text-[var(--chalk-accent)]" />
                    Output volume
                  </div>
                  <VolumeSlider value={settings.audio.outputVolume} onChange={(value) => onUpdateAudio({ outputVolume: value })} showValue />
                </div>
              </SectionCard>
              <SectionCard title="Camera" description="Pick the active camera and confirm the preview before teaching.">
                <DeviceSelector
                  type="videoinput"
                  devices={effectiveVideoInputDevices}
                  selectedDeviceId={settings.video.selectedInput}
                  onChange={(deviceId) => onUpdateVideo({ selectedInput: deviceId })}
                  label="Camera"
                  previewTrack={videoTrack}
                  participantColorSeed={participantColorSeed}
                  participantGradientPreference={settings.appearance.profileGradient}
                />
              </SectionCard>
              {enableBackgroundEffects ? (
                <SectionCard title="Background Effects" description="Blur distractions or swap in a background locally for this browser.">
                  {isBackgroundEffectsSupported ? (
                    <BackgroundEffectsPicker
                      effects={[...backgroundEffects]}
                      selectedEffectId={selectedBackgroundEffectId}
                      onSelect={onSelectBackgroundEffect ?? (() => {})}
                      onCustomUpload={onUploadBackgroundEffect}
                      disabled={isApplyingBackgroundEffect}
                      participantColorSeed={participantColorSeed}
                      participantGradientPreference={settings.appearance.profileGradient}
                    />
                  ) : (
                    <div className="rounded-2xl border border-[var(--chalk-line)] bg-[var(--chalk-surface)] p-4 text-sm text-[var(--chalk-muted-text)]">Background effects are not supported in this browser yet.</div>
                  )}
                </SectionCard>
              ) : null}
            </div>
          );
        case "appearance":
          return (
            <div className="space-y-5">
              <SectionCard title="Skin" description="Choose the shape and finish of the interface. Every skin can use any palette or texture.">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {THEME_SKINS.map((skin) => {
                    const isSelected = resolvedSkin === skin.value;
                    return (
                      <ChalkButton
                        variant="outline"
                        key={skin.value}
                        type="button"
                        onClick={() => onUpdateAppearance({ skin: skin.value })}
                        aria-pressed={isSelected}
                        className={cn(
                          "!min-h-0 !w-full !justify-start !rounded-[10px] !border !p-3 !text-left transition-colors",
                          isSelected
                            ? "border-[var(--chalk-app-control-active-line)] bg-[var(--chalk-app-control-active)] text-[var(--chalk-app-control-active-text)]"
                            : "border-[var(--chalk-app-line)] bg-[var(--chalk-app-control)] text-[var(--chalk-app-text)] hover:border-[var(--chalk-app-control-active-line)] hover:bg-[var(--chalk-app-control-hover)]",
                        )}
                      >
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold">{skin.label}</span>
                          <span className="mt-0.5 block text-[11px] leading-4 opacity-70">{skin.description}</span>
                        </span>
                      </ChalkButton>
                    );
                  })}
                </div>
              </SectionCard>

              <SectionCard title="Palette" description="Choose a complete color family. Every palette can use any material texture.">
                {(["light", "dark"] as const).map((mode) => (
                  <div key={mode} className="space-y-2.5">
                    <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--chalk-app-text-muted)]">{mode} palettes</div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {THEME_PALETTES.filter((palette) => palette.mode === mode).map((palette) => {
                        const isSelected = resolvedPalette === palette.value;
                        return (
                          <ChalkButton
                            variant="outline"
                            key={palette.value}
                            type="button"
                            onClick={() => onUpdateAppearance({ palette: palette.value, theme: palette.mode })}
                            aria-pressed={isSelected}
                            className={cn(
                              "!min-h-0 !w-full !justify-start !rounded-[10px] !border !p-3 !text-left transition-colors",
                              isSelected
                                ? "border-[var(--chalk-app-control-active-line)] bg-[var(--chalk-app-control-active)] text-[var(--chalk-app-control-active-text)]"
                                : "border-[var(--chalk-app-line)] bg-[var(--chalk-app-control)] text-[var(--chalk-app-text)] hover:border-[var(--chalk-app-control-active-line)] hover:bg-[var(--chalk-app-control-hover)]",
                            )}
                          >
                            <span className="flex shrink-0 overflow-hidden rounded-full border border-[var(--chalk-app-line)] shadow-sm" aria-hidden="true">
                              {palette.swatch.map((color) => (
                                <span key={color} className="h-7 w-3" style={{ backgroundColor: color }} />
                              ))}
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-semibold">{palette.label}</span>
                              <span className="block text-[11px] opacity-70">{palette.family} family</span>
                            </span>
                          </ChalkButton>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </SectionCard>

              <SectionCard title="Texture" description="Layer a material treatment over the selected palette without changing its colors.">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {THEME_TEXTURES.map((texture) => {
                    const isSelected = resolvedTexture === texture.value;
                    return (
                      <ChalkButton
                        variant="outline"
                        key={texture.value}
                        type="button"
                        onClick={() => onUpdateAppearance({ texture: texture.value })}
                        aria-label={`Use ${texture.label} texture`}
                        aria-pressed={isSelected}
                        className={cn(
                          "!min-h-0 !w-full !justify-start !overflow-hidden !rounded-[10px] !border !p-0 !text-left transition-colors",
                          isSelected ? "border-[var(--chalk-app-control-active-line)] text-[var(--chalk-app-control-active-text)]" : "border-[var(--chalk-app-line)] text-[var(--chalk-app-text)] hover:border-[var(--chalk-app-control-active-line)]",
                        )}
                      >
                        <span data-chalk data-chalk-theme={resolvedTheme} data-chalk-palette={resolvedPalette} data-chalk-texture={texture.value} className="chalk-root chalk-textured-surface block h-12 border-b border-[var(--chalk-app-line)] bg-[var(--chalk-app-stage)]" aria-hidden="true" />
                        <span className="block bg-[var(--chalk-app-panel)] p-2.5">
                          <span className="block text-xs font-semibold">{texture.label}</span>
                          <span className="mt-0.5 block text-[10px] leading-4 text-[var(--chalk-app-text-muted)]">{texture.description}</span>
                        </span>
                      </ChalkButton>
                    );
                  })}
                </div>
              </SectionCard>

              {usesDarkPalette && (
                <SectionCard title="Background Gradient" description="Adjust the intensity of the background gradient.">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <ChalkButton
                      variant="outline"
                      type="button"
                      onClick={() => onUpdateAppearance({ gradient: "default" })}
                      className={cn(
                        "group relative !min-h-0 !w-full !overflow-hidden !rounded-2xl !border !p-4 !text-left transition-colors",
                        settings.appearance.gradient === "default" ? "border-[var(--chalk-accent)] text-[var(--chalk-accent)]" : "border-[var(--chalk-line)] bg-[var(--chalk-surface)] text-[var(--chalk-text)] hover:border-[var(--chalk-accent)]",
                      )}
                    >
                      {settings.appearance.gradient === "default" && <div className="absolute inset-0 bg-[var(--chalk-accent)]" />}
                      <div className="absolute inset-0 opacity-20 transition-opacity group-hover:opacity-40" style={{ background: "radial-gradient(ellipse at top left, var(--chalk-accent) 0%, transparent 70%)" }} />
                      <div className="absolute inset-0 opacity-10 transition-opacity group-hover:opacity-30" style={{ background: "radial-gradient(ellipse at bottom right, var(--chalk-focus) 0%, transparent 70%)" }} />
                      <div className="relative z-10 text-sm font-semibold">Default</div>
                    </ChalkButton>
                    <ChalkButton
                      variant="outline"
                      type="button"
                      onClick={() => onUpdateAppearance({ gradient: "darker" })}
                      className={cn(
                        "group relative !min-h-0 !w-full !overflow-hidden !rounded-2xl !border !p-4 !text-left transition-colors",
                        settings.appearance.gradient === "darker" ? "border-[var(--chalk-accent)] text-[var(--chalk-accent)]" : "border-[var(--chalk-line)] bg-[var(--chalk-surface)] text-[var(--chalk-text)] hover:border-[var(--chalk-accent)]",
                      )}
                    >
                      {settings.appearance.gradient === "darker" && <div className="absolute inset-0 bg-[var(--chalk-accent)]" />}
                      <div className="absolute inset-0 opacity-5 transition-opacity group-hover:opacity-10" style={{ background: "radial-gradient(ellipse at top left, var(--chalk-accent) 0%, transparent 70%)" }} />
                      <div className="absolute inset-0 opacity-0 transition-opacity group-hover:opacity-5" style={{ background: "radial-gradient(ellipse at bottom right, var(--chalk-focus) 0%, transparent 70%)" }} />
                      <div className="relative z-10 text-sm font-semibold">Darker</div>
                    </ChalkButton>
                  </div>
                </SectionCard>
              )}

              <SectionCard title="Avatars" description="Choose whether participants without photos use generated avatars or plain initials.">
                <ToggleRow title="Generated avatars" description="Use generated avatars when no photo is set. Turn this off for plain initials." checked={settings.appearance.generatedAvatars} onChange={(checked) => onUpdateAppearance({ generatedAvatars: checked })} />
              </SectionCard>

              <SectionCard title="Motion" description="Keep movement comfortable and predictable across the interface.">
                <ToggleRow title="Reduced motion" description="Turn down transitions and ambient motion." checked={settings.appearance.reducedMotion} onChange={(checked) => onUpdateAppearance({ reducedMotion: checked })} />
              </SectionCard>
            </div>
          );
        case "experience":
          return (
            <div className="space-y-5">
              <SectionCard title="Identity & join" description="Set the name and join state Chalk should remember for this browser.">
                <div className="rounded-2xl border border-[var(--chalk-line)] bg-[var(--chalk-surface)] p-4">
                  <label htmlFor="chalk-settings-display-name" className="mb-2 block text-sm font-medium text-[var(--chalk-text)]">
                    Default display name
                  </label>
                  <ChalkInput
                    id="chalk-settings-display-name"
                    value={settings.identity.displayName}
                    onChange={(event) => onUpdateIdentity({ displayName: event.target.value })}
                    placeholder="How your name appears when you join"
                    className="!rounded-2xl !border-[var(--chalk-line)] !bg-[var(--chalk-canvas)]"
                  />
                  <p className="mt-2 text-xs text-[var(--chalk-muted-text)]">Used as the starting name in the Entrance and settings preview.</p>
                </div>
                <ToggleRow title="Join muted" description="Start with your microphone off the next time you enter a space." checked={!settings.join.audioEnabled} onChange={(checked) => onUpdateJoin({ audioEnabled: !checked })} />
                <ToggleRow title="Join with video off" description="Start with your camera off the next time you enter a space." checked={!settings.join.videoEnabled} onChange={(checked) => onUpdateJoin({ videoEnabled: !checked })} />
              </SectionCard>

              <SectionCard title="In-space defaults" description="Choose what opens by default the next time you enter a space.">
                <ToggleRow title="Show invite toast" description="Keep the share reminder visible when the space loads." checked={settings.experience.showInviteToast} onChange={(checked) => onUpdateExperience({ showInviteToast: checked })} />
                <ToggleRow title="Open chat by default" description="Start with the chat drawer open." checked={settings.experience.defaultOpenChat} onChange={(checked) => onUpdateExperience({ defaultOpenChat: checked })} />
                <ToggleRow
                  title="Open people by default"
                  description="Start with the participant list open."
                  checked={settings.experience.defaultOpenParticipants}
                  onChange={(checked) =>
                    onUpdateExperience({
                      defaultOpenParticipants: checked,
                    })
                  }
                />
                <ToggleRow
                  title="Open transcript by default"
                  description="Start with the transcript panel open."
                  checked={settings.experience.defaultOpenTranscription}
                  onChange={(checked) =>
                    onUpdateExperience({
                      defaultOpenTranscription: checked,
                    })
                  }
                />
                <ToggleRow title="Sounds" description="Play a cue when someone joins, leaves, messages, raises a hand or reacts." checked={settings.experience.sounds} onChange={(checked) => onUpdateExperience({ sounds: checked })} />
                {enablePictureInPicture ? (
                  <ToggleRow
                    title="Auto-open Picture-in-Picture"
                    description="Try to open PiP automatically when the space loads. Some browsers may wait for your first interaction."
                    checked={settings.experience.autoOpenPictureInPicture}
                    onChange={(checked) =>
                      onUpdateExperience({
                        autoOpenPictureInPicture: checked,
                      })
                    }
                  />
                ) : null}
              </SectionCard>
              {enablePictureInPicture ? (
                <SectionCard title="Picture in Picture" description="Fallback controls if automatic opening is blocked by the browser.">
                  <div className="rounded-2xl border border-[var(--chalk-line)] bg-[var(--chalk-surface)] p-4">
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-[var(--chalk-text)]">Manual open</div>
                        <div className="text-xs text-[var(--chalk-muted-text)]">
                          {isPictureInPictureSupported ? (isPictureInPictureActive ? "Picture-in-Picture is already open." : "Open PiP manually if the browser blocked automatic opening.") : "Picture-in-Picture is not supported in this browser."}
                        </div>
                      </div>
                      <PictureInPictureIcon className="h-5 w-5 shrink-0 text-[var(--chalk-accent)]" />
                    </div>
                    <ChalkButton
                      variant="solid"
                      tone="accent"
                      type="button"
                      onClick={() => {
                        void onOpenPictureInPicture?.();
                      }}
                      disabled={!isPictureInPictureSupported || isPictureInPictureActive || !onOpenPictureInPicture}
                      className={cn("!h-10 !rounded-full !px-4 !text-sm !font-medium transition-colors outline-none", "focus-visible:ring-2 focus-visible:ring-[var(--chalk-focus)] focus-visible:ring-offset-2", "disabled:cursor-not-allowed disabled:opacity-50")}
                      aria-label="Open Picture-in-Picture now"
                    >
                      Open Picture-in-Picture now
                    </ChalkButton>
                  </div>
                </SectionCard>
              ) : null}
            </div>
          );
      }
    };

    const showSidebar = isDesktop || isNavOpen;
    const showContent = isDesktop || !isNavOpen;

    return (
      <SkinProvider skin={resolvedSkin}>
        <Dialog.Root
          open={isOpen}
          onOpenChange={(open) => {
            if (!open) {
              onClose();
            }
          }}
        >
          <Dialog.Portal>
            <Dialog.Backdrop
              render={
                <ChalkBackdrop
                  data-chalk
                  data-chalk-theme={resolvedTheme}
                  data-chalk-skin={resolvedSkin}
                  data-chalk-palette={resolvedPalette}
                  data-chalk-texture={resolvedTexture}
                  className={cn("chalk-root z-[100] !bg-[var(--chalk-app-canvas)] !backdrop-blur-[1px]", !disableMotion && "animate-in fade-in duration-200")}
                />
              }
            />
            <Dialog.Popup
              data-chalk
              data-chalk-theme={resolvedTheme}
              data-chalk-skin={resolvedSkin}
              data-chalk-palette={resolvedPalette}
              data-chalk-texture={resolvedTexture}
              className={cn(
                "chalk-root chalk-textured-surface",
                "fixed inset-4 z-[101] m-auto flex max-h-[min(700px,calc(100dvh-32px))] w-auto max-w-[760px] flex-col overflow-hidden rounded-[14px] border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-chrome)] text-[var(--chalk-app-text)] shadow-[var(--chalk-app-shadow-control)] md:inset-0",
                !disableMotion && "animate-in fade-in duration-300 ease-out",
                !disableMotion && "slide-in-from-bottom-10 md:zoom-in-95",
              )}
              style={settingsChromeVariables}
            >
              <ChalkDialogPanel className="!h-full !max-h-full !w-full !max-w-none !rounded-[14px] !border-0 !bg-transparent !p-0" role="presentation">
                <Dialog.Title className="sr-only">Space settings</Dialog.Title>
                <div className="flex h-full flex-col md:flex-row">
                  <aside className={cn("flex w-full shrink-0 flex-col border-[var(--chalk-app-line)] bg-[var(--chalk-app-control-group)] md:w-48 md:border-r", !showSidebar && "hidden")}>
                    <div className="p-3 pb-2">
                      <div className="mb-5 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Settings01Icon className="h-5 w-5 text-[var(--chalk-app-text-muted)]" />
                          <div>
                            <div className="text-base font-semibold">Settings</div>
                            <div className="text-xs text-[var(--chalk-app-text-muted)]">Local to this browser</div>
                          </div>
                        </div>
                        <ChalkIconButton onClick={onClose} aria-label="Close settings" className="md:hidden">
                          <Cancel01Icon className="h-5 w-5" />
                        </ChalkIconButton>
                      </div>
                      <div className="relative">
                        <Search01Icon className="pointer-events-none absolute left-3 top-1/2 z-[2] h-4 w-4 -translate-y-1/2 text-[var(--chalk-app-text-muted)]" />
                        <ChalkInput value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search settings" className="rounded-[8px] border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-input)] pl-9" aria-label="Search settings" />
                      </div>
                    </div>
                    <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-6">
                      {filteredSections.map((section) => {
                        const Icon = section.icon;
                        return (
                          <ChalkButton
                            variant="ghost"
                            key={section.id}
                            type="button"
                            onClick={() => {
                              setActiveSection(section.id);
                              setIsNavOpen(false);
                            }}
                            className={cn(
                              "!min-h-0 !flex !w-full !items-start !justify-start !gap-2.5 !rounded-[8px] !px-3 !py-2.5 !text-left transition-colors",
                              activeSection === section.id ? "bg-[var(--chalk-app-control)] text-[var(--chalk-app-text)] shadow-[var(--chalk-app-shadow-xs)]" : "text-[var(--chalk-app-text-muted)] hover:text-[var(--chalk-app-text)]",
                            )}
                          >
                            <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                            <span className="min-w-0">
                              <span className="block text-sm font-medium">{section.label}</span>
                              <span className="block text-xs opacity-80">{section.description}</span>
                            </span>
                          </ChalkButton>
                        );
                      })}
                      {filteredSections.length === 0 && <div className="rounded-[8px] border border-dashed border-[var(--chalk-app-line)] px-4 py-8 text-center text-sm text-[var(--chalk-app-text-muted)]">No matching settings.</div>}
                    </nav>
                  </aside>

                  <div className={cn("flex min-h-0 flex-1 flex-col", !showContent && "hidden")}>
                    <div className="flex items-start justify-between border-b border-[var(--chalk-app-line)] bg-[var(--chalk-app-chrome)] px-5 py-4 md:px-6">
                      <div className="flex items-center gap-3">
                        <ChalkIconButton onClick={() => setIsNavOpen(true)} className="md:hidden" aria-label="Back to sections">
                          <ArrowLeft02Icon className="h-5 w-5" />
                        </ChalkIconButton>
                        <div>
                          <h2 className="text-lg font-semibold text-[var(--chalk-app-text)] md:text-xl">{SECTIONS.find((section) => section.id === activeSection)?.label}</h2>
                          <p className="mt-0.5 text-xs text-[var(--chalk-app-text-muted)] md:mt-1 md:text-sm">Changes apply to this device.</p>
                        </div>
                      </div>
                      <ChalkIconButton onClick={onClose} aria-label="Close settings">
                        <Cancel01Icon className="h-5 w-5" />
                      </ChalkIconButton>
                    </div>
                    <div className="chalk-textured-surface min-h-0 flex-1 overflow-y-auto bg-[var(--chalk-app-chrome)] px-5 py-5 md:px-6">
                      <div className="mx-auto max-w-[560px] pb-10 md:pb-0">{renderSectionContent()}</div>
                    </div>
                  </div>
                </div>
              </ChalkDialogPanel>
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      </SkinProvider>
    );
  },
);

ChalkSettingsDialog.displayName = "ChalkSettingsDialog";

export const SettingsDialog = React.memo((props: SettingsDialogProps): React.JSX.Element => {
  const inheritedSkin = useSkin();
  const skin = props.settings.appearance.skin ?? inheritedSkin;
  const previousSkin = React.useRef(skin);
  const switchedSkinWhileOpen = props.isOpen && previousSkin.current !== skin;

  useEffect(() => {
    previousSkin.current = skin;
  }, [skin]);

  const rendererProps = switchedSkinWhileOpen ? { ...props, initialSection: "appearance" as const } : props;

  return <SkinProvider skin={skin}>{skin === "classic" ? <ClassicSettingsDialog {...rendererProps} /> : <ChalkSettingsDialog {...rendererProps} />}</SkinProvider>;
});

SettingsDialog.displayName = "SettingsDialog";
