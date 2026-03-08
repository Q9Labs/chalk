import React, { useMemo, useState, useEffect } from 'react';
import { VolumeHighIcon } from '../../utils/icons';
import { Select, AudioIndicator, Thumbnail, IconButton } from '../atomic';
import { cn } from '../../utils/cn';
import { usePrefersReducedMotion } from '../../hooks/useMediaQuery';
import { getParticipantThemeVariables } from '../../utils/colorGenerator';

type SelectableDevice = Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'>;

export interface DeviceSelectorProps {
  type: 'audioinput' | 'audiooutput' | 'videoinput';
  devices: readonly SelectableDevice[];
  selectedDeviceId?: string;
  onChange: (deviceId: string) => void;
  label?: string;
  previewTrack?: MediaStreamTrack | null;
  audioLevel?: number;
  disabled?: boolean;
  participantColorSeed?: string;
  className?: string;
}

export const DeviceSelector = React.memo(({
  type,
  devices,
  selectedDeviceId,
  onChange,
  label,
  previewTrack,
  audioLevel,
  disabled = false,
  participantColorSeed,
  className
}: DeviceSelectorProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [isPlayingTestSound, setIsPlayingTestSound] = useState(false);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const themeVariables = useMemo(() => getParticipantThemeVariables(participantColorSeed), [participantColorSeed]);

  const options = devices.map((device, index) => ({
    label: device.label || `${type} ${index + 1}`,
    value: device.deviceId
  }));

  const playTestSound = () => {
    if (audioRef.current) {
      if (isPlayingTestSound) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
        setIsPlayingTestSound(false);
      } else {
        setIsPlayingTestSound(true);
        setTimeout(() => setIsPlayingTestSound(false), 2000);
      }
    }
  };

  useEffect(() => {
    if (type === 'audiooutput' && selectedDeviceId && audioRef.current) {
      if ('setSinkId' in audioRef.current && typeof (audioRef.current as any).setSinkId === 'function') {
        (audioRef.current as any).setSinkId(selectedDeviceId).catch(() => {
          // setSinkId failed - audio will use default output
        });
      }
    }
  }, [type, selectedDeviceId]);

  return (
    <div className={cn("flex flex-col gap-2", className)} style={themeVariables as React.CSSProperties}>
      <div className="flex items-center justify-between">
        {label && (
          <label className="text-sm font-medium text-muted-foreground">
            {label}
          </label>
        )}
      </div>

      <div className="flex gap-2">
        <Select
          options={options}
          value={selectedDeviceId}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled || devices.length === 0}
          placeholder={devices.length === 0 ? "No devices found" : "Select device"}
          fullWidth
        />

        {type === 'audioinput' && (
          <div className="h-10 w-10 flex items-center justify-center rounded-md shrink-0 bg-secondary">
            <AudioIndicator
              level={audioLevel}
              size="sm"
            />
          </div>
        )}

        {type === 'audiooutput' && (
          <div className="shrink-0">
            <audio ref={audioRef} className="hidden" />
            <IconButton
              icon={<VolumeHighIcon className={cn(
                "w-4 h-4",
                isPlayingTestSound && "text-primary",
                isPlayingTestSound && !prefersReducedMotion && "animate-pulse"
              )} />}
              onClick={playTestSound}
              disabled={disabled}
              size="md"
              aria-label="Test speakers"
            />
          </div>
        )}
      </div>

      {type === 'videoinput' && previewTrack && (
        <div className="mt-2 aspect-video w-full overflow-hidden rounded-md bg-black relative">
          <Thumbnail
            videoTrack={previewTrack}
            size="md"
            className="w-full h-full"
          />
        </div>
      )}
    </div>
  );
});

DeviceSelector.displayName = 'DeviceSelector';
