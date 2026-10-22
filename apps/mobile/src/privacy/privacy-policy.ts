// Keep this app-local instant aligned with web; the release contract checks both.
export const MOBILE_PRIVACY_EFFECTIVE_DATE = "2026-11-06T00:00:00Z";
const effectiveDateLabel = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
}).format(new Date(MOBILE_PRIVACY_EFFECTIVE_DATE));
export const MOBILE_PRIVACY_NOTICE_TEXT = `We're updating our Privacy Policy on ${effectiveDateLabel}.`;
export const MOBILE_PRIVACY_NOTICE_LINK_TEXT = "See what's changing.";
