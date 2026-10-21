import { useEffect, useState } from "react";
import { PRIVACY_EFFECTIVE_DATE, PRIVACY_EFFECTIVE_DATE_LABEL, usePrivacyUpdatePending } from "../legal/privacy-update";

const DISMISSAL_KEY = `chalk:privacy-notice:${PRIVACY_EFFECTIVE_DATE}`;

export function PrivacyNotice() {
  const pending = usePrivacyUpdatePending();
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISSAL_KEY) === "dismissed");
    } catch {
      // Storage can be disabled; the notice still works for this visit.
      setDismissed(false);
    }
  }, []);

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSAL_KEY, "dismissed");
    } catch {
      // Dismissal remains effective for this visit when storage is disabled.
    }
  }

  if (!pending || dismissed) return null;
  return (
    <aside className="wrap privacy-notice" aria-label="Privacy Policy update">
      <p>
        We're updating our Privacy Policy on {PRIVACY_EFFECTIVE_DATE_LABEL}. <a href="/privacy#whats-changing">See what's changing.</a>
      </p>
      <button type="button" className="btn sec sm" onClick={dismiss} aria-label="Dismiss Privacy Policy notice">
        Dismiss
      </button>
    </aside>
  );
}
