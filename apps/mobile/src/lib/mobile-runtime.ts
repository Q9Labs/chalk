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

export function resolveDeviceLocalUrl(url: string, scriptUrl?: string | null): string {
  try {
    const parsed = new URL(url);
    if (!LOCAL_HOSTNAMES.has(parsed.hostname)) {
      return stripTrailingSlash(url);
    }

    const metroHost = getMetroHostFromScriptUrl(scriptUrl);
    if (!metroHost || LOCAL_HOSTNAMES.has(metroHost)) {
      return stripTrailingSlash(url);
    }

    parsed.hostname = metroHost;
    return stripTrailingSlash(parsed.toString());
  } catch {
    return stripTrailingSlash(url);
  }
}
