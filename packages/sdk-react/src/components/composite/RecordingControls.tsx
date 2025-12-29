import { useEffect, useState } from 'react';
import { cn } from '../../utils/cn';
import { StatusBadge, IconButton } from '../atomic';
import { Play, Pause, Square, Circle } from 'lucide-react';

export interface RecordingControlsProps {
  isRecording: boolean;
  duration?: number;
  onStart?: () => void;
  onStop?: () => void;
  onPause?: () => void;
  isPaused?: boolean;
  canRecord?: boolean;
  className?: string;
}

export const RecordingControls = ({
  isRecording,
  duration = 0,
  onStart,
  onStop,
  onPause,
  isPaused,
  canRecord = true,
  className,
}: RecordingControlsProps) => {
  const [elapsed, setElapsed] = useState(duration);

  useEffect(() => {
    setElapsed(duration);
  }, [duration]);

  useEffect(() => {
    if (isRecording && !isPaused) {
      const interval = setInterval(() => {
        setElapsed(e => e + 1);
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [isRecording, isPaused]);

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const renderBadge = () => {
    if (isRecording && !isPaused) {
      return <StatusBadge status="recording" pulse={true} />;
    }
    
    if (isRecording && isPaused) {
      return (
        <div className="inline-flex items-center gap-1.5 rounded-[var(--chalk-border-radius-sm)] font-medium px-2 py-1 text-xs bg-yellow-500/10 text-yellow-500">
           <Circle size={12} className="fill-current" />
           <span>PAUSED</span>
        </div>
      );
    }

    return (
      <div className="inline-flex items-center gap-1.5 rounded-[var(--chalk-border-radius-sm)] font-medium px-2 py-1 text-xs bg-background-tertiary text-foreground-secondary">
         <div className="w-2.5 h-2.5 rounded-full bg-foreground-muted" />
         <span>READY</span>
      </div>
    );
  };

  return (
    <div className={cn("flex items-center gap-3 px-3 py-1.5 bg-background-secondary rounded-full border border-border", className)}>
      {renderBadge()}
      
      <div className="font-mono text-sm min-w-[3rem]">
        {formatTime(elapsed)}
      </div>
      
      {canRecord && (
        <div className="flex items-center gap-1 border-l border-border pl-2">
          {!isRecording ? (
             <IconButton 
                icon={<Play size={16} className="fill-current" />} 
                onClick={onStart} 
                variant="ghost" 
                size="sm"
                aria-label="Start recording"
                className="text-red-500 hover:text-red-600 hover:bg-red-500/10"
             />
          ) : (
             <>
               {onPause && (
                  <IconButton 
                    icon={isPaused ? <Play size={16} className="fill-current" /> : <Pause size={16} className="fill-current" />} 
                    onClick={onPause} 
                    variant="ghost" 
                    size="sm"
                    aria-label={isPaused ? "Resume recording" : "Pause recording"}
                  />
               )}
               <IconButton 
                  icon={<Square size={16} className="fill-current" />} 
                  onClick={onStop} 
                  variant="ghost" 
                  size="sm"
                  aria-label="Stop recording"
                  className="text-foreground-secondary hover:text-foreground-primary"
               />
             </>
          )}
        </div>
      )}
    </div>
  );
};
