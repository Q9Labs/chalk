import type React from "react";

import { Settings01Icon } from "../../../utils/icons";
import { useHaptics } from "../../../hooks/ui/useHaptics";
import { ControlButton } from "../../atomic/ControlButton";
import { DeviceControlButton } from "../../composite/DeviceControlButton";
interface MediaDevice {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
  groupId?: string;
}

interface PreJoinMobileControlsProps {
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
}

export function PreJoinMobileControls({
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
}: PreJoinMobileControlsProps): React.JSX.Element {
  const { trigger } = useHaptics();

  const audioDevices = effectiveAudioInputDevices as unknown as MediaDevice[];
  const videoDevices = effectiveVideoDevices as unknown as MediaDevice[];

  return (
    <div className="flex items-center gap-1 rounded-full border p-1.5 shadow-2xl bg-black/40 border-white/10 backdrop-blur-[20px]">
      <DeviceControlButton
        type="mic"
        isActive={isAudioEnabled}
        onToggle={() => {
          void trigger("medium");
          onToggleAudio();
        }}
        devices={audioDevices}
        selectedDeviceId={selectedAudioInput}
        onDeviceChange={onAudioInputChange}
        orientation="up"
        size="md"
        className="!pointer-events-auto"
        haptic={false}
      />

      <DeviceControlButton
        type="video"
        isActive={isVideoEnabled}
        onToggle={() => {
          void trigger("medium");
          onToggleVideo();
        }}
        devices={videoDevices}
        selectedDeviceId={selectedVideoDevice}
        onDeviceChange={onVideoDeviceChange}
        orientation="up"
        size="md"
        className="!pointer-events-auto"
        haptic={false}
      />

      <div className="mx-1 h-6 w-px bg-white/20" />

      <ControlButton
        icon={<Settings01Icon size={20} className="text-white" />}
        label="Settings"
        onClick={() => {
          void trigger("selection");
          onToggleSettings();
        }}
        size="md"
        className="border-0 bg-transparent text-white shadow-none hover:bg-white/10"
        hideTooltip
        haptic={false}
      />
    </div>
  );
}
