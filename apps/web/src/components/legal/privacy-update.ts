import { useEffect, useState } from "react";

// Set at merge to 14 days after the deployment date.
export const PRIVACY_EFFECTIVE_DATE = "2026-11-04T00:00:00Z";
export const PRIVACY_EFFECTIVE_DATE_LABEL = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
}).format(new Date(PRIVACY_EFFECTIVE_DATE));

export function usePrivacyUpdatePending() {
  const [pending, setPending] = useState(false);
  useEffect(() => {
    function update() {
      const remaining = Date.parse(PRIVACY_EFFECTIVE_DATE) - Date.now();
      setPending(remaining > 0);
      if (remaining > 0) timer = window.setTimeout(update, Math.min(remaining, 2_147_483_647));
    }
    let timer: number | undefined;
    update();
    return () => window.clearTimeout(timer);
  }, []);
  return pending;
}
