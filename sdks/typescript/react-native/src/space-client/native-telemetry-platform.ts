import { postTelemetry, withRequestContext, type PlatformChange, type TelemetryPlatform } from "@q9labsai/chalk-client";

type NativeAppState = {
  readonly currentState: string;
  readonly addEventListener: (type: "change", listener: (state: string) => void) => { readonly remove: () => void };
};

/**
 * The React Native side of telemetry. The app has no reachability source, so the outbox learns the network is down from failed sends and backs off.
 * `window` is not used: Hermes defines `window` without `addEventListener`, and the outbox needs only AppState.
 * It has no `journal`, so nothing survives an app kill: the records still queued are lost, and the server sees an unknown tail for the source. A journal can be added through the same `TelemetryJournal` port.
 */
export function createNativeTelemetryPlatform(environment: { readonly appState: NativeAppState; readonly fetch: typeof globalThis.fetch }): TelemetryPlatform {
  const send = withRequestContext(environment.fetch);
  return {
    now: () => performance.now(),
    uuid: () => globalThis.crypto.randomUUID(),
    online: () => true,
    hidden: () => environment.appState.currentState === "background",
    subscribe: (listener) => {
      const subscription = environment.appState.addEventListener("change", (state) => {
        const change = appStateChange(state);
        if (change) listener(change);
      });
      return () => subscription.remove();
    },
    send: (request) => postTelemetry(send, request),
  };
}

/** `inactive` is the app switcher or a call sheet, which still draws: it is not a move to the background. */
function appStateChange(state: string): PlatformChange | null {
  if (state === "background") return "background";
  return state === "active" ? "foreground" : null;
}
