import { memo } from "react";

import { CheckmarkCircle02Icon, Clock01Icon, UserGroupIcon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { EndScreenActions } from "./end-screen/EndScreenActions";
import { EndScreenDownloadsSection } from "./end-screen/EndScreenDownloadsSection";
import { EndScreenFeedbackSection } from "./end-screen/EndScreenFeedbackSection";
import { formatDuration } from "./end-screen/formatDuration";
import { useEndScreenFeedback } from "./end-screen/useEndScreenFeedback";

export interface EndScreenProps {
  roomName?: string;
  duration?: number;
  participantCount?: number;

  hasRecording?: boolean;
  recordingUrl?: string;
  onDownloadRecording?: () => void;

  hasTranscription?: boolean;
  onDownloadTranscription?: (format: "txt" | "srt" | "vtt") => void;

  onSubmitFeedback?: (rating: number, comment?: string) => void;
  showFeedback?: boolean;

  onRejoin?: () => void;
  onNewMeeting?: () => void;
  onGoHome?: () => void;

  className?: string;
}

function EndScreenBase({ roomName, duration = 0, participantCount = 0, hasRecording = false, recordingUrl, onDownloadRecording, hasTranscription = false, onDownloadTranscription, onSubmitFeedback, showFeedback = true, onRejoin, onNewMeeting, onGoHome, className }: EndScreenProps) {
  const { rating, setRating, comment, setComment, feedbackSubmitted, handleFeedbackSubmit } = useEndScreenFeedback({ onSubmitFeedback });

  const handleDownloadRecording = () => {
    if (onDownloadRecording) {
      onDownloadRecording();
    } else if (recordingUrl) {
      window.open(recordingUrl, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <div data-chalk className={cn("flex flex-col items-center justify-center min-h-screen bg-[var(--background)] p-4 font-sans text-[var(--foreground)]", className)}>
      <div className="w-full max-w-lg bg-[var(--card)] rounded-[var(--chalk-border-radius-lg)] border border-[var(--border)] shadow-[var(--chalk-shadow-lg)] overflow-hidden">
        <div className="p-8 text-center space-y-6">
          <div className="flex flex-col items-center gap-4">
            <div className="h-16 w-16 rounded-full bg-[var(--success)]/10 flex items-center justify-center text-[var(--success)]">
              <CheckmarkCircle02Icon size={32} />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">Meeting Ended</h1>
          </div>

          <div className="space-y-2">
            {roomName && <h2 className="text-xl font-medium">{roomName}</h2>}
            <div className="flex items-center justify-center gap-4 text-[var(--muted-foreground)] text-sm">
              <div className="flex items-center gap-1.5">
                <Clock01Icon size={14} />
                <span>{formatDuration(duration)}</span>
              </div>
              <div className="w-1 h-1 rounded-full bg-[var(--muted-foreground)]" />
              <div className="flex items-center gap-1.5">
                <UserGroupIcon size={14} />
                <span>{participantCount === 1 ? "1 participant" : `${participantCount} participants`}</span>
              </div>
            </div>
          </div>
        </div>

        <EndScreenFeedbackSection show={showFeedback && Boolean(onSubmitFeedback)} feedbackSubmitted={feedbackSubmitted} rating={rating} comment={comment} onSetRating={setRating} onSetComment={setComment} onSubmit={handleFeedbackSubmit} />

        <EndScreenDownloadsSection hasRecording={hasRecording} hasTranscription={hasTranscription} onDownloadRecording={handleDownloadRecording} onDownloadTranscription={onDownloadTranscription} />

        <EndScreenActions onRejoin={onRejoin} onNewMeeting={onNewMeeting} onGoHome={onGoHome} />
      </div>
    </div>
  );
}

export const EndScreen = memo(EndScreenBase);
EndScreen.displayName = "EndScreen";
