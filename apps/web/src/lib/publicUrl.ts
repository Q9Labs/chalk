const PROD_PUBLIC_APP_URL = "https://chalkmeet.com";
const LOCAL_PUBLIC_APP_URL = "http://localhost:3070";

function isLocalHost(hostname: string | undefined) {
  if (!hostname) return false;
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized.endsWith(".localhost")
  );
}

export function resolvePublicAppOrigin(
  configuredPublicAppUrl?: string,
  currentOrigin?: string,
) {
  if (currentOrigin) {
    try {
      const current = new URL(currentOrigin);
      if (isLocalHost(current.hostname)) {
        return current.origin;
      }
      const normalizedConfigured = configuredPublicAppUrl?.trim();
      return normalizedConfigured || PROD_PUBLIC_APP_URL;
    } catch {
      // Ignore malformed current origin values and fall through.
    }
  }

  const normalizedConfigured = configuredPublicAppUrl?.trim();
  return (
    normalizedConfigured ||
    (import.meta.env.DEV ? LOCAL_PUBLIC_APP_URL : PROD_PUBLIC_APP_URL)
  );
}

export function getPublicAppOrigin() {
  return resolvePublicAppOrigin(
    import.meta.env.VITE_PUBLIC_APP_URL,
    typeof window === "undefined" ? undefined : window.location.origin,
  );
}

export function getPublicAppUrl(pathname = "/") {
  return new URL(pathname, getPublicAppOrigin()).toString();
}
