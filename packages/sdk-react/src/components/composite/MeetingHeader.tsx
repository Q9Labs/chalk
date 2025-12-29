import React from 'react';
import { Settings, UserPlus, LayoutGrid, Maximize2, Columns } from 'lucide-react';
import { cn } from '../../utils/cn';
import { StatusBadge } from '../atomic/StatusBadge';
import { IconButton } from '../atomic/IconButton';

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
  onInvite,
  onSettings,
  className,
}) => {
  return (
    <header
      className={cn(
        'flex items-center justify-between px-4 py-3 bg-[var(--chalk-bg-primary)] border-b border-[var(--chalk-border-color)] h-16',
        className
      )}
      role="banner"
    >
      <div className="flex items-center gap-4 flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <div className="h-6 w-6 rounded bg-[var(--chalk-primary)] flex items-center justify-center text-white font-bold text-xs">
            C
          </div>
          <h1 className="text-lg font-semibold text-[var(--chalk-text-primary)] truncate">
            {roomName}
          </h1>
        </div>
      </div>

      <div className="hidden md:flex flex-1 justify-center">
        <div className="bg-[var(--chalk-bg-secondary)] px-3 py-1.5 rounded-[var(--chalk-border-radius-full)] text-sm font-variant-numeric tabular-nums text-[var(--chalk-text-primary)]">
          {formatDuration(duration)}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 flex-1">
        {isRecording && <StatusBadge status="recording" pulse />}
        {isTranscribing && <StatusBadge status="transcribing" />}

        <div className="h-4 w-px bg-[var(--chalk-border-color)] mx-2 hidden sm:block" />

        {onLayoutChange && (
          <div className="hidden sm:flex bg-[var(--chalk-bg-tertiary)] rounded-[var(--chalk-border-radius-md)] p-1 gap-1">
            <button
              onClick={() => onLayoutChange('grid')}
              className={cn(
                'p-1.5 rounded-[var(--chalk-border-radius-sm)] transition-colors',
                layout === 'grid' 
                  ? 'bg-[var(--chalk-bg-primary)] text-[var(--chalk-text-primary)] shadow-sm' 
                  : 'text-[var(--chalk-text-secondary)] hover:text-[var(--chalk-text-primary)]'
              )}
              aria-label="Grid layout"
              aria-pressed={layout === 'grid'}
            >
              <LayoutGrid size={16} />
            </button>
            <button
              onClick={() => onLayoutChange('spotlight')}
              className={cn(
                'p-1.5 rounded-[var(--chalk-border-radius-sm)] transition-colors',
                layout === 'spotlight' 
                  ? 'bg-[var(--chalk-bg-primary)] text-[var(--chalk-text-primary)] shadow-sm' 
                  : 'text-[var(--chalk-text-secondary)] hover:text-[var(--chalk-text-primary)]'
              )}
              aria-label="Spotlight layout"
              aria-pressed={layout === 'spotlight'}
            >
              <Maximize2 size={16} />
            </button>
            <button
              onClick={() => onLayoutChange('sidebar')}
              className={cn(
                'p-1.5 rounded-[var(--chalk-border-radius-sm)] transition-colors',
                layout === 'sidebar' 
                  ? 'bg-[var(--chalk-bg-primary)] text-[var(--chalk-text-primary)] shadow-sm' 
                  : 'text-[var(--chalk-text-secondary)] hover:text-[var(--chalk-text-primary)]'
              )}
              aria-label="Sidebar layout"
              aria-pressed={layout === 'sidebar'}
            >
              <Columns size={16} />
            </button>
          </div>
        )}

        {onInvite && (
          <IconButton
            icon={<UserPlus size={20} />}
            variant="default"
            onClick={onInvite}
            aria-label="Invite participants"
            className="ml-2"
          />
        )}

        {onSettings && (
          <IconButton
            icon={<Settings size={20} />}
            variant="ghost"
            onClick={onSettings}
            aria-label="Settings"
          />
        )}
      </div>
    </header>
  );
});

MeetingHeader.displayName = 'MeetingHeader';
