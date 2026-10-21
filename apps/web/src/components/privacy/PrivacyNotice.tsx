import { useEffect, useState } from "react";
import { PRIVACY_EFFECTIVE_DATE, PRIVACY_NOTICE_TEXT, PRIVACY_NOTICE_LINK_TEXT, PRIVACY_NOTICE_DISMISSAL_KEY } from "../../lib/privacy-policy";

export function PrivacyNotice() {
  const [revision, setRevision] = useState(0);
  const pending = Date.now() < Date.parse(PRIVACY_EFFECTIVE_DATE);
  useEffect(() => {
    if (!pending) return;
    const remaining = Date.parse(PRIVACY_EFFECTIVE_DATE) - Date.now();
    const timer = setTimeout(() => setRevision((current) => current + 1), Math.min(Math.max(remaining, 0), 2_147_483_647));
    return () => clearTimeout(timer);
  }, [pending, revision]);
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
