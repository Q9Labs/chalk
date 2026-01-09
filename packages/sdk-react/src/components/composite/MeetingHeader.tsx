import React from 'react';
import { Settings, LayoutGrid, Maximize2, Columns } from 'lucide-react';
import { cn } from '../../utils/cn';
import { StatusBadge } from '../atomic/StatusBadge';

export interface MeetingHeaderProps {
  roomName: string;
  duration?: number;
  isRecording?: boolean;
  isTranscribing?: boolean;
  layout?: 'grid' | 'spotlight' | 'sidebar';
  onLayoutChange?: (layout: 'grid' | 'spotlight' | 'sidebar') => void;
  onInvite?: () => void;
  onSettings?: () => void;
  className?: string;
}

const formatDuration = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

export const MeetingHeader = React.memo<MeetingHeaderProps>(({
  roomName,
  duration = 0,
  isRecording = false,
  isTranscribing = false,
  layout = 'grid',
  onLayoutChange,
  onInvite: _onInvite,
  onSettings,
  className,
}) => {
  return (
    <header
      className={cn(
        'flex items-center justify-between px-5 py-2.5 transition-opacity duration-300',
        className
      )}
      role="banner"
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <h1 className="text-sm font-medium text-white/90 truncate">
          {roomName}
        </h1>
      </div>

      <div className="flex flex-1 justify-center">
        <div className="bg-white/10 px-3 py-1.5 rounded-full text-sm font-medium tabular-nums text-white">
          {formatDuration(duration)}
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 flex-1">
        {isRecording && <StatusBadge status="recording" pulse />}
        {isTranscribing && <StatusBadge status="transcribing" />}

        {onLayoutChange && (
          <div className="hidden sm:flex bg-white/10 rounded-full p-1 gap-1">
            <button
              onClick={() => onLayoutChange('grid')}
              className={cn(
                'p-2 rounded-full transition-colors',
                layout === 'grid'
                  ? 'bg-white/20 text-white'
                  : 'text-white/50 hover:text-white hover:bg-white/10'
              )}
              aria-label="Grid layout"
              aria-pressed={layout === 'grid'}
            >
              <LayoutGrid size={16} />
            </button>
            <button
              onClick={() => onLayoutChange('spotlight')}
              className={cn(
                'p-2 rounded-full transition-colors',
                layout === 'spotlight'
                  ? 'bg-white/20 text-white'
                  : 'text-white/50 hover:text-white hover:bg-white/10'
              )}
              aria-label="Spotlight layout"
              aria-pressed={layout === 'spotlight'}
            >
              <Maximize2 size={16} />
            </button>
            <button
              onClick={() => onLayoutChange('sidebar')}
              className={cn(
                'p-2 rounded-full transition-colors',
                layout === 'sidebar'
                  ? 'bg-white/20 text-white'
                  : 'text-white/50 hover:text-white hover:bg-white/10'
              )}
              aria-label="Sidebar layout"
              aria-pressed={layout === 'sidebar'}
            >
              <Columns size={16} />
            </button>
          </div>
        )}

        {onSettings && (
          <button
            onClick={onSettings}
            className="p-2 rounded-full text-white/50 hover:text-white hover:bg-white/10 transition-colors"
            aria-label="Settings"
          >
            <Settings size={18} />
          </button>
        )}
      </div>
    </header>
  );
});

MeetingHeader.displayName = 'MeetingHeader';
