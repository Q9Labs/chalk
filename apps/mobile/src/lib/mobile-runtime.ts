const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);

export function createStorageScopeId(apiUrl: string, apiKey: string): string {
  let hash = 2166136261;
  for (const char of `${apiUrl}|${apiKey}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
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

export function resolveDeviceLocalUrl(url: string, scriptUrl?: string | null, fallbackUrl?: string): string {
  try {
    const parsed = new URL(url);
    if (!isDeviceLocalHostname(parsed.hostname)) {
      return stripTrailingSlash(url);
    }

    const metroHost = getMetroHostFromScriptUrl(scriptUrl);
    if (!metroHost || isDeviceLocalHostname(metroHost)) {
      if (fallbackUrl) {
        return stripTrailingSlash(fallbackUrl);
      }
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
