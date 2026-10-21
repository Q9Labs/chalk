import { useEffect, useState } from "react";
import { PRIVACY_NOTICE_TEXT, PRIVACY_NOTICE_LINK_TEXT, PRIVACY_NOTICE_DISMISSAL_KEY, usePrivacyUpdatePending } from "../../../../shared/privacy-update";

export function PrivacyNotice() {
  const pending = usePrivacyUpdatePending();
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(PRIVACY_NOTICE_DISMISSAL_KEY) === "dismissed");
    } catch {
      // Storage can be disabled; the notice still works for this visit.
      setDismissed(false);
    }
  }, []);

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(PRIVACY_NOTICE_DISMISSAL_KEY, "dismissed");
    } catch {
      // Dismissal remains effective for this visit when storage is disabled.
    }
  }

  if (!pending || dismissed) return null;
  return (
    <aside className="privacy-notice" aria-label="Privacy Policy update">
      <p>
        {PRIVACY_NOTICE_TEXT} <a href="/privacy#whats-changing">{PRIVACY_NOTICE_LINK_TEXT}</a>
      </p>
      <button type="button" className="privacy-notice-dismiss" onClick={dismiss} aria-label="Dismiss Privacy Policy notice">
        Dismiss
      </button>
    </aside>
  );
}
