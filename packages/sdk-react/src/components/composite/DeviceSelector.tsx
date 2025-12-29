import React, { useState, useEffect } from 'react';
import { Volume2 } from 'lucide-react';
import { Select, AudioIndicator, Thumbnail, IconButton } from '../atomic';
import { cn } from '../../utils/cn';

export interface DeviceSelectorProps {
  type: 'audioinput' | 'audiooutput' | 'videoinput';
  devices: MediaDeviceInfo[];
  selectedDeviceId?: string;
  onChange: (deviceId: string) => void;
  label?: string;
  previewTrack?: MediaStreamTrack | null;
  audioLevel?: number;
  disabled?: boolean;
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
  className
}: DeviceSelectorProps) => {
  const [isPlayingTestSound, setIsPlayingTestSound] = useState(false);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);

  const options = devices.map(d => ({
    label: d.label || `${type} ${devices.indexOf(d) + 1}`,
    value: d.deviceId
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
         (audioRef.current as any).setSinkId(selectedDeviceId).catch((e: any) => console.warn('Failed to set sink ID', e));
      }
    }
  }, [type, selectedDeviceId]);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between">
        {label && (
          <label className="text-sm font-medium text-chalk-text-secondary">
            {label}
          </label>
        )}
      </div>

      <div className="flex items-start gap-2">
        <div className="flex-1">
          <Select
            options={options}
            value={selectedDeviceId}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled || devices.length === 0}
            placeholder={devices.length === 0 ? "No devices found" : "Select device"}
            fullWidth
          />
        </div>

        {type === 'audioinput' && (
          <div className="h-10 w-10 flex items-center justify-center bg-chalk-bg-subtle rounded-md border border-chalk-border-subtle shrink-0">
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
               icon={<Volume2 className={cn("w-4 h-4", isPlayingTestSound && "text-chalk-accent animate-pulse")} />}
               onClick={playTestSound}
               disabled={disabled}
               variant="outline"
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
