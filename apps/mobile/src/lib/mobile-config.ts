import Constants from "expo-constants";

import { getReactNativeScriptUrl, resolveAppRuntimeUrl } from "@q9labsai/chalk-react-native/runtime";

const PRODUCTION_BROKER_URL = "https://chalkmeet.com/local-chalk";

type MobileExpoExtra = {
  readonly brokerUrl?: unknown;
  readonly telemetryEnabled?: unknown;
};

export type MobileRuntimeConfig = {
  readonly brokerUrl: string;
  readonly telemetryEnabled: boolean;
};

export function getMobileRuntimeConfig(): MobileRuntimeConfig {
  const extra = readMobileExpoExtra();
  const configuredBrokerUrl = supportedBrokerUrl(extra.brokerUrl) ? extra.brokerUrl.trim() : undefined;

  return {
    brokerUrl: resolveAppRuntimeUrl({
      configuredUrl: configuredBrokerUrl,
      scriptUrl: getReactNativeScriptUrl(),
      fallbackUrl: PRODUCTION_BROKER_URL,
      allowDeviceLocal: typeof __DEV__ !== "undefined" && __DEV__,
    }),
    telemetryEnabled: extra.telemetryEnabled === true,
  };
}

export function getBrokerUrl(): string {
  return getMobileRuntimeConfig().brokerUrl;
}

export function isMobileTelemetryEnabled(): boolean {
  return getMobileRuntimeConfig().telemetryEnabled;
}

function readMobileExpoExtra(): MobileExpoExtra {
  const extra: unknown = Constants.expoConfig?.extra;
  return isRecord(extra) ? extra : {};
}

function supportedBrokerUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }

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
