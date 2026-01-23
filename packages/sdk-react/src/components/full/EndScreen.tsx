import { useState, memo } from 'react';
import {
  CheckmarkCircle02Icon, StarIcon, Clock01Icon, UserGroupIcon, Download01Icon,
  FileTextIcon, RefreshIcon, PlusSignIcon, Home01Icon, Video01Icon
} from '../../utils/icons';
import {
  Textarea,
  IconButton
} from '../atomic';
import { cn } from '../../utils/cn';
import { usePrefersReducedMotion } from '../../hooks/useMediaQuery';

export interface EndScreenProps {
  roomName?: string;
  duration?: number;
  participantCount?: number;
  
  hasRecording?: boolean;
  recordingUrl?: string;
  onDownloadRecording?: () => void;
  
  hasTranscription?: boolean;
  onDownloadTranscription?: (format: 'txt' | 'srt' | 'vtt') => void;
  
  onSubmitFeedback?: (rating: number, comment?: string) => void;
  showFeedback?: boolean;
  
  onRejoin?: () => void;
  onNewMeeting?: () => void;
  onGoHome?: () => void;
  
  className?: string;
}

const formatDuration = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    const remainingMins = minutes % 60;
    return `${hours}h ${remainingMins}m`;
  }
  return `${minutes} min`;
};

function EndScreenBase({
  roomName,
  duration = 0,
  participantCount = 0,
  hasRecording = false,
  recordingUrl,
  onDownloadRecording,
  hasTranscription = false,
  onDownloadTranscription,
  onSubmitFeedback,
  showFeedback = true,
  onRejoin,
  onNewMeeting,
  onGoHome,
  className,
}: EndScreenProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);

  const handleFeedbackSubmit = () => {
    if (onSubmitFeedback && rating > 0) {
      onSubmitFeedback(rating, comment);
      setFeedbackSubmitted(true);
    }
  };

  const handleDownloadRecording = () => {
    if (onDownloadRecording) {
      onDownloadRecording();
    } else if (recordingUrl) {
      window.open(recordingUrl, '_blank');
    }
  };

  return (
    <div data-chalk className={cn(
      "flex flex-col items-center justify-center min-h-screen bg-[var(--background)] p-4 font-sans text-[var(--foreground)]",
      className
    )}>
      <div className={cn(
        "w-full max-w-lg bg-[var(--card)] rounded-[var(--chalk-border-radius-lg)] border border-[var(--border)] shadow-[var(--chalk-shadow-lg)] overflow-hidden",
        !prefersReducedMotion && "animate-in fade-in zoom-in-95 duration-300"
      )}>
        
        <div className="p-8 text-center space-y-6">
          <div className="flex flex-col items-center gap-4">
            <div className="h-16 w-16 rounded-full bg-[var(--success)]/10 flex items-center justify-center text-[var(--success)]">
              <CheckmarkCircle02Icon size={32} />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">Meeting Ended</h1>
          </div>

          <div className="space-y-2">
            {roomName && (
              <h2 className="text-xl font-medium">{roomName}</h2>
            )}
            <div className="flex items-center justify-center gap-4 text-[var(--muted-foreground)] text-sm">
              <div className="flex items-center gap-1.5">
                <Clock01Icon size={14} />
                <span>{formatDuration(duration)}</span>
              </div>
              <div className="w-1 h-1 rounded-full bg-[var(--muted-foreground)]" />
              <div className="flex items-center gap-1.5">
                <UserGroupIcon size={14} />
                <span>{participantCount} participants</span>
              </div>
            </div>
          </div>
        </div>

        {(showFeedback && onSubmitFeedback) && (
          <div className="border-t border-[var(--border)] p-6 space-y-4">
            {!feedbackSubmitted ? (
              <>
                <div className="text-center">
                  <h3 className="text-sm font-medium mb-3">How was the quality?</h3>
                  <div className="flex justify-center gap-2">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <button
                        key={star}
                        type="button"
                        onClick={() => setRating(star)}
                        className={cn(
                          "p-1 rounded-full hover:scale-110 transition-transform focus:outline-none focus:ring-2 focus:ring-[var(--ring)]",
                          star <= rating ? "text-[var(--warning)] fill-[var(--warning)]" : "text-[var(--muted-foreground)]"
                        )}
                        aria-label={`Rate ${star} stars`}
                      >
                        <StarIcon 
                          size={28} 
                          fill={star <= rating ? "currentColor" : "none"} 
                        />
                      </button>
                    ))}
                  </div>
                </div>
                
                {rating > 0 && (
                  <div className={cn("space-y-3", !prefersReducedMotion && "animate-in fade-in slide-in-from-top-2")}>
                    <Textarea
                      placeholder="Any comments or issues?"
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      resize="none"
                      className="min-h-[80px]"
                    />
                    <button
                      type="button"
                      onClick={handleFeedbackSubmit}
                      className="w-full py-2 bg-[var(--muted)] hover:bg-[var(--muted)]/80 text-[var(--foreground)] text-sm font-medium rounded-[var(--chalk-border-radius-md)] transition-colors"
                    >
                      Submit Feedback
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className={cn("text-center py-4 text-[var(--success)]", !prefersReducedMotion && "animate-in zoom-in")}>
                <p className="font-medium">Thank you for your feedback!</p>
              </div>
            )}
          </div>
        )}

        {(hasRecording || hasTranscription) && (
          <div className="border-t border-[var(--border)] p-6 space-y-4 bg-[var(--muted)]/30">
            {hasRecording && (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-md bg-[var(--accent)]/10 text-[var(--accent)]">
                    <Video01Icon size={18} />
                  </div>
                  <div className="text-sm">
                    <p className="font-medium">Recording ready</p>
                    <p className="text-[var(--muted-foreground)] text-xs">MP4 format</p>
                  </div>
                </div>
                <IconButton
                  icon={<Download01Icon size={18} />}
                  onClick={handleDownloadRecording}
                  aria-label="Download Recording"
                  variant="outline"
                  size="sm"
                />
              </div>
            )}

            {hasTranscription && (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-md bg-[var(--success)]/10 text-[var(--success)]">
                    <FileTextIcon size={18} />
                  </div>
                  <div className="text-sm">
                    <p className="font-medium">Transcription</p>
                    <p className="text-[var(--muted-foreground)] text-xs">Available formats</p>
                  </div>
                </div>
                <div className="flex gap-1">
                  {['txt', 'srt', 'vtt'].map((fmt) => (
                    <button
                      key={fmt}
                      type="button"
                      onClick={() => onDownloadTranscription?.(fmt as any)}
                      className="px-2 py-1 text-xs font-medium uppercase rounded border border-[var(--border)] hover:bg-[var(--muted)] transition-colors"
                    >
                      {fmt}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="border-t border-[var(--border)] p-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {onRejoin && (
            <button
              type="button"
              onClick={onRejoin}
              className="col-span-2 sm:col-span-1 flex flex-col items-center justify-center gap-2 p-3 rounded-[var(--chalk-border-radius-md)] hover:bg-[var(--muted)] transition-colors text-sm font-medium text-[var(--foreground)]"
            >
              <RefreshIcon size={20} className="text-[var(--muted-foreground)]" />
              Rejoin
            </button>
          )}

          {onNewMeeting && (
            <button
              type="button"
              onClick={onNewMeeting}
              className="col-span-1 flex flex-col items-center justify-center gap-2 p-3 rounded-[var(--chalk-border-radius-md)] hover:bg-[var(--muted)] transition-colors text-sm font-medium text-[var(--foreground)]"
            >
              <PlusSignIcon size={20} className="text-[var(--muted-foreground)]" />
              New Meeting
            </button>
          )}

          {onGoHome && (
            <button
              type="button"
              onClick={onGoHome}
              className="col-span-1 flex flex-col items-center justify-center gap-2 p-3 rounded-[var(--chalk-border-radius-md)] hover:bg-[var(--muted)] transition-colors text-sm font-medium text-[var(--foreground)]"
            >
              <Home01Icon size={20} className="text-[var(--muted-foreground)]" />
              Home
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export const EndScreen = memo(EndScreenBase);
EndScreen.displayName = 'EndScreen';
