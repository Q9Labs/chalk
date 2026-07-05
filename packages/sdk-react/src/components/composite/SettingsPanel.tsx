import React, { useMemo, useState } from "react";
import { Cancel01Icon, Microphone01Icon, Video01Icon, Settings01Icon, PictureInPictureIcon } from "../../utils/icons";
import { IconButton, Toggle } from "../atomic";
import { DeviceSelector } from "./DeviceSelector";
import { NoiseSuppressionToggle } from "./NoiseSuppressionToggle";
import { VolumeSlider } from "../atomic";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { getParticipantThemeVariables } from "../../utils/colorGenerator";

export interface SettingsPanelProps {
  audioInputDevices: MediaDeviceInfo[];
  audioOutputDevices: MediaDeviceInfo[];
  selectedAudioInput?: string;
  selectedAudioOutput?: string;
  onAudioInputChange?: (deviceId: string) => void;
  onAudioOutputChange?: (deviceId: string) => void;
  audioLevel?: number;

  videoInputDevices: MediaDeviceInfo[];
  selectedVideoInput?: string;
  onVideoInputChange?: (deviceId: string) => void;
  videoTrack?: MediaStreamTrack | null;

  noiseSuppression?: boolean;
  onNoiseSuppressionChange?: (enabled: boolean) => void;

  enablePictureInPicture?: boolean;
  isPictureInPictureSupported?: boolean;
  isPictureInPictureActive?: boolean;
  autoOpenPictureInPicture?: boolean;
  onAutoOpenPictureInPictureChange?: (enabled: boolean) => void;
  onOpenPictureInPicture?: () => void;

  onClose?: () => void;
  participantColorSeed?: string;
  className?: string;
}

export const SettingsPanel = React.memo(
  ({
    audioInputDevices,
    audioOutputDevices,
    selectedAudioInput,
    selectedAudioOutput,
    onAudioInputChange,
    onAudioOutputChange,
    audioLevel = 0,
    videoInputDevices,
    selectedVideoInput,
    onVideoInputChange,
    videoTrack,
    noiseSuppression = false,
    onNoiseSuppressionChange,
    enablePictureInPicture = false,
    isPictureInPictureSupported = false,
    isPictureInPictureActive = false,
    autoOpenPictureInPicture = true,
    onAutoOpenPictureInPictureChange,
    onOpenPictureInPicture,
    onClose,
    participantColorSeed,
    className,
  }: SettingsPanelProps) => {
    const prefersReducedMotion = usePrefersReducedMotion();
    const [activeTab, setActiveTab] = useState<"audio" | "video" | "general">("audio");
    const [speakerVolume, setSpeakerVolume] = useState(100);
    const themeVariables = useMemo(() => getParticipantThemeVariables(participantColorSeed), [participantColorSeed]);

    return (
      <div className={cn("flex flex-col h-full w-80 shadow-xl", "bg-card", "border-l border-border/50", !prefersReducedMotion && "animate-in slide-in-from-right duration-300", className)} data-tour="settings-panel" role="dialog" aria-label="Settings" style={themeVariables as React.CSSProperties}>
        <div className="flex items-center justify-between p-4 border-b border-border/50">
          <div className="flex items-center gap-2">
            <Settings01Icon className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-card-foreground">Settings</h2>
          </div>
          {onClose && <IconButton icon={<Cancel01Icon className="w-4 h-4" />} size="sm" variant="ghost" onClick={onClose} aria-label="Close settings" />}
        </div>

        <div className="flex border-b border-border/50">
          <button onClick={() => setActiveTab("audio")} className={cn("flex-1 py-3 text-sm font-medium transition-colors border-b-2", activeTab === "audio" ? "text-primary border-primary" : "text-muted-foreground border-transparent hover:text-foreground")}>
            <div className="flex items-center justify-center gap-2">
              <Microphone01Icon className="w-4 h-4" />
              Audio
            </div>
          </button>
          <button onClick={() => setActiveTab("video")} className={cn("flex-1 py-3 text-sm font-medium transition-colors border-b-2", activeTab === "video" ? "text-primary border-primary" : "text-muted-foreground border-transparent hover:text-foreground")}>
            <div className="flex items-center justify-center gap-2">
              <Video01Icon className="w-4 h-4" />
              Video
            </div>
          </button>
          <button onClick={() => setActiveTab("general")} className={cn("flex-1 py-3 text-sm font-medium transition-colors border-b-2", activeTab === "general" ? "text-primary border-primary" : "text-muted-foreground border-transparent hover:text-foreground")}>
            <div className="flex items-center justify-center gap-2">
              <Settings01Icon className="w-4 h-4" />
              General
            </div>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {activeTab === "audio" && (
            <div className={cn("space-y-6", !prefersReducedMotion && "animate-in fade-in duration-200")}>
              <div className="space-y-4">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Microphone</h3>
                <DeviceSelector type="audioinput" devices={audioInputDevices} selectedDeviceId={selectedAudioInput} onChange={(id) => onAudioInputChange?.(id)} label="Input Device" audioLevel={audioLevel} participantColorSeed={participantColorSeed} />

                {onNoiseSuppressionChange && <NoiseSuppressionToggle enabled={noiseSuppression} onChange={onNoiseSuppressionChange} level="medium" onLevelChange={() => {}} />}
              </div>

              <div className="space-y-4 pt-4 border-t border-border/50">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Speakers</h3>
                <DeviceSelector type="audiooutput" devices={audioOutputDevices} selectedDeviceId={selectedAudioOutput} onChange={(id) => onAudioOutputChange?.(id)} label="Output Device" participantColorSeed={participantColorSeed} />

                <div className="space-y-2">
                  <label className="text-sm font-medium text-muted-foreground">Output Volume</label>
                  <VolumeSlider value={speakerVolume} onChange={setSpeakerVolume} showValue />
                </div>
              </div>
            </div>
          )}

          {activeTab === "video" && (
            <div className={cn("space-y-6", !prefersReducedMotion && "animate-in fade-in duration-200")}>
              <div className="space-y-4">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Camera</h3>
                <DeviceSelector type="videoinput" devices={videoInputDevices} selectedDeviceId={selectedVideoInput} onChange={(id) => onVideoInputChange?.(id)} label="Input Device" previewTrack={videoTrack} participantColorSeed={participantColorSeed} />
              </div>
            </div>
          )}

          {activeTab === "general" && (
            <div className={cn("space-y-6", !prefersReducedMotion && "animate-in fade-in duration-200")}>
              {enablePictureInPicture && (
                <div className="space-y-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Picture in Picture</h3>

                  <div className="flex items-center justify-between gap-4 rounded-2xl border border-border/50 bg-card/60 p-4">
                    <div>
                      <div className="text-sm font-medium text-foreground">Auto-open PiP</div>
                      <div className="text-xs text-muted-foreground text-wrap">Try to open PiP automatically on join.</div>
                    </div>
                    <Toggle checked={autoOpenPictureInPicture} onChange={onAutoOpenPictureInPictureChange ?? (() => {})} label="Auto-open PiP" />
                  </div>

                  <div className="rounded-2xl border border-border/50 bg-card/60 p-4">
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-foreground">Manual open</div>
                        <div className="text-xs text-muted-foreground">{isPictureInPictureSupported ? (isPictureInPictureActive ? "PiP is already open." : "Open PiP manually if auto-open failed.") : "PiP not supported."}</div>
                      </div>
                      <PictureInPictureIcon className="h-4 w-4 shrink-0 text-primary" />
                    </div>
                    <button
                      type="button"
                      onClick={() => onOpenPictureInPicture?.()}
                      disabled={!isPictureInPictureSupported || isPictureInPictureActive || !onOpenPictureInPicture}
                      className={cn(
                        "w-full h-9 inline-flex items-center justify-center rounded-full px-4 text-sm font-medium transition-colors outline-none",
                        "focus-visible:ring-2 focus-visible:ring-primary",
                        "disabled:cursor-not-allowed disabled:opacity-50",
                        "bg-primary text-primary-foreground hover:bg-primary/90",
                      )}
                    >
                      Open PiP now
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  },
);

SettingsPanel.displayName = "SettingsPanel";
