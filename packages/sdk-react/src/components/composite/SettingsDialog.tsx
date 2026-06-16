import { Dialog } from "@base-ui/react/dialog";
import React, { useCallback, useEffect, useMemo, useState } from "react";

import type { MeetingRoomSettings } from "../../hooks/useMeetingRoomSettings";
import { usePrefersReducedMotion, useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../utils/cn";
import { getParticipantAvatarRecipe, getParticipantColor, getParticipantThemeVariables, PARTICIPANT_GRADIENT_PRESETS } from "../../utils/colorGenerator";
import { ArrowLeft02Icon, Cancel01Icon, ColumnIcon, LayoutGridIcon, LayoutTableIcon, Message01Icon, Microphone01Icon, Monitor01Icon, Moon02Icon, PictureInPictureIcon, Search01Icon, Settings01Icon, SparklesIcon, Sun02Icon, Video01Icon, VolumeHighIcon } from "../../utils/icons";
import { resolvePortalThemeFromDocument } from "../../utils/theme";
import { IconButton, Input, Toggle, VolumeSlider } from "../atomic";
import { BackgroundEffectsPicker, type BackgroundEffect } from "./BackgroundEffectsPicker";
import { DeviceSelector } from "./DeviceSelector";
import { NoiseSuppressionToggle } from "./NoiseSuppressionToggle";

type SectionId = "audio" | "video" | "appearance" | "experience";
type SelectableDevice = Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">;

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
  settings: MeetingRoomSettings;
  onUpdateIdentity: (updates: Partial<MeetingRoomSettings["identity"]>) => void;
  onUpdateJoin: (updates: Partial<MeetingRoomSettings["join"]>) => void;
  onUpdateAudio: (updates: Partial<MeetingRoomSettings["audio"]>) => void;
  onUpdateVideo: (updates: Partial<MeetingRoomSettings["video"]>) => void;
  onUpdateAppearance: (updates: Partial<MeetingRoomSettings["appearance"]>) => void;
  onUpdateExperience: (updates: Partial<MeetingRoomSettings["experience"]>) => void;
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
    description: "Theme, layout, motion",
    icon: Monitor01Icon,
    keywords: ["theme", "layout", "filmstrip", "motion", "dark", "light", "color", "gradient", "profile", "avatar", "facehash", "generated", "initials", "fun"],
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
    <section className="rounded-3xl border border-border/50 bg-background/70 p-4 shadow-sm sm:p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function ToggleRow({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
  const titleId = React.useId();

  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl border border-border/50 bg-card/60 p-4">
      <div className="min-w-0 flex-1">
        <div id={titleId} className="text-sm font-medium text-foreground">
          {title}
        </div>
        <div className="text-xs text-muted-foreground">{description}</div>
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
              <SectionCard title="Theme" description="Switch the room between light, dark, or follow the system.">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {(
                    [
                      ["light", Sun02Icon, "Light"],
                      ["dark", Moon02Icon, "Dark"],
                      ["system", Monitor01Icon, "System"],
                    ] as const
                  ).map(([value, Icon, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => onUpdateAppearance({ theme: value })}
                      className={cn("rounded-2xl border p-4 text-left transition-colors", settings.appearance.theme === value ? "border-primary bg-primary/10 text-primary" : "border-border/50 bg-card/60 text-foreground hover:border-primary/40")}
                    >
                      <Icon className="mb-3 h-5 w-5" />
                      <div className="text-sm font-semibold">{label}</div>
                    </button>
                  ))}
                </div>
              </SectionCard>

              {isDarkMode && (
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
                      ["spotlight", LayoutTableIcon, "Spotlight"],
                      ["sidebar", ColumnIcon, "Sidebar"],
                    ] as const
                  ).map(([value, Icon, label]) => (
                    <button
                      key={value}
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
          <Dialog.Backdrop className={cn("fixed inset-0 z-[100] bg-background/80", !disableMotion && "animate-in fade-in duration-200")} />
          <Dialog.Popup
            data-chalk
            data-chalk-theme={portalTheme}
            className={cn(
              "chalk-root",
              "fixed inset-0 z-[101] flex flex-col overflow-hidden bg-card text-card-foreground shadow-2xl md:inset-x-4 md:top-1/2 md:h-[min(720px,calc(100vh-2rem))] md:-translate-y-1/2 md:rounded-[28px] md:border md:border-border md:left-1/2 md:right-auto md:w-[min(960px,calc(100vw-3rem))] md:-translate-x-1/2",
              !disableMotion && "animate-in fade-in duration-300 ease-out",
              !disableMotion && "slide-in-from-bottom-10 md:zoom-in-95",
            )}
            style={settingsChromeVariables}
          >
            <Dialog.Title className="sr-only">Meeting settings</Dialog.Title>
            <div className="flex h-full flex-col md:flex-row">
              <aside className={cn("flex w-full shrink-0 flex-col border-border/50 bg-muted/30 md:w-[280px] md:border-r", !showSidebar && "hidden")}>
                <div className="p-5 pb-4 md:p-6">
                  <div className="mb-5 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Settings01Icon className="h-5 w-5 text-primary" />
                      <div>
                        <div className="text-base font-semibold">Settings</div>
                        <div className="text-xs text-muted-foreground">Local to this browser</div>
                      </div>
                    </div>
                    <IconButton icon={<Cancel01Icon className="h-5 w-5" />} variant="ghost" onClick={onClose} aria-label="Close settings" className="md:hidden" />
                  </div>
                  <Input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search settings" icon={<Search01Icon className="h-4 w-4" />} fullWidth className="rounded-2xl border-border/50 bg-muted/50" aria-label="Search settings" />
                </div>
                <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-6 md:px-4">
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
                        className={cn("flex w-full items-start gap-3 rounded-2xl px-4 py-3.5 text-left transition-colors md:py-3", activeSection === section.id ? "bg-primary text-primary-foreground shadow-md shadow-primary/20" : "text-muted-foreground hover:bg-muted hover:text-foreground")}
                      >
                        <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium">{section.label}</span>
                          <span className="block text-xs opacity-80">{section.description}</span>
                        </span>
                      </button>
                    );
                  })}
                  {filteredSections.length === 0 && <div className="rounded-2xl border border-dashed border-border/60 px-4 py-8 text-center text-sm text-muted-foreground">No matching settings.</div>}
                </nav>
              </aside>

              <div className={cn("flex min-h-0 flex-1 flex-col", !showContent && "hidden")}>
                <div className="flex items-start justify-between border-b border-border/50 px-5 py-4 md:px-7 md:py-6">
                  <div className="flex items-center gap-3">
                    <IconButton icon={<ArrowLeft02Icon className="h-5 w-5" />} variant="ghost" onClick={() => setIsNavOpen(true)} className="md:hidden" aria-label="Back to sections" />
                    <div>
                      <h2 className="text-lg font-semibold text-foreground md:text-xl">{SECTIONS.find((section) => section.id === activeSection)?.label}</h2>
                      <p className="mt-0.5 text-xs text-muted-foreground md:mt-1 md:text-sm">{SECTIONS.find((section) => section.id === activeSection)?.description}</p>
                    </div>
                  </div>
                  <IconButton icon={<Cancel01Icon className="h-5 w-5" />} variant="ghost" onClick={onClose} aria-label="Close settings" />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 md:px-7">
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
