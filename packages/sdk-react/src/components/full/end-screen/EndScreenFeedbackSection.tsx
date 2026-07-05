import { StarIcon } from "../../../utils/icons";
import { cn } from "../../../utils/cn";
import { Textarea } from "../../atomic";

interface EndScreenFeedbackSectionProps {
  show: boolean;
  feedbackSubmitted: boolean;
  rating: number;
  comment: string;
  onSetRating: (rating: number) => void;
  onSetComment: (comment: string) => void;
  onSubmit: () => void;
}

export function EndScreenFeedbackSection({ show, feedbackSubmitted, rating, comment, onSetRating, onSetComment, onSubmit }: EndScreenFeedbackSectionProps) {
  if (!show) {
    return null;
  }

  return (
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
                  onClick={() => onSetRating(star)}
                  className={cn("p-1 rounded-full hover:scale-110 transition-transform focus:outline-none focus:ring-2 focus:ring-[var(--ring)]", star <= rating ? "text-[var(--warning)] fill-[var(--warning)]" : "text-[var(--muted-foreground)]")}
                  aria-label={`Rate ${star} stars`}
                >
                  <StarIcon size={28} fill={star <= rating ? "currentColor" : "none"} />
                </button>
              ))}
            </div>
          </div>

          {rating > 0 && (
            <div className="space-y-3">
              <Textarea placeholder="Any comments or issues?" value={comment} onChange={(event) => onSetComment(event.target.value)} resize="none" className="min-h-[80px]" />
              <button type="button" onClick={onSubmit} className="w-full py-2 bg-[var(--muted)] hover:bg-[var(--muted)]/80 text-[var(--foreground)] text-sm font-medium rounded-[var(--chalk-border-radius-md)] transition-colors">
                Submit Feedback
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="text-center py-4 text-[var(--success)]">
          <p className="font-medium">Thank you for your feedback!</p>
        </div>
      )}
    </div>
  );
}
