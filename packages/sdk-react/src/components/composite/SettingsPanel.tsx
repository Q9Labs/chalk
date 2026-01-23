import React, { useState } from 'react';
import { Cancel01Icon, Microphone01Icon, Video01Icon, Settings01Icon } from '../../utils/icons';
import { IconButton } from '../atomic';
import { DeviceSelector } from './DeviceSelector';
import { NoiseSuppressionToggle } from './NoiseSuppressionToggle';
import { VolumeSlider } from '../atomic';
import { cn } from '../../utils/cn';
import { usePrefersReducedMotion } from '../../hooks/useMediaQuery';

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

  onClose?: () => void;
  className?: string;
}

export const SettingsPanel = React.memo(({
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
  onClose,
  className
}: SettingsPanelProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [activeTab, setActiveTab] = useState<'audio' | 'video' | 'general'>('audio');
  const [speakerVolume, setSpeakerVolume] = useState(100);

  return (
    <div
      className={cn(
        "flex flex-col h-full w-80 shadow-xl",
        "bg-card",
        "border-l border-border/50",
        !prefersReducedMotion && "animate-in slide-in-from-right duration-300",
        className
      )}
      data-tour="settings-panel"
      role="dialog"
      aria-label="Settings"
    >
      <div className="flex items-center justify-between p-4 border-b border-border/50">
        <div className="flex items-center gap-2">
          <Settings01Icon className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-card-foreground">Settings</h2>
        </div>
        {onClose && (
          <IconButton
            icon={<Cancel01Icon className="w-4 h-4" />}
            size="sm"
            variant="ghost"
            onClick={onClose}
            aria-label="Close settings"
          />
        )}
      </div>

      <div className="flex border-b border-border/50">
        <button
          onClick={() => setActiveTab('audio')}
          className={cn(
            "flex-1 py-3 text-sm font-medium transition-colors border-b-2",
            activeTab === 'audio'
              ? "text-primary border-primary"
              : "text-muted-foreground border-transparent hover:text-foreground"
          )}
        >
          <div className="flex items-center justify-center gap-2">
            <Microphone01Icon className="w-4 h-4" />
            Audio
          </div>
        </button>
        <button
          onClick={() => setActiveTab('video')}
          className={cn(
            "flex-1 py-3 text-sm font-medium transition-colors border-b-2",
            activeTab === 'video'
              ? "text-primary border-primary"
              : "text-muted-foreground border-transparent hover:text-foreground"
          )}
        >
          <div className="flex items-center justify-center gap-2">
            <Video01Icon className="w-4 h-4" />
            Video
          </div>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {activeTab === 'audio' && (
          <div className={cn("space-y-6", !prefersReducedMotion && "animate-in fade-in duration-200")}>
            <div className="space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Microphone</h3>
              <DeviceSelector
                type="audioinput"
                devices={audioInputDevices}
                selectedDeviceId={selectedAudioInput}
                onChange={(id) => onAudioInputChange?.(id)}
                label="Input Device"
                audioLevel={audioLevel}
              />

              {onNoiseSuppressionChange && (
                <NoiseSuppressionToggle
                  enabled={noiseSuppression}
                  onChange={onNoiseSuppressionChange}
                  level="medium"
                  onLevelChange={() => {}}
                />
              )}
            </div>

            <div className="space-y-4 pt-4 border-t border-border/50">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Speakers</h3>
              <DeviceSelector
                type="audiooutput"
                devices={audioOutputDevices}
                selectedDeviceId={selectedAudioOutput}
                onChange={(id) => onAudioOutputChange?.(id)}
                label="Output Device"
              />

              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">Output Volume</label>
                <VolumeSlider
                  value={speakerVolume}
                  onChange={setSpeakerVolume}
                  showValue
                />
              </div>
            </div>
          </div>
        )}

        {activeTab === 'video' && (
          <div className={cn("space-y-6", !prefersReducedMotion && "animate-in fade-in duration-200")}>
            <div className="space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Camera</h3>
              <DeviceSelector
                type="videoinput"
                devices={videoInputDevices}
                selectedDeviceId={selectedVideoInput}
                onChange={(id) => onVideoInputChange?.(id)}
                label="Input Device"
                previewTrack={videoTrack}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

SettingsPanel.displayName = 'SettingsPanel';
