import { useState } from 'react';
import { X, Mic, Video, Settings } from 'lucide-react';
import { IconButton } from '../atomic';
import { DeviceSelector } from './DeviceSelector';
import { NoiseSuppressionToggle } from './NoiseSuppressionToggle';
import { VolumeSlider } from '../atomic';
import { cn } from '../../utils/cn';

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

export function SettingsPanel({
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
}: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<'audio' | 'video' | 'general'>('audio');
  const [speakerVolume, setSpeakerVolume] = useState(100);

  return (
    <div 
      className={cn(
        "flex flex-col h-full bg-chalk-bg-surface border-l border-chalk-border-subtle w-80 shadow-xl chalk-animate-slide-right",
        className
      )}
      data-tour="settings-panel"
      role="dialog"
      aria-label="Settings"
    >
      <div className="flex items-center justify-between p-4 border-b border-chalk-border-subtle">
        <div className="flex items-center gap-2">
          <Settings className="w-4 h-4 text-chalk-text-secondary" />
          <h2 className="text-sm font-semibold text-chalk-text-primary">Settings</h2>
        </div>
        {onClose && (
          <IconButton 
            icon={<X className="w-4 h-4" />} 
            size="sm" 
            variant="ghost" 
            onClick={onClose}
            aria-label="Close settings"
          />
        )}
      </div>

      <div className="flex border-b border-chalk-border-subtle">
        <button
          onClick={() => setActiveTab('audio')}
          className={cn(
            "flex-1 py-3 text-sm font-medium transition-colors border-b-2",
            activeTab === 'audio' 
              ? "text-chalk-accent border-chalk-accent" 
              : "text-chalk-text-secondary border-transparent hover:text-chalk-text-primary"
          )}
        >
          <div className="flex items-center justify-center gap-2">
            <Mic className="w-4 h-4" />
            Audio
          </div>
        </button>
        <button
          onClick={() => setActiveTab('video')}
          className={cn(
            "flex-1 py-3 text-sm font-medium transition-colors border-b-2",
            activeTab === 'video' 
              ? "text-chalk-accent border-chalk-accent" 
              : "text-chalk-text-secondary border-transparent hover:text-chalk-text-primary"
          )}
        >
          <div className="flex items-center justify-center gap-2">
            <Video className="w-4 h-4" />
            Video
          </div>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {activeTab === 'audio' && (
          <div className="space-y-6 chalk-animate-fade-in">
            <div className="space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-chalk-text-secondary">Microphone</h3>
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

            <div className="space-y-4 pt-4 border-t border-chalk-border-subtle">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-chalk-text-secondary">Speakers</h3>
              <DeviceSelector
                type="audiooutput"
                devices={audioOutputDevices}
                selectedDeviceId={selectedAudioOutput}
                onChange={(id) => onAudioOutputChange?.(id)}
                label="Output Device"
              />
              
              <div className="space-y-2">
                <label className="text-sm font-medium text-chalk-text-secondary">Output Volume</label>
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
          <div className="space-y-6 chalk-animate-fade-in">
            <div className="space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-chalk-text-secondary">Camera</h3>
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
}
