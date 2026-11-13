import Constants from "expo-constants";
import { getReactNativeScriptUrl, resolveAppRuntimeUrl } from "@q9labsai/chalk-react-native/runtime";
const PRODUCTION_API_BASE_URL = "https://api.chalkmeet.com";
export function getApiBaseURL(): string {
  const configured: unknown = Constants.expoConfig?.extra?.apiBaseURL;
  return resolveAppRuntimeUrl({
    configuredUrl: supportedApiBaseURL(configured) ? configured.trim() : undefined,
    scriptUrl: getReactNativeScriptUrl(),
    fallbackUrl: PRODUCTION_API_BASE_URL,
    allowDeviceLocal: typeof __DEV__ !== "undefined" && __DEV__,
  });
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
