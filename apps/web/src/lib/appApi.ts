const PROD_API_URL = "https://chalk-api.q9labs.ai";
const LOCAL_API_URL = "http://localhost:8080";

export function isLocalHost(hostname: string | undefined) {
  if (!hostname) return false;
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]" || normalized.endsWith(".localhost");
}

export function resolveApiUrl(configuredApiUrl?: string, currentHostname?: string) {
  const normalizedConfigured = configuredApiUrl?.trim();
  const currentIsLocal = isLocalHost(currentHostname);
  if (!normalizedConfigured) {
    return currentIsLocal ? LOCAL_API_URL : PROD_API_URL;
  }

  try {
    const configuredHost = new URL(normalizedConfigured).hostname;
    const configuredIsLocal = isLocalHost(configuredHost);
    if (currentIsLocal) {
      return configuredIsLocal ? normalizedConfigured : LOCAL_API_URL;
    }
    if (configuredIsLocal) {
      return PROD_API_URL;
    }
  } catch {
    return currentIsLocal ? LOCAL_API_URL : PROD_API_URL;
  }

  return normalizedConfigured || PROD_API_URL;
}

export function getApiUrl() {
  return resolveApiUrl(import.meta.env.VITE_API_URL, typeof window === "undefined" ? undefined : window.location.hostname);
}
