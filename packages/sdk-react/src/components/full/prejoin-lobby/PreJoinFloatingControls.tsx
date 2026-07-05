import type React from "react";
import { useMemo } from "react";

import { PictureInPictureIcon, Settings01Icon } from "../../../utils/icons";
import { useHaptics } from "../../../hooks/ui/useHaptics";
import { cn } from "../../../utils/cn";
import { ControlButton } from "../../atomic/ControlButton";
import { DeviceControlButton } from "../../composite/DeviceControlButton";
interface MediaDevice {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
  groupId?: string;
}

interface PreJoinFloatingControlsProps {
  isAudioEnabled: boolean;
  isVideoEnabled: boolean;
  effectiveAudioInputDevices: MediaDeviceInfo[];
  effectiveVideoDevices: MediaDeviceInfo[];
  selectedAudioInput?: string;
  selectedVideoDevice?: string;
  onAudioInputChange: (deviceId: string) => void;
  onVideoDeviceChange: (deviceId: string) => void;
  onToggleAudio: () => void;
  onToggleVideo: () => void;
  onToggleSettings: () => void;
  enablePictureInPicture?: boolean;
  isPictureInPictureSupported?: boolean;
  isPictureInPictureActive?: boolean;
  onTogglePictureInPicture?: () => Promise<void> | void;
}

export function PreJoinFloatingControls({
  isAudioEnabled,
  isVideoEnabled,
  effectiveAudioInputDevices,
  effectiveVideoDevices,
  selectedAudioInput,
  selectedVideoDevice,
  onAudioInputChange,
  onVideoDeviceChange,
  onToggleAudio,
  onToggleVideo,
  onToggleSettings,
  enablePictureInPicture = false,
  isPictureInPictureSupported = false,
  isPictureInPictureActive = false,
  onTogglePictureInPicture,
}: PreJoinFloatingControlsProps): React.JSX.Element {
  const { trigger } = useHaptics();
  const selectedAudioInputDevice = useMemo(() => effectiveAudioInputDevices.find((device) => device.deviceId === selectedAudioInput), [effectiveAudioInputDevices, selectedAudioInput]);
  const selectedVideoDeviceInfo = useMemo(() => effectiveVideoDevices.find((device) => device.deviceId === selectedVideoDevice), [effectiveVideoDevices, selectedVideoDevice]);

  // Cast native MediaDeviceInfo to Chalk MediaDevice
  const audioDevices = effectiveAudioInputDevices as unknown as MediaDevice[];
  const videoDevices = effectiveVideoDevices as unknown as MediaDevice[];

  return (
    <div className="absolute bottom-4 left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-3 touch-manipulation">
      <div className="pointer-events-none flex translate-y-2 gap-4 rounded-full border px-4 py-2 opacity-0 shadow-2xl transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100 bg-[var(--chalk-lobby-glass-bg)] border-[var(--chalk-lobby-glass-border)] backdrop-blur-[20px]">
        {isAudioEnabled && selectedAudioInputDevice && <span className="max-w-[160px] truncate text-[11px] font-medium text-foreground">🎤 {selectedAudioInputDevice.label || "Default"}</span>}
        {isVideoEnabled && selectedVideoDeviceInfo && <span className="max-w-[160px] truncate text-[11px] font-medium text-foreground">📹 {selectedVideoDeviceInfo.label || "Default"}</span>}
      </div>

      <div className="relative flex items-center gap-2 rounded-full border p-2 shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-500 bg-[var(--chalk-lobby-glass-bg)] border-[var(--chalk-lobby-glass-border)] backdrop-blur-[20px]">
        <div className="flex items-center gap-2 pl-1">
          <DeviceControlButton type="mic" isActive={isAudioEnabled} onToggle={onToggleAudio} devices={audioDevices} selectedDeviceId={selectedAudioInput} onDeviceChange={onAudioInputChange} className="!pointer-events-auto" haptic="medium" size="sm" />

          <DeviceControlButton type="video" isActive={isVideoEnabled} onToggle={onToggleVideo} devices={videoDevices} selectedDeviceId={selectedVideoDevice} onDeviceChange={onVideoDeviceChange} className="!pointer-events-auto" haptic="medium" size="sm" />
        </div>

        <div className="mx-1 h-6 w-px bg-black/10 dark:bg-white/10" />

        <div className="flex items-center gap-1.5 pr-1">
          <ControlButton
            icon={<Settings01Icon size={20} className="text-foreground" />}
            label="Settings"
            onClick={() => {
              void trigger("selection");
              onToggleSettings();
            }}
            size="sm"
            className="border-0 bg-transparent text-foreground shadow-none hover:bg-black/5 dark:hover:bg-white/10"
            hideTooltip
          />

          {enablePictureInPicture && isPictureInPictureSupported && onTogglePictureInPicture ? (
            <ControlButton
              icon={<PictureInPictureIcon size={20} className={cn("text-foreground", isPictureInPictureActive && "text-primary-foreground")} />}
              label={isPictureInPictureActive ? "Close picture in picture" : "Open picture in picture"}
              active={isPictureInPictureActive}
              onClick={() => {
                void onTogglePictureInPicture();
              }}
              size="sm"
              className={cn("border-0 shadow-none", isPictureInPictureActive ? "bg-primary" : "bg-transparent text-foreground hover:bg-black/5 dark:hover:bg-white/10")}
              hideTooltip
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
