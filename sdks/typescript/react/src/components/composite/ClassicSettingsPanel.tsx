import React, { useMemo, useState } from "react";
import { IconButton, Toggle } from "@q9labsai/chalk-ui";
import { useMedia, useSelf, useSpaceClient } from "../../bindings/hooks";
import { Cancel01Icon, Microphone01Icon, Video01Icon, Settings01Icon, PictureInPictureIcon } from "../../utils/icons";
import { DeviceSelector } from "./DeviceSelector";
import { NoiseSuppressionToggle } from "./NoiseSuppressionToggle";
import { VolumeSlider } from "../atomic";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { getParticipantThemeVariables } from "../../utils/colorGenerator";
import type { SettingsPanelProps } from "./SettingsPanel";

interface SettingsPanelSurfaceProps extends SettingsPanelProps {
  readonly audioInputDevices: Array<Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">>;
  readonly audioOutputDevices: Array<Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">>;
  readonly selectedAudioInput?: string;
  readonly selectedAudioOutput?: string;
  readonly onAudioInputChange?: (deviceId: string) => void;
  readonly onAudioOutputChange?: (deviceId: string) => void;
  readonly audioLevel?: number;
  readonly videoInputDevices: Array<Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">>;
  readonly selectedVideoInput?: string;
  readonly onVideoInputChange?: (deviceId: string) => void;
  readonly videoTrack?: MediaStreamTrack | null;
  readonly noiseSuppression?: boolean;
  readonly onNoiseSuppressionChange?: (enabled: boolean) => void;
}

const SettingsPanelSurface = React.memo(
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
  }: SettingsPanelSurfaceProps) => {
    const prefersReducedMotion = usePrefersReducedMotion();
    const [activeTab, setActiveTab] = useState<"audio-video" | "general">("audio-video");
    const [speakerVolume, setSpeakerVolume] = useState(100);
    const themeVariables = useMemo(() => getParticipantThemeVariables(participantColorSeed), [participantColorSeed]);

    return (
      <div className={cn("flex flex-col h-full w-80 shadow-xl", "bg-[var(--chalk-surface)]", "border-l border-[var(--chalk-line)]", className)} data-tour="settings-panel" role="dialog" aria-label="Settings" style={themeVariables as React.CSSProperties}>
        <div className="flex items-center justify-between p-4 border-b border-[var(--chalk-line)]">
          <div className="flex items-center gap-2">
            <Settings01Icon className="w-4 h-4 text-[var(--chalk-muted-text)]" />
            <h2 className="text-sm font-semibold text-[var(--chalk-text)]">Settings</h2>
          </div>
          {onClose && <IconButton icon={<Cancel01Icon className="w-4 h-4" />} size="sm" variant="ghost" onClick={onClose} aria-label="Close settings" />}
        </div>

        <div className="flex border-b border-[var(--chalk-line)]" role="tablist" aria-label="Settings categories">
          <button
            type="button"
            onClick={() => setActiveTab("audio-video")}
            className={cn("flex-1 border-b-2 py-2.5 text-sm font-medium transition-colors", activeTab === "audio-video" ? "text-[var(--chalk-accent)] border-[var(--chalk-accent)]" : "text-[var(--chalk-muted-text)] border-transparent hover:text-[var(--chalk-text)]")}
            aria-selected={activeTab === "audio-video"}
            role="tab"
          >
            <div className="flex items-center justify-center gap-2">
              <Microphone01Icon className="w-4 h-4" />
              <Video01Icon className="w-4 h-4" />
              Audio &amp; video
            </div>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("general")}
            className={cn("flex-1 border-b-2 py-2.5 text-sm font-medium transition-colors", activeTab === "general" ? "text-[var(--chalk-accent)] border-[var(--chalk-accent)]" : "text-[var(--chalk-muted-text)] border-transparent hover:text-[var(--chalk-text)]")}
            aria-selected={activeTab === "general"}
            role="tab"
          >
            <div className="flex items-center justify-center gap-2">
              <Settings01Icon className="w-4 h-4" />
              General
            </div>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {activeTab === "audio-video" && (
            <div className={cn("space-y-5", !prefersReducedMotion && "animate-in fade-in duration-200")}>
              <div className="space-y-4">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--chalk-muted-text)]">Microphone</h3>
                <DeviceSelector type="audioinput" devices={audioInputDevices} selectedDeviceId={selectedAudioInput} onChange={(id) => onAudioInputChange?.(id)} label="Input Device" audioLevel={audioLevel} participantColorSeed={participantColorSeed} />

                {onNoiseSuppressionChange && <NoiseSuppressionToggle enabled={noiseSuppression} onChange={onNoiseSuppressionChange} level="medium" onLevelChange={() => {}} />}
              </div>

              <div className="space-y-4 border-t border-[var(--chalk-line)] pt-4">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--chalk-muted-text)]">Speakers</h3>
                <DeviceSelector type="audiooutput" devices={audioOutputDevices} selectedDeviceId={selectedAudioOutput} onChange={(id) => onAudioOutputChange?.(id)} label="Output Device" participantColorSeed={participantColorSeed} />

                <div className="space-y-2">
                  <label className="text-sm font-medium text-[var(--chalk-muted-text)]">Output Volume</label>
                  <VolumeSlider value={speakerVolume} onChange={setSpeakerVolume} showValue />
                </div>
              </div>
              <div className="space-y-4 border-t border-[var(--chalk-line)] pt-4">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--chalk-muted-text)]">Camera</h3>
                <DeviceSelector type="videoinput" devices={videoInputDevices} selectedDeviceId={selectedVideoInput} onChange={(id) => onVideoInputChange?.(id)} label="Input Device" previewTrack={videoTrack} participantColorSeed={participantColorSeed} />
              </div>
            </div>
          )}

          {activeTab === "general" && (
            <div className={cn("space-y-6", !prefersReducedMotion && "animate-in fade-in duration-200")}>
              {enablePictureInPicture && (
                <div className="space-y-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--chalk-muted-text)]">Picture in Picture</h3>

                  <div className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--chalk-line)] bg-[var(--chalk-surface)] p-4">
                    <div>
                      <div className="text-sm font-medium text-[var(--chalk-text)]">Auto-open PiP</div>
                      <div className="text-xs text-[var(--chalk-muted-text)] text-wrap">Try to open PiP automatically on join.</div>
                    </div>
                    <Toggle checked={autoOpenPictureInPicture} onChange={onAutoOpenPictureInPictureChange ?? (() => {})} label="Auto-open PiP" />
                  </div>

                  <div className="rounded-2xl border border-[var(--chalk-line)] bg-[var(--chalk-surface)] p-4">
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-[var(--chalk-text)]">Manual open</div>
                        <div className="text-xs text-[var(--chalk-muted-text)]">{isPictureInPictureSupported ? (isPictureInPictureActive ? "PiP is already open." : "Open PiP manually if auto-open failed.") : "PiP not supported."}</div>
                      </div>
                      <PictureInPictureIcon className="h-4 w-4 shrink-0 text-[var(--chalk-accent)]" />
                    </div>
                    <button
                      type="button"
                      onClick={() => onOpenPictureInPicture?.()}
                      disabled={!isPictureInPictureSupported || isPictureInPictureActive || !onOpenPictureInPicture}
                      className={cn(
                        "w-full h-9 inline-flex items-center justify-center rounded-full px-4 text-sm font-medium transition-colors outline-none",
                        "focus-visible:ring-2 focus-visible:ring-[var(--chalk-focus)]",
                        "disabled:cursor-not-allowed disabled:opacity-50",
                        "bg-[var(--chalk-accent)] text-[var(--chalk-accent-text)] hover:bg-[var(--chalk-accent)]",
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

export function ClassicSettingsPanel(props: SettingsPanelProps): React.JSX.Element {
  const client = useSpaceClient();
  const media = useMedia();
  const self = useSelf();
  const devices = {
    audioInputDevices: media.devices.microphones.map((device) => ({ ...device, kind: "audioinput" as const })),
    audioOutputDevices: media.devices.speakers.map((device) => ({ ...device, kind: "audiooutput" as const })),
    videoInputDevices: media.devices.cameras.map((device) => ({ ...device, kind: "videoinput" as const })),
  };

  return (
    <SettingsPanelSurface
      {...props}
      {...devices}
      selectedAudioInput={media.selection.microphone ?? undefined}
      selectedAudioOutput={media.selection.speaker ?? undefined}
      selectedVideoInput={media.selection.camera ?? undefined}
      videoTrack={media.local.camera.track}
      onAudioInputChange={(deviceId) => void client.media.selectMicrophone(deviceId)}
      onAudioOutputChange={(deviceId) => void client.media.selectSpeaker(deviceId)}
      onVideoInputChange={(deviceId) => void client.media.selectCamera(deviceId)}
      participantColorSeed={props.participantColorSeed ?? self.displayName ?? undefined}
    />
  );
}

ClassicSettingsPanel.displayName = "SettingsPanel";
