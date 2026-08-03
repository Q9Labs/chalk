import { Dialog } from "@base-ui/react/dialog";
import React, { useCallback, useEffect, useMemo, useState } from "react";

import { usePrefersReducedMotion, useMediaQuery } from "../../internal/useMediaQuery";
import { cn } from "../../utils/cn";
import { getParticipantAvatarRecipe, getParticipantColor, getParticipantThemeVariables, PARTICIPANT_GRADIENT_PRESETS } from "../../utils/colorGenerator";
import { ArrowLeft02Icon, Cancel01Icon, ColumnIcon, LayoutGridIcon, LayoutTableIcon, Message01Icon, Microphone01Icon, Monitor01Icon, PictureInPictureIcon, Search01Icon, Settings01Icon, SparklesIcon, Video01Icon, VolumeHighIcon } from "../../utils/icons";
import { resolvePortalThemeFromDocument } from "../../utils/theme";
import { IconButton, Input, Toggle, VolumeSlider } from "../atomic";
import { getThemeMode, isDarkThemePalette, THEME_PALETTES, THEME_TEXTURES, type ThemePalette, type ThemeTexture } from "../theme";
import { BackgroundEffectsPicker, type BackgroundEffect } from "./BackgroundEffectsPicker";
import { DeviceSelector } from "./DeviceSelector";
import { NoiseSuppressionToggle } from "./NoiseSuppressionToggle";

type SectionId = "audio" | "video" | "appearance" | "experience";
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
}

const SECTIONS = [
  {
    id: "audio",
    label: "Audio",
    description: "Microphone, speakers, volume",
    icon: Microphone01Icon,
    keywords: ["mic", "microphone", "speaker", "volume", "noise"],
  },
  {
    id: "video",
    label: "Video",
    description: "Camera, preview, backgrounds",
    icon: Video01Icon,
    keywords: ["video", "camera", "preview", "background", "blur"],
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Palette, texture, layout",
    icon: Monitor01Icon,
    keywords: ["theme", "palette", "texture", "paper", "slate", "layout", "filmstrip", "motion", "dark", "light", "color", "gradient", "profile", "avatar", "facehash", "generated", "initials", "fun"],
  },
  {
    id: "experience",
    label: "Experience",
    description: "Identity, startup panels, invites",
    icon: Message01Icon,
    keywords: ["name", "identity", "join", "mute", "video", "chat", "invite", "transcript", "startup", "defaults"],
  },
] as const satisfies ReadonlyArray<{
  id: SectionId;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  keywords: readonly string[];
}>;

function SectionCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[10px] border border-[var(--chalk-app-line)] bg-[var(--chalk-app-panel)] p-4 shadow-none sm:p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-[var(--chalk-app-text)]">{title}</h3>
        <p className="mt-1 text-xs text-[var(--chalk-app-text-muted)]">{description}</p>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function ToggleRow({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
  const titleId = React.useId();

  return (
    <div className="flex items-center justify-between gap-4 rounded-[10px] border border-[var(--chalk-app-line)] bg-[var(--chalk-app-panel)] p-4">
      <div className="min-w-0 flex-1">
        <div id={titleId} className="text-sm font-medium text-[var(--chalk-app-text)]">
          {title}
        </div>
        <div className="text-xs text-[var(--chalk-app-text-muted)]">{description}</div>
      </div>
      <Toggle checked={checked} onChange={onChange} ariaLabelledby={titleId} />
    </div>
  );
}

export const SettingsDialog = React.memo(
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
  }: SettingsDialogProps) => {
    const prefersReducedMotion = usePrefersReducedMotion();
    const portalTheme = resolvePortalThemeFromDocument();
    const isDesktop = useMediaQuery("(min-width: 768px)");
    const disableMotion = prefersReducedMotion || reducedMotion;
    const fallbackPalette: ThemePalette = settings.appearance.theme === "dark" || (settings.appearance.theme === "system" && portalTheme === "dark") ? "warm-charcoal" : "light";
    const resolvedPalette = settings.appearance.palette ?? fallbackPalette;
    const resolvedTexture = settings.appearance.texture ?? "none";
    const resolvedTheme = getThemeMode(resolvedPalette);
    const usesDarkPalette = isDarkMode || isDarkThemePalette(resolvedPalette);
    const [activeSection, setActiveSection] = useState<SectionId>("audio");
    const [isNavOpen, setIsNavOpen] = useState(true);
    const [searchQuery, setSearchQuery] = useState("");
    const [detectedDevices, setDetectedDevices] = useState(EMPTY_DEVICE_GROUPS);
    const effectiveParticipantSeed = useMemo(() => participantColorSeed?.trim() || settings.identity.displayName.trim() || "You", [participantColorSeed, settings.identity.displayName]);
    const autoProfileColors = useMemo(() => getParticipantColor(effectiveParticipantSeed), [effectiveParticipantSeed]);
    const profileGradient = settings.appearance.profileGradient;
    const profileGradientMode = profileGradient.mode;
    const resolvedProfileFrom = profileGradient.from ?? autoProfileColors.primary;
    const resolvedProfileTo = profileGradient.to ?? autoProfileColors.gradientEnd;
    const selectedProfileGradientPreset = useMemo(() => PARTICIPANT_GRADIENT_PRESETS.find((preset) => preset.from.toLowerCase() === resolvedProfileFrom.toLowerCase() && preset.to.toLowerCase() === resolvedProfileTo.toLowerCase()) ?? null, [resolvedProfileFrom, resolvedProfileTo]);
    const profilePreviewRecipe = useMemo(() => getParticipantAvatarRecipe(effectiveParticipantSeed, { mode: profileGradientMode, from: resolvedProfileFrom, to: resolvedProfileTo }), [effectiveParticipantSeed, profileGradientMode, resolvedProfileFrom, resolvedProfileTo]);
    const effectiveAudioInputDevices = useMemo(() => mergeDevices(audioInputDevices, detectedDevices.audioinput), [audioInputDevices, detectedDevices.audioinput]);
    const effectiveAudioOutputDevices = useMemo(() => mergeDevices(audioOutputDevices, detectedDevices.audiooutput), [audioOutputDevices, detectedDevices.audiooutput]);
    const effectiveVideoInputDevices = useMemo(() => mergeDevices(videoInputDevices, detectedDevices.videoinput), [detectedDevices.videoinput, videoInputDevices]);
    const settingsChromeVariables = useMemo(() => {
      const vars = getParticipantThemeVariables(effectiveParticipantSeed, settings.appearance.profileGradient);
      return vars as React.CSSProperties;
    }, [effectiveParticipantSeed, settings.appearance.profileGradient]);

    const selectProfileGradientPreset = useCallback(
      (from: string, to: string) => {
        onUpdateAppearance({
          profileGradient: {
            mode: "custom",
            from,
            to,
          },
        });
      },
      [onUpdateAppearance],
    );

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
        setActiveSection(filteredSections[0]?.id ?? "audio");
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
        case "audio":
          return (
            <div className="space-y-5">
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
                <div className="rounded-2xl border border-border/50 bg-card/60 p-4">
                  <div className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
                    <VolumeHighIcon className="h-4 w-4 text-primary" />
                    Output volume
                  </div>
                  <VolumeSlider value={settings.audio.outputVolume} onChange={(value) => onUpdateAudio({ outputVolume: value })} showValue />
                </div>
              </SectionCard>
            </div>
          );
        case "video":
          return (
            <div className="space-y-5">
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
                    <div className="rounded-2xl border border-border/50 bg-card/60 p-4 text-sm text-muted-foreground">Background effects are not supported in this browser yet.</div>
                  )}
                </SectionCard>
              ) : null}
            </div>
          );
        case "appearance":
          return (
            <div className="space-y-5">
              <SectionCard title="Palette" description="Choose a complete color family. Every palette can use any material texture.">
                {(["light", "dark"] as const).map((mode) => (
                  <div key={mode} className="space-y-2.5">
                    <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground/80">{mode} palettes</div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {THEME_PALETTES.filter((palette) => palette.mode === mode).map((palette) => {
                        const isSelected = resolvedPalette === palette.value;
                        return (
                          <button
                            key={palette.value}
                            type="button"
                            onClick={() => onUpdateAppearance({ palette: palette.value, theme: palette.mode })}
                            aria-pressed={isSelected}
                            className={cn("flex items-center gap-3 rounded-[10px] border p-3 text-left transition-colors", isSelected ? "border-primary bg-primary/10 text-primary" : "border-border bg-card text-foreground hover:border-primary/50 hover:bg-muted/50")}
                          >
                            <span className="flex shrink-0 overflow-hidden rounded-full border border-black/10 shadow-sm" aria-hidden="true">
                              {palette.swatch.map((color) => (
                                <span key={color} className="h-7 w-3" style={{ backgroundColor: color }} />
                              ))}
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-semibold">{palette.label}</span>
                              <span className="block text-[11px] opacity-70">{palette.family} family</span>
                            </span>
                          </button>
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
                      <button
                        key={texture.value}
                        type="button"
                        onClick={() => onUpdateAppearance({ texture: texture.value })}
                        aria-label={`Use ${texture.label} texture`}
                        aria-pressed={isSelected}
                        className={cn("overflow-hidden rounded-[10px] border text-left transition-colors", isSelected ? "border-primary text-primary" : "border-border text-foreground hover:border-primary/50")}
                      >
                        <span data-chalk data-chalk-theme={resolvedTheme} data-chalk-palette={resolvedPalette} data-chalk-texture={texture.value} className="chalk-root chalk-textured-surface block h-12 border-b border-[var(--chalk-app-line)] bg-[var(--chalk-app-stage)]" aria-hidden="true" />
                        <span className="block bg-[var(--chalk-app-panel)] p-2.5">
                          <span className="block text-xs font-semibold">{texture.label}</span>
                          <span className="mt-0.5 block text-[10px] leading-4 text-[var(--chalk-app-text-muted)]">{texture.description}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </SectionCard>

              {usesDarkPalette && (
                <SectionCard title="Background Gradient" description="Adjust the intensity of the background gradient.">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => onUpdateAppearance({ gradient: "default" })}
                      className={cn("group relative overflow-hidden rounded-2xl border p-4 text-left transition-colors", settings.appearance.gradient === "default" ? "border-primary text-primary" : "border-border/50 bg-card/60 text-foreground hover:border-primary/40")}
                    >
                      {settings.appearance.gradient === "default" && <div className="absolute inset-0 bg-primary/10" />}
                      <div className="absolute inset-0 opacity-20 transition-opacity group-hover:opacity-40" style={{ background: "radial-gradient(ellipse at top left, var(--primary) 0%, transparent 70%)" }} />
                      <div className="absolute inset-0 opacity-10 transition-opacity group-hover:opacity-30" style={{ background: "radial-gradient(ellipse at bottom right, var(--accent) 0%, transparent 70%)" }} />
                      <div className="relative z-10 text-sm font-semibold">Default</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => onUpdateAppearance({ gradient: "darker" })}
                      className={cn("group relative overflow-hidden rounded-2xl border p-4 text-left transition-colors", settings.appearance.gradient === "darker" ? "border-primary text-primary" : "border-border/50 bg-card/60 text-foreground hover:border-primary/40")}
                    >
                      {settings.appearance.gradient === "darker" && <div className="absolute inset-0 bg-primary/10" />}
                      <div className="absolute inset-0 opacity-5 transition-opacity group-hover:opacity-10" style={{ background: "radial-gradient(ellipse at top left, var(--primary) 0%, transparent 70%)" }} />
                      <div className="absolute inset-0 opacity-0 transition-opacity group-hover:opacity-5" style={{ background: "radial-gradient(ellipse at bottom right, var(--accent) 0%, transparent 70%)" }} />
                      <div className="relative z-10 text-sm font-semibold">Darker</div>
                    </button>
                  </div>
                </SectionCard>
              )}

              <SectionCard title="Profile Gradient" description="Personalize how you appear to others in the room. Default follows your name.">
                <div className="rounded-2xl border border-border/50 bg-card/60 p-4">
                  <div className="mb-4 flex items-center gap-4">
                    <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl text-xl font-bold text-white shadow-lg ring-1 ring-white/20" style={{ background: profilePreviewRecipe.avatarGradient }} aria-hidden="true">
                      {profilePreviewRecipe.initials}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-bold text-foreground">{participantColorSeed?.trim() || "You"}</div>
                      <div className="text-xs text-muted-foreground">{profileGradientMode === "auto" ? "Currently dynamic based on your name" : selectedProfileGradientPreset ? `Using the "${selectedProfileGradientPreset.label}" preset` : "Using a custom pinned colorway"}</div>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <button
                      type="button"
                      onClick={() => onUpdateAppearance({ profileGradient: { mode: "auto" } })}
                      aria-label="Use automatic profile gradient"
                      className={cn(
                        "flex w-full items-center justify-between rounded-xl border p-3.5 transition-all",
                        profileGradientMode === "auto" ? "border-primary bg-primary/10 text-primary shadow-sm shadow-primary/10" : "border-border/50 bg-muted/40 text-muted-foreground hover:border-primary/40 hover:text-foreground",
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <div className={cn("flex h-8 w-8 items-center justify-center rounded-lg border", profileGradientMode === "auto" ? "border-primary/30 bg-primary/20" : "border-border/60 bg-background")}>
                          <SparklesIcon className="h-4 w-4" />
                        </div>
                        <div className="text-left text-sm font-semibold">Automatic Identity</div>
                      </div>
                      {profileGradientMode === "auto" && <div className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary-foreground">Active</div>}
                    </button>

                    <div className="space-y-3">
                      <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground/80">Color Presets</div>
                      <div className="grid grid-cols-4 gap-3 sm:grid-cols-6" role="radiogroup" aria-label="Profile gradient presets">
                        {PARTICIPANT_GRADIENT_PRESETS.map((preset) => {
                          const isSelected = profileGradientMode === "custom" && preset.id === selectedProfileGradientPreset?.id;

                          return (
                            <button
                              key={preset.id}
                              type="button"
                              onClick={() => selectProfileGradientPreset(preset.from, preset.to)}
                              aria-label={`Use ${preset.label} profile gradient`}
                              aria-pressed={isSelected}
                              className={cn("group relative flex aspect-square w-full items-center justify-center rounded-xl border shadow-sm transition-all", isSelected ? "border-primary ring-2 ring-primary/30 ring-offset-2 ring-offset-background" : "border-border/60 hover:border-primary/40")}
                              style={{ background: `linear-gradient(135deg, ${preset.from} 0%, ${preset.to} 100%)` }}
                            >
                              <span className="pointer-events-none absolute -bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-[10px] font-medium text-background opacity-0 transition-opacity group-hover:opacity-100">{preset.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              </SectionCard>

              <SectionCard title="Layout" description="Persist the room composition you want to land in first.">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {(
                    [
                      ["grid", LayoutGridIcon, "Grid"],
                      ["focus", LayoutTableIcon, "Spotlight"],
                      ["focus", ColumnIcon, "Sidebar"],
                    ] as const
                  ).map(([value, Icon, label]) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => onUpdateAppearance({ layout: value })}
                      className={cn("rounded-2xl border p-4 text-left transition-colors", settings.appearance.layout === value ? "border-primary bg-primary/10 text-primary" : "border-border/50 bg-card/60 text-foreground hover:border-primary/40")}
                    >
                      <Icon className="mb-3 h-5 w-5" />
                      <div className="text-sm font-semibold">{label}</div>
                    </button>
                  ))}
                </div>
                <ToggleRow title="Show filmstrip" description="Keep the participant strip visible by default." checked={settings.appearance.showFilmstrip} onChange={(checked) => onUpdateAppearance({ showFilmstrip: checked })} />
                <ToggleRow title="Fun avatars" description="Use generated FaceHash avatars when no photo is set. Turn this off for plain initials." checked={settings.appearance.generatedAvatars} onChange={(checked) => onUpdateAppearance({ generatedAvatars: checked })} />
                <ToggleRow title="Ambient background" description="Show a glowing animated gradient behind the meeting room." checked={settings.appearance.ambientBackground} onChange={(checked) => onUpdateAppearance({ ambientBackground: checked })} />
                <ToggleRow title="Reduced motion" description="Turn down transitions and ambient motion." checked={settings.appearance.reducedMotion} onChange={(checked) => onUpdateAppearance({ reducedMotion: checked })} />
              </SectionCard>
            </div>
          );
        case "experience":
          return (
            <div className="space-y-5">
              <SectionCard title="Identity & join" description="Set the name and join state Chalk should remember for this browser.">
                <div className="rounded-2xl border border-border/50 bg-card/60 p-4">
                  <label htmlFor="chalk-settings-display-name" className="mb-2 block text-sm font-medium text-foreground">
                    Default display name
                  </label>
                  <Input id="chalk-settings-display-name" value={settings.identity.displayName} onChange={(event) => onUpdateIdentity({ displayName: event.target.value })} placeholder="How your name appears when you join" fullWidth className="rounded-2xl border-border/50 bg-background/80" />
                  <p className="mt-2 text-xs text-muted-foreground">Used as the starting name in the lobby and settings preview.</p>
                </div>
                <ToggleRow title="Join muted" description="Start with your microphone off the next time you enter a room." checked={!settings.join.audioEnabled} onChange={(checked) => onUpdateJoin({ audioEnabled: !checked })} />
                <ToggleRow title="Join with video off" description="Start with your camera off the next time you enter a room." checked={!settings.join.videoEnabled} onChange={(checked) => onUpdateJoin({ videoEnabled: !checked })} />
              </SectionCard>

              <SectionCard title="In-room defaults" description="Choose what opens by default the next time you enter a room.">
                <ToggleRow title="Show invite toast" description="Keep the share reminder visible when the room loads." checked={settings.experience.showInviteToast} onChange={(checked) => onUpdateExperience({ showInviteToast: checked })} />
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
                {enablePictureInPicture ? (
                  <ToggleRow
                    title="Auto-open Picture-in-Picture"
                    description="Try to open PiP automatically when the meeting loads. Some browsers may wait for your first interaction."
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
                  <div className="rounded-2xl border border-border/50 bg-card/60 p-4">
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-foreground">Manual open</div>
                        <div className="text-xs text-muted-foreground">{isPictureInPictureSupported ? (isPictureInPictureActive ? "Picture-in-Picture is already open." : "Open PiP manually if the browser blocked automatic opening.") : "Picture-in-Picture is not supported in this browser."}</div>
                      </div>
                      <PictureInPictureIcon className="h-5 w-5 shrink-0 text-primary" />
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        void onOpenPictureInPicture?.();
                      }}
                      disabled={!isPictureInPictureSupported || isPictureInPictureActive || !onOpenPictureInPicture}
                      className={cn(
                        "inline-flex h-10 items-center justify-center rounded-full px-4 text-sm font-medium transition-colors outline-none",
                        "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
                        "disabled:cursor-not-allowed disabled:opacity-50",
                        "bg-primary text-primary-foreground hover:bg-primary/90",
                      )}
                      aria-label="Open Picture-in-Picture now"
                    >
                      Open Picture-in-Picture now
                    </button>
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
      <Dialog.Root
        open={isOpen}
        onOpenChange={(open) => {
          if (!open) {
            onClose();
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className={cn("fixed inset-0 z-[100] bg-[#0c0e12]/20 backdrop-blur-[1px]", !disableMotion && "animate-in fade-in duration-200")} />
          <Dialog.Popup
            data-chalk
            data-chalk-theme={resolvedTheme}
            data-chalk-palette={resolvedPalette}
            data-chalk-texture={resolvedTexture}
            className={cn(
              "chalk-root chalk-textured-surface",
              "fixed inset-4 z-[101] m-auto flex max-h-[min(680px,calc(100dvh-32px))] w-auto max-w-[720px] flex-col overflow-hidden rounded-[14px] border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-chrome)] text-[var(--chalk-app-text)] shadow-[var(--chalk-app-shadow-control)] md:inset-0",
              !disableMotion && "animate-in fade-in duration-300 ease-out",
              !disableMotion && "slide-in-from-bottom-10 md:zoom-in-95",
            )}
            style={settingsChromeVariables}
          >
            <Dialog.Title className="sr-only">Meeting settings</Dialog.Title>
            <div className="flex h-full flex-col md:flex-row">
              <aside className={cn("flex w-full shrink-0 flex-col border-[var(--chalk-app-line)] bg-[var(--chalk-app-control-group)] md:w-44 md:border-r", !showSidebar && "hidden")}>
                <div className="p-3 pb-2">
                  <div className="mb-5 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Settings01Icon className="h-5 w-5 text-[var(--chalk-app-text-muted)]" />
                      <div>
                        <div className="text-base font-semibold">Settings</div>
                        <div className="text-xs text-[var(--chalk-app-text-muted)]">Local to this browser</div>
                      </div>
                    </div>
                    <IconButton icon={<Cancel01Icon className="h-5 w-5" />} variant="ghost" onClick={onClose} aria-label="Close settings" className="md:hidden" />
                  </div>
                  <Input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search settings"
                    icon={<Search01Icon className="h-4 w-4" />}
                    fullWidth
                    className="rounded-[8px] border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-input)]"
                    aria-label="Search settings"
                  />
                </div>
                <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-6">
                  {filteredSections.map((section) => {
                    const Icon = section.icon;
                    return (
                      <button
                        key={section.id}
                        type="button"
                        onClick={() => {
                          setActiveSection(section.id);
                          setIsNavOpen(false);
                        }}
                        className={cn(
                          "flex w-full items-start gap-2.5 rounded-[8px] px-3 py-2.5 text-left transition-colors",
                          activeSection === section.id ? "bg-[var(--chalk-app-control)] text-[var(--chalk-app-text)] shadow-[var(--chalk-app-shadow-xs)]" : "text-[var(--chalk-app-text-muted)] hover:text-[var(--chalk-app-text)]",
                        )}
                      >
                        <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium">{section.label}</span>
                          <span className="block text-xs opacity-80">{section.description}</span>
                        </span>
                      </button>
                    );
                  })}
                  {filteredSections.length === 0 && <div className="rounded-[8px] border border-dashed border-[var(--chalk-app-line)] px-4 py-8 text-center text-sm text-[var(--chalk-app-text-muted)]">No matching settings.</div>}
                </nav>
              </aside>

              <div className={cn("flex min-h-0 flex-1 flex-col", !showContent && "hidden")}>
                <div className="flex items-start justify-between border-b border-[var(--chalk-app-line)] bg-[var(--chalk-app-chrome)] px-5 py-4 md:px-6">
                  <div className="flex items-center gap-3">
                    <IconButton icon={<ArrowLeft02Icon className="h-5 w-5" />} variant="ghost" onClick={() => setIsNavOpen(true)} className="md:hidden" aria-label="Back to sections" />
                    <div>
                      <h2 className="text-lg font-semibold text-[var(--chalk-app-text)] md:text-xl">{SECTIONS.find((section) => section.id === activeSection)?.label}</h2>
                      <p className="mt-0.5 text-xs text-[var(--chalk-app-text-muted)] md:mt-1 md:text-sm">Changes apply to this device.</p>
                    </div>
                  </div>
                  <IconButton icon={<Cancel01Icon className="h-5 w-5" />} variant="ghost" onClick={onClose} aria-label="Close settings" />
                </div>
                <div className="chalk-textured-surface min-h-0 flex-1 overflow-y-auto bg-[var(--chalk-app-chrome)] px-5 py-5 md:px-6">
                  <div className="mx-auto max-w-[560px] pb-10 md:pb-0">{renderSectionContent()}</div>
                </div>
              </div>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    );
  },
);

SettingsDialog.displayName = "SettingsDialog";
