// Apart from contracts.ts so the browser client can check a return path without loading the SDK schemas that file imports.

/** The one-time handle the API puts in the consent link. It is a secret until the request is decided. */
export const CONSENT_HANDLE_PATTERN = "chalk_oar_[A-Za-z0-9_-]{20,100}";

/** A path `/auth/start` may send the person back to: a dashboard page, or one carrying a consent request. */
export const DASHBOARD_RETURN_PATH = new RegExp(`^/dashboard(?:/[a-zA-Z0-9/_-]*)?(?:\\?request=${CONSENT_HANDLE_PATTERN})?$`);
