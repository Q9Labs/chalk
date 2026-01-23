import React from 'react';
import { Settings01Icon, LayoutGridIcon, Maximize01Icon, ColumnIcon } from '../../utils/icons';
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
        <h1 className="text-sm font-medium truncate text-[var(--foreground,var(--chalk-text-primary))]/90">
          {roomName}
        </h1>
      </div>

      <div className="flex flex-1 justify-center">
        <div className={cn(
          "px-3 py-1.5 rounded-full text-sm font-medium tabular-nums flex items-center gap-2",
          "bg-[var(--secondary,var(--chalk-bg-tertiary))]/50 text-[var(--foreground,var(--chalk-text-primary))]"
        )}>
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          {formatDuration(duration)}
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 flex-1">
        {isRecording && <StatusBadge status="recording" pulse />}
        {isTranscribing && <StatusBadge status="transcribing" />}

        {onLayoutChange && (
          <div className="hidden sm:flex rounded-full p-1 gap-1 bg-[var(--secondary,var(--chalk-bg-tertiary))]/50">
            <button
              onClick={() => onLayoutChange('grid')}
              className={cn(
                'p-2 rounded-full transition-colors',
                layout === 'grid'
                  ? 'bg-[var(--accent,var(--chalk-bg-tertiary))] text-[var(--foreground,var(--chalk-text-primary))]'
                  : 'text-[var(--muted-foreground,var(--chalk-text-muted))] hover:text-[var(--foreground,var(--chalk-text-primary))] hover:bg-[var(--accent,var(--chalk-bg-tertiary))]/50'
              )}
              aria-label="Grid layout"
              aria-pressed={layout === 'grid'}
            >
              <LayoutGridIcon size={16} />
            </button>
            <button
              onClick={() => onLayoutChange('spotlight')}
              className={cn(
                'p-2 rounded-full transition-colors',
                layout === 'spotlight'
                  ? 'bg-[var(--accent,var(--chalk-bg-tertiary))] text-[var(--foreground,var(--chalk-text-primary))]'
                  : 'text-[var(--muted-foreground,var(--chalk-text-muted))] hover:text-[var(--foreground,var(--chalk-text-primary))] hover:bg-[var(--accent,var(--chalk-bg-tertiary))]/50'
              )}
              aria-label="Spotlight layout"
              aria-pressed={layout === 'spotlight'}
            >
              <Maximize01Icon size={16} />
            </button>
            <button
              onClick={() => onLayoutChange('sidebar')}
              className={cn(
                'p-2 rounded-full transition-colors',
                layout === 'sidebar'
                  ? 'bg-[var(--accent,var(--chalk-bg-tertiary))] text-[var(--foreground,var(--chalk-text-primary))]'
                  : 'text-[var(--muted-foreground,var(--chalk-text-muted))] hover:text-[var(--foreground,var(--chalk-text-primary))] hover:bg-[var(--accent,var(--chalk-bg-tertiary))]/50'
              )}
              aria-label="Sidebar layout"
              aria-pressed={layout === 'sidebar'}
            >
              <ColumnIcon size={16} />
            </button>
          </div>
        )}

        {onSettings && (
          <button
            onClick={onSettings}
            className={cn(
              "p-2 rounded-full transition-colors",
              "text-[var(--muted-foreground,var(--chalk-text-muted))]",
              "hover:text-[var(--foreground,var(--chalk-text-primary))] hover:bg-[var(--accent,var(--chalk-bg-tertiary))]/50"
            )}
            aria-label="Settings"
          >
            <Settings01Icon size={18} />
          </button>
        )}
      </div>
    </header>
  );
});

MeetingHeader.displayName = 'MeetingHeader';
