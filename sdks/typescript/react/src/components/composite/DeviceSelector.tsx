import React, { useMemo, useState, useEffect } from "react";
import { VolumeHighIcon } from "../../utils/icons";
import { Select, AudioIndicator, Thumbnail, IconButton } from "../atomic";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { getParticipantThemeVariables, type ParticipantGradientPreference } from "../../utils/colorGenerator";

type SelectableDevice = Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">;

const SPEAKER_TEST_TONE_SRC =
  "data:audio/wav;base64,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";

export interface DeviceSelectorProps {
  type: "audioinput" | "audiooutput" | "videoinput";
  devices: readonly SelectableDevice[];
  selectedDeviceId?: string;
  onChange: (deviceId: string) => void;
  label?: string;
  previewTrack?: MediaStreamTrack | null;
  audioLevel?: number;
  disabled?: boolean;
  participantColorSeed?: string;
  participantGradientPreference?: ParticipantGradientPreference;
  className?: string;
}

export const DeviceSelector = React.memo(({ type, devices, selectedDeviceId, onChange, label, previewTrack, audioLevel, disabled = false, participantColorSeed, participantGradientPreference, className }: DeviceSelectorProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [isPlayingTestSound, setIsPlayingTestSound] = useState(false);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const themeVariables = useMemo(() => getParticipantThemeVariables(participantColorSeed, participantGradientPreference), [participantColorSeed, participantGradientPreference]);

  const options = devices.map((device, index) => ({
    label: device.label || `${type} ${index + 1}`,
    value: device.deviceId,
  }));

  const applySinkId = async (audioElement: HTMLAudioElement) => {
    if (type !== "audiooutput" || !selectedDeviceId) {
      return;
    }

    const sinkAwareAudio = audioElement as HTMLAudioElement & {
      setSinkId?: (sinkId: string) => Promise<void>;
    };

    if (typeof sinkAwareAudio.setSinkId !== "function") {
      return;
    }

    try {
      await sinkAwareAudio.setSinkId(selectedDeviceId);
    } catch {
      // Fallback to browser default output when sink routing is unavailable.
    }
  };

  const playTestSound = async () => {
    const audioElement = audioRef.current;
    if (!audioElement) {
      return;
    }

    if (isPlayingTestSound) {
      audioElement.pause();
      audioElement.currentTime = 0;
      setIsPlayingTestSound(false);
      return;
    }

    audioElement.src = SPEAKER_TEST_TONE_SRC;
    audioElement.currentTime = 0;
    await applySinkId(audioElement);
    setIsPlayingTestSound(true);

    try {
      await audioElement.play();
    } catch {
      setIsPlayingTestSound(false);
    }
  };

  useEffect(() => {
    if (audioRef.current) {
      void applySinkId(audioRef.current);
    }
  }, [type, selectedDeviceId]);

  return (
    <div className={cn("flex flex-col gap-2", className)} style={themeVariables as React.CSSProperties}>
      <div className="flex items-center justify-between">{label && <label className="text-sm font-medium text-muted-foreground">{label}</label>}</div>

      <div className="flex gap-2">
        <Select options={options} value={selectedDeviceId} onChange={(e) => onChange(e.target.value)} disabled={disabled || devices.length === 0} placeholder={devices.length === 0 ? "No devices found" : "Select device"} fullWidth />

        {type === "audioinput" && (
          <div className="h-10 w-10 flex items-center justify-center rounded-md shrink-0 bg-secondary">
            <AudioIndicator level={audioLevel} size="sm" />
          </div>
        )}

        {type === "audiooutput" && (
          <div className="shrink-0">
            <audio ref={audioRef} className="hidden" preload="auto" onEnded={() => setIsPlayingTestSound(false)} onPause={() => setIsPlayingTestSound(false)} />
            <IconButton icon={<VolumeHighIcon className={cn("w-4 h-4", isPlayingTestSound && "text-primary", isPlayingTestSound && !prefersReducedMotion && "animate-pulse")} />} onClick={playTestSound} disabled={disabled} size="md" aria-label="Test speakers" />
          </div>
        )}
      </div>

      {type === "videoinput" && previewTrack && (
        <div className="mt-2 aspect-video w-full overflow-hidden rounded-md bg-black relative">
          <Thumbnail videoTrack={previewTrack} size="md" className="w-full h-full" />
        </div>
      )}
    </div>
  );
});

DeviceSelector.displayName = "DeviceSelector";
