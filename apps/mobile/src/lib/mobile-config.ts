import Constants from "expo-constants";
import { getReactNativeScriptUrl, resolveAppRuntimeUrl } from "@q9labsai/chalk-react-native/runtime";
const PRODUCTION_API_BASE_URL = "https://api.chalkmeet.com";
type MobileExpoExtra = {
  readonly apiBaseURL?: unknown;
};
export function getApiBaseURL(): string {
  const extra = readMobileExpoExtra();
  const configuredApiBaseURL = supportedApiBaseURL(extra.apiBaseURL) ? extra.apiBaseURL.trim() : undefined;
  return resolveAppRuntimeUrl({
    configuredUrl: configuredApiBaseURL,
    scriptUrl: getReactNativeScriptUrl(),
    fallbackUrl: PRODUCTION_API_BASE_URL,
    allowDeviceLocal: typeof __DEV__ !== "undefined" && __DEV__,
  });
}
function readMobileExpoExtra(): MobileExpoExtra {
  const extra: unknown = Constants.expoConfig?.extra;
  return isRecord(extra) ? extra : {};
}
function supportedApiBaseURL(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
function isRecord(value: unknown): value is MobileExpoExtra {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
