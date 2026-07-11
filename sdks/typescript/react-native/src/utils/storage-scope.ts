export function createStorageScopeId(apiUrl: string, apiKey: string): string {
  let hash = 2166136261;
  for (const char of `${apiUrl}|${apiKey}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
