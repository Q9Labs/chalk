/**
 * The direct door: one public host that serves Sync and the SFU signalling calls without the Cloudflare Tunnel.
 * Every client in a page shares one memory of a failed door, so a blocked network pays the cost once.
 */

/** Which network path carried one use of a plane. `fellBack` means a direct door was available and the Tunnel carried the use anyway. */
export type TransportPath = {
  readonly plane: "sync" | "signalling";
  readonly path: "direct" | "tunnel";
  readonly fellBack: boolean;
};

/** `auto` uses the direct door a grant advertises; `off` keeps every call on the Tunnel, for a control run. */
export type DirectPathMode = "auto" | "off";

/** A blocked direct door costs at most this much before the Tunnel carries the call. */
export const DIRECT_PATH_ATTEMPT_TIMEOUT_MS = 2_500;
/** After a failed attempt, later calls skip the direct door for this long. */
export const DIRECT_PATH_FAILURE_MEMORY_MS = 10 * 60_000;

/** Host to the time until which its direct door is skipped. Expired entries are dropped on the next failure. */
export type DirectPathMemory = Map<string, number>;

export const sharedDirectPathMemory: DirectPathMemory = new Map();

export function directPathBlocked(memory: DirectPathMemory, host: string, now: number): boolean {
  return (memory.get(host) ?? 0) > now;
}

export function markDirectPathFailed(memory: DirectPathMemory, host: string, now: number, memoryMs: number = DIRECT_PATH_FAILURE_MEMORY_MS): void {
  for (const [other, until] of memory) if (until <= now) memory.delete(other);
  memory.set(host, now + memoryMs);
}

/** The https origin a grant advertises, or null for anything else: a path, query, credentials or another scheme never reaches a request. */
export function directOrigin(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const bare = url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
    return url.protocol === "https:" && bare ? url : null;
  } catch {
    return null;
  }
}

/** The direct Sync URL on the host a grant advertises. */
export function directSyncUrl(origin: URL): string {
  return `wss://${origin.host}/v1/sync`;
}
