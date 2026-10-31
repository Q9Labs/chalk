import { newSessionId } from "@q9labsai/chalk-client";

/** A session ends after this long in the background, but never while a call is open. */
export const NATIVE_SESSION_BACKGROUND_MS = 30 * 60 * 1000;

type NativeAppState = {
  readonly addEventListener: (type: "change", listener: (state: string) => void) => unknown;
};

export type NativeSession = {
  readonly current: () => string;
  readonly setCallOpen: (open: boolean) => void;
};

/** One session per app launch; a return from 30 minutes or more in the background starts a new one unless a call is open. */
export function createNativeSession(environment: { readonly appState: NativeAppState; readonly now: () => number }): NativeSession {
  let id = newSessionId();
  let backgroundedAt: number | undefined;
  let callOpen = false;
  environment.appState.addEventListener("change", (state) => {
    if (state === "background") {
      backgroundedAt ??= environment.now();
      return;
    }
    if (state !== "active" || backgroundedAt === undefined) return;
    if (!callOpen && environment.now() - backgroundedAt >= NATIVE_SESSION_BACKGROUND_MS) id = newSessionId();
    backgroundedAt = undefined;
  });
  return { current: () => id, setCallOpen: (open) => void (callOpen = open) };
}
