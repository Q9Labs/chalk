import { useState } from "react";
export function useEndScreenFeedback({ onSubmitFeedback }: { onSubmitFeedback?: (rating: number, comment?: string) => void } = {}) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);
  const handleFeedbackSubmit = () => {
    setFeedbackSubmitted(true);
    onSubmitFeedback?.(rating, comment);
  };
  return { rating, setRating, comment, setComment, feedbackSubmitted, handleFeedbackSubmit };
}
