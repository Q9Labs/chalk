// Set at merge to 14 days after the deployment date.
export const PRIVACY_EFFECTIVE_DATE = "2026-11-04T00:00:00Z";
export const PRIVACY_EFFECTIVE_DATE_LABEL = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
}).format(new Date(PRIVACY_EFFECTIVE_DATE));
export const PRIVACY_PREVIOUS_EFFECTIVE_DATE_LABEL = "7 August 2026";
export const PRIVACY_ARCHIVE_TITLE = `Archived Privacy Policy — ${PRIVACY_PREVIOUS_EFFECTIVE_DATE_LABEL}`;
export const PRIVACY_NOTICE_TEXT = `We're updating our Privacy Policy on ${PRIVACY_EFFECTIVE_DATE_LABEL}.`;
export const PRIVACY_NOTICE_LINK_TEXT = "See what's changing.";
export const PRIVACY_NOTICE_DISMISSAL_KEY = `chalk:privacy-notice:${PRIVACY_EFFECTIVE_DATE}`;
