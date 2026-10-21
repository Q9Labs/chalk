import { useEffect, useState } from "react";

// Set at merge to 14 days after the deployment date.
export const PRIVACY_EFFECTIVE_DATE = "2026-11-04T00:00:00Z";
export const PRIVACY_EFFECTIVE_DATE_LABEL = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
}).format(new Date(PRIVACY_EFFECTIVE_DATE));
export const PRIVACY_PREVIOUS_EFFECTIVE_DATE_LABEL = "7 August 2026";
export const PRIVACY_ARCHIVE_TITLE = `Privacy Policy effective ${PRIVACY_PREVIOUS_EFFECTIVE_DATE_LABEL} (replaced on ${PRIVACY_EFFECTIVE_DATE_LABEL})`;
export const PRIVACY_NOTICE_TEXT = `We're updating our Privacy Policy on ${PRIVACY_EFFECTIVE_DATE_LABEL}.`;
export const PRIVACY_NOTICE_LINK_TEXT = "See what's changing.";
export const PRIVACY_NOTICE_DISMISSAL_KEY = `chalk:privacy-notice:${PRIVACY_EFFECTIVE_DATE}`;

export function usePrivacyUpdatePending() {
  const [revision, setRevision] = useState(0);
  const pending = Date.now() < Date.parse(PRIVACY_EFFECTIVE_DATE);
  useEffect(() => {
    if (!pending) return;
    const remaining = Date.parse(PRIVACY_EFFECTIVE_DATE) - Date.now();
    const timer = setTimeout(() => setRevision((current) => current + 1), Math.min(Math.max(remaining, 0), 2_147_483_647));
    return () => clearTimeout(timer);
  }, [pending, revision]);
  return pending;
}
