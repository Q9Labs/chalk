import { NativeModules, Platform } from "react-native";
export { createStorageScopeId } from "./utils/storage-scope";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);

export interface NativeDeviceInfo {
  appVersion: string | null;
  platform: string | null;
  osVersion: string | null;
  reactNativeVersion: string | null;
  brand: string | null;
  manufacturer: string | null;
  model: string | null;
  systemName: string | null;
  interfaceIdiom: string | null;
  hermesEnabled: boolean;
  scriptUrl: string | null;
}

export function shouldAutoReadClipboard({ platform, isSimulator }: { platform: string; isSimulator: boolean }): boolean {
  return !(platform === "ios" && isSimulator);
}

export function getReactNativeScriptUrl(): string | null {
  return NativeModules.SourceCode?.scriptURL ?? NativeModules.SourceCode?.getConstants?.().scriptURL ?? null;
}

export function getMetroHostFromScriptUrl(scriptUrl: string | null | undefined): string | null {
  if (!scriptUrl) {
    return null;
  }

  try {
    const parsed = new URL(scriptUrl);
    return parsed.hostname || null;
  } catch {
    return null;
  }
}

export function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function isDeviceLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname);
}

export function isDeviceLocalUrl(url: string): boolean {
  try {
    return isDeviceLocalHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function isConfiguredLocalApiUrl(configuredUrl?: string | null): boolean {
  const candidate = configuredUrl?.trim();
  return !!candidate && isDeviceLocalUrl(candidate);
}

export function canUseLocalHostBootstrap(apiUrl: string, allowDeviceLocal: boolean): boolean {
  return allowDeviceLocal && isDeviceLocalUrl(apiUrl);
}

export function resolveDeviceLocalUrl(url: string, scriptUrl?: string | null, fallbackUrl?: string): string {
  try {
    const parsed = new URL(url);
    if (!isDeviceLocalHostname(parsed.hostname)) {
      return stripTrailingSlash(url);
    }

    const metroHost = getMetroHostFromScriptUrl(scriptUrl);
    if (!metroHost) {
      if (fallbackUrl) {
        return stripTrailingSlash(fallbackUrl);
      }
      return stripTrailingSlash(url);
    }

    if (isDeviceLocalHostname(metroHost)) {
      return stripTrailingSlash(url);
    }

    parsed.hostname = metroHost;
    return stripTrailingSlash(parsed.toString());
  } catch {
    return stripTrailingSlash(url);
  }
}

export function resolveAppRuntimeUrl({ configuredUrl, scriptUrl, fallbackUrl, allowDeviceLocal }: { configuredUrl?: string | null; scriptUrl?: string | null; fallbackUrl: string; allowDeviceLocal: boolean }): string {
  const candidate = configuredUrl?.trim();
  if (!candidate) {
    return stripTrailingSlash(fallbackUrl);
  }

  if (!allowDeviceLocal && isDeviceLocalUrl(candidate)) {
    return stripTrailingSlash(fallbackUrl);
  }

  return resolveDeviceLocalUrl(candidate, scriptUrl, fallbackUrl);
}

export function getReactNativeVersionString(): string | null {
  const version = Platform.constants?.reactNativeVersion;
  if (!version) {
    return null;
  }

  const major = typeof version.major === "number" ? version.major : null;
  const minor = typeof version.minor === "number" ? version.minor : null;
  const patch = typeof version.patch === "number" ? version.patch : null;
  if (major === null || minor === null || patch === null) {
    return null;
  }

  return `${major}.${minor}.${patch}`;
}

export function isHermesEnabled(): boolean {
  return "HermesInternal" in globalThis;
}

const readPlatformString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

export function getNativeDeviceInfo({ appVersion = null, scriptUrl = getReactNativeScriptUrl() }: { appVersion?: string | null; scriptUrl?: string | null } = {}): NativeDeviceInfo {
  const constants = (Platform.constants ?? {}) as Record<string, unknown>;

  return {
    appVersion,
    platform: Platform.OS,
    osVersion: String(Platform.Version),
    reactNativeVersion: getReactNativeVersionString(),
    brand: readPlatformString(constants.Brand),
    manufacturer: readPlatformString(constants.Manufacturer),
    model: readPlatformString(constants.Model),
    systemName: readPlatformString(constants.systemName),
    interfaceIdiom: readPlatformString(constants.interfaceIdiom),
    hermesEnabled: isHermesEnabled(),
    scriptUrl,
  };
}
