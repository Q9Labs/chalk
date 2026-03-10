import type React from "react";

import { Cancel01Icon, PictureInPictureIcon } from "../../../utils/icons";
import { DeviceSelector } from "../../composite";
import { Toggle } from "../../atomic";
import { cn } from "../../../utils/cn";

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
  enablePictureInPicture?: boolean;
  isPictureInPictureSupported?: boolean;
  isPictureInPictureActive?: boolean;
  onOpenPictureInPicture?: () => void;
  autoOpenPictureInPicture?: boolean;
  onAutoOpenPictureInPictureChange?: (enabled: boolean) => void;
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
  enablePictureInPicture = false,
  isPictureInPictureSupported = false,
  isPictureInPictureActive = false,
  onOpenPictureInPicture,
  autoOpenPictureInPicture = true,
  onAutoOpenPictureInPictureChange,
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

        <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-2 custom-scrollbar">
          {hasVideoDevices && <DeviceSelector type="videoinput" label="Camera" devices={videoDevices} selectedDeviceId={selectedVideoDevice} onChange={onVideoDeviceChange} disabled={isLoading} />}

          {hasAudioInput && <DeviceSelector type="audioinput" label="Microphone" devices={audioInputDevices} selectedDeviceId={selectedAudioInput} onChange={onAudioInputChange} audioLevel={isAudioEnabled ? audioLevel : 0} disabled={isLoading} />}

          {hasAudioOutput && <DeviceSelector type="audiooutput" label="Speaker" devices={audioOutputDevices} selectedDeviceId={selectedAudioOutput} onChange={onAudioOutputChange} disabled={isLoading} />}

          {enablePictureInPicture && (
            <div className="space-y-4 pt-4 border-t border-white/10">
              <div className="flex items-center justify-between gap-4 rounded-2xl border border-white/5 bg-black/5 p-4">
                <div>
                  <div className="text-sm font-medium text-(--foreground)">Auto-open Picture-in-Picture</div>
                  <div className="text-xs text-(--muted-foreground)">Try to open PiP automatically when the room loads.</div>
                </div>
                <Toggle checked={autoOpenPictureInPicture} onChange={onAutoOpenPictureInPictureChange ?? (() => {})} label="Auto-open Picture-in-Picture" />
              </div>

              <div className="rounded-2xl border border-white/5 bg-black/5 p-4">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-(--foreground)">Manual open</div>
                    <div className="text-xs text-(--muted-foreground)">{isPictureInPictureSupported ? (isPictureInPictureActive ? "Picture-in-Picture is already open." : "Open PiP manually if the browser blocked automatic opening.") : "Picture-in-Picture is not supported in this browser."}</div>
                  </div>
                  <PictureInPictureIcon className="h-5 w-5 shrink-0 text-primary" />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onOpenPictureInPicture?.();
                  }}
                  disabled={!isPictureInPictureSupported || isPictureInPictureActive || !onOpenPictureInPicture}
                  className={cn(
                    "w-full h-10 inline-flex items-center justify-center rounded-full px-4 text-sm font-medium transition-colors outline-none",
                    "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    "bg-primary text-primary-foreground hover:bg-primary/90",
                  )}
                  aria-label="Open Picture-in-Picture now"
                >
                  Open Picture-in-Picture now
                </button>
              </div>
            </div>
          )}
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
