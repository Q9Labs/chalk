import { withRequestContext } from "../session";
import { postTelemetry } from "./send";
import type { PlatformChange, TelemetryPlatform } from "./types";

/** The browser side of telemetry. Only this file reads `window` and `document`, and only inside `subscribe`. */
export function createWebTelemetryPlatform(fetch?: typeof globalThis.fetch): TelemetryPlatform {
  const send = withRequestContext(fetch);
  return {
    now: () => performance.now(),
    uuid: () => {
      const random = globalThis.crypto;
      if (!random?.randomUUID) throw new TypeError("A secure browser identifier source is required");
      return random.randomUUID();
    },
    online: () => globalThis.navigator?.onLine !== false,
    hidden: () => globalThis.document?.visibilityState === "hidden",
    subscribe: subscribeBrowser,
    send: (request) => postTelemetry(send, request),
  };
}

function subscribeBrowser(listener: (change: PlatformChange) => void): () => void {
  const windowTarget = globalThis.window;
  const documentTarget = globalThis.document;
  if (!windowTarget || !documentTarget) return () => undefined;
  const online = () => listener("online");
  const offline = () => listener("offline");
  const visibility = () => listener(documentTarget.visibilityState === "hidden" ? "hidden" : "visible");
  const closing = () => listener("closing");
  windowTarget.addEventListener("online", online);
  windowTarget.addEventListener("offline", offline);
  windowTarget.addEventListener("pagehide", closing);
  documentTarget.addEventListener("visibilitychange", visibility);
  return () => {
    windowTarget.removeEventListener("online", online);
    windowTarget.removeEventListener("offline", offline);
    windowTarget.removeEventListener("pagehide", closing);
    documentTarget.removeEventListener("visibilitychange", visibility);
  };
}
