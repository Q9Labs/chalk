import { preconnect } from "@q9labsai/chalk-client";
import { publicAPIBaseURL, publicSyncDirectURL, publicSyncURL } from "../../lib/chalk-access";
import type * as SpaceCall from "./SpaceCall";

/** The call UI and media stack, which a participant needs only once they ask to join. */
export type CallSurface = typeof SpaceCall;

// A visitor on the lobby or the leave screen usually presses Join within seconds. Sync closes an idle socket after 5 s, so the
// SDK replaces it for this long after the last action: about four short-lived sockets at most, then none.
const LOBBY_KEEP_WARM_MS = 15_000;

/**
 * Opens the API connection and the Sync WebSocket upgrade before Join, so joining skips both. The call UI stays unloaded
 * until Join: the call-performance route budget guards that. Call this again as the visitor acts to extend the window.
 */
export function warmCall(): void {
  const apiBaseURL = publicAPIBaseURL();
  preconnect({ baseUrl: apiBaseURL, syncUrl: publicSyncURL(apiBaseURL), syncDirectUrl: publicSyncDirectURL().syncDirectURL, keepWarmMs: LOBBY_KEEP_WARM_MS });
}

let callSurfaceLoad: Promise<CallSurface> | undefined;

/** Loads the call UI once. A failed load is forgotten, so the next call tries again. */
export function loadCallSurface(): Promise<CallSurface> {
  callSurfaceLoad ??= import("./SpaceCall").catch((cause: unknown) => {
    callSurfaceLoad = undefined;
    throw cause;
  });
  return callSurfaceLoad;
}
