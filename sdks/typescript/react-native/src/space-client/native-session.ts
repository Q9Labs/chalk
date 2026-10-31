import { newSessionId } from "@q9labsai/chalk-client";

/** A session ends after this long in the background, but never while a call is open. */
export const NATIVE_SESSION_BACKGROUND_MS = 30 * 60 * 1000;

type NativeAppState = {
  readonly addEventListener: (type: "change", listener: (state: string) => void) => unknown;
};

export type NativeSession = {
  readonly current: () => string;
  /** Each client reports its own call; the session counts as in a call until every client's call has closed. */
  readonly setCallOpen: (client: object, open: boolean) => void;
};

/** One session per app launch; a return from 30 minutes or more in the background starts a new one unless a call is open. */
export function createNativeSession(environment: { readonly appState: NativeAppState; readonly now: () => number }): NativeSession {
  let id = newSessionId();
  let backgroundedAt: number | undefined;
  const openCalls = new Set<object>();
  environment.appState.addEventListener("change", (state) => {
    if (state === "background") {
      backgroundedAt ??= environment.now();
      return;
    }
    if (state !== "active" || backgroundedAt === undefined) return;
    if (openCalls.size === 0 && environment.now() - backgroundedAt >= NATIVE_SESSION_BACKGROUND_MS) id = newSessionId();
    backgroundedAt = undefined;
  });
  return { current: () => id, setCallOpen: (client, open) => void (open ? openCalls.add(client) : openCalls.delete(client)) };
}
