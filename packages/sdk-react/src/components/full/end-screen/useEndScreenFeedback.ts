import { useState } from "react";

interface UseEndScreenFeedbackParams {
  onSubmitFeedback?: (rating: number, comment?: string) => void;
}

export function useEndScreenFeedback({ onSubmitFeedback }: UseEndScreenFeedbackParams) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);

  const handleFeedbackSubmit = () => {
    if (onSubmitFeedback && rating > 0) {
      onSubmitFeedback(rating, comment);
      setFeedbackSubmitted(true);
    }
  };

  return {
    rating,
    setRating,
    comment,
    setComment,
    feedbackSubmitted,
    handleFeedbackSubmit,
  };
}
