import { useCallback, useEffect, useState } from "react";
import { durations } from "../theme/tokens";

/** A visible board stays interactive instead of acquiring the tap-to-reveal overlay. */
export function useLandscapeChrome({ fades, boardVisible }: { readonly fades: boolean; readonly boardVisible: boolean }) {
  const canHide = fades && !boardVisible;
  const [hidden, setHidden] = useState(false);
  const [shownAt, setShownAt] = useState(0);
  useEffect(() => {
    if (!canHide) {
      setHidden(false);
      return;
    }
    const timer = setTimeout(() => setHidden(true), durations.landscapeHide);
    return () => clearTimeout(timer);
  }, [canHide, shownAt]);
  const show = useCallback(() => {
    setHidden(false);
    setShownAt(Date.now());
  }, []);
  return { hidden: canHide && hidden, show };
}
