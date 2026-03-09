import type React from "react";

import { Cancel01Icon } from "../../../utils/icons";
import { DeviceSelector } from "../../composite";

interface PreJoinSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  hasVideoDevices: boolean;
  hasAudioInput: boolean;
  hasAudioOutput: boolean;
  videoDevices: MediaDeviceInfo[];
  audioInputDevices: MediaDeviceInfo[];
  audioOutputDevices: MediaDeviceInfo[];
  selectedVideoDevice?: string;
  selectedAudioInput?: string;
  selectedAudioOutput?: string;
  onVideoDeviceChange: (deviceId: string) => void;
  onAudioInputChange: (deviceId: string) => void;
  onAudioOutputChange: (deviceId: string) => void;
  isAudioEnabled: boolean;
  audioLevel: number;
  isLoading: boolean;
}

export function PreJoinSettingsModal({
  isOpen,
  onClose,
  hasVideoDevices,
  hasAudioInput,
  hasAudioOutput,
  videoDevices,
  audioInputDevices,
  audioOutputDevices,
  selectedVideoDevice,
  selectedAudioInput,
  selectedAudioOutput,
  onVideoDeviceChange,
  onAudioInputChange,
  onAudioOutputChange,
  isAudioEnabled,
  audioLevel,
  isLoading,
}: PreJoinSettingsModalProps): React.JSX.Element | null {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/20 backdrop-blur-sm">
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div
        className="rounded-2xl border p-6 w-full max-w-md relative animate-in fade-in zoom-in-95 duration-200 overflow-visible z-10"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
        style={{
          background: "var(--chalk-lobby-glass-bg)",
          borderColor: "var(--chalk-lobby-glass-border)",
          backdropFilter: "blur(20px)",
          boxShadow: "var(--chalk-shadow-xl)",
        }}
      >
        <button type="button" onClick={onClose} aria-label="Close settings" className="absolute top-4 right-4 p-2 hover:bg-black/5 dark:hover:bg-white/10 rounded-full transition-colors text-(--muted-foreground) hover:text-(--foreground) outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <Cancel01Icon size={20} />
        </button>

        <h2 id="settings-title" className="text-xl font-semibold text-(--foreground) mb-6">
          Settings
        </h2>

        <div className="space-y-4">
          {hasVideoDevices && <DeviceSelector type="videoinput" label="Camera" devices={videoDevices} selectedDeviceId={selectedVideoDevice} onChange={onVideoDeviceChange} disabled={isLoading} />}

          {hasAudioInput && <DeviceSelector type="audioinput" label="Microphone" devices={audioInputDevices} selectedDeviceId={selectedAudioInput} onChange={onAudioInputChange} audioLevel={isAudioEnabled ? audioLevel : 0} disabled={isLoading} />}

          {hasAudioOutput && <DeviceSelector type="audiooutput" label="Speaker" devices={audioOutputDevices} selectedDeviceId={selectedAudioOutput} onChange={onAudioOutputChange} disabled={isLoading} />}
        </div>

        <div className="mt-6 flex justify-end">
          <button type="button" onClick={onClose} className="px-5 py-2.5 bg-primary text-primary-foreground rounded-full hover:bg-primary/90 transition-colors font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
