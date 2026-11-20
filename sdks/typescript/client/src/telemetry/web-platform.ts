import { withRequestContext } from "../session";
import { postTelemetry } from "./send";
import type { PlatformChange, TelemetryJournal, TelemetryPlatform } from "./types";

const JOURNAL_PREFIX = "chalk.telemetry.";

type JournalStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;

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
    journal: createSessionJournal(),
  };
}

/** The journal of one tab: `sessionStorage` survives a reload of the tab and is invisible to other tabs. Storage can throw (quota, blocked), and then the journal is empty and keeps nothing. */
export function createSessionJournal(storage: () => JournalStorage | undefined = () => globalThis.sessionStorage): TelemetryJournal {
  const guarded = <T>(fallback: T, run: (store: JournalStorage) => T): T => {
    try {
      const store = storage();
      return store ? run(store) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    list: () => guarded([], (store) => Array.from({ length: store.length }, (_, index) => store.key(index)).flatMap((key) => (key?.startsWith(JOURNAL_PREFIX) ? [key.slice(JOURNAL_PREFIX.length)] : []))),
    load: (sourceId) => guarded(null, (store) => store.getItem(JOURNAL_PREFIX + sourceId)),
    save: (sourceId, text) =>
      guarded(false, (store) => {
        store.setItem(JOURNAL_PREFIX + sourceId, text);
        return true;
      }),
    remove: (sourceId) => guarded(undefined, (store) => store.removeItem(JOURNAL_PREFIX + sourceId)),
  };
}

function subscribeBrowser(listener: (change: PlatformChange) => void): () => void {
  const windowTarget = globalThis.window;
  const documentTarget = globalThis.document;
  if (!windowTarget || !documentTarget) return () => undefined;
  const online = () => listener("online");
  const offline = () => listener("offline");
  const visibility = () => listener(documentTarget.visibilityState === "hidden" ? "hidden" : "visible");
  const freeze = () => listener("frozen");
  const resume = () => listener("resumed");
  const closing = () => listener("closing");
  windowTarget.addEventListener("online", online);
  windowTarget.addEventListener("offline", offline);
  windowTarget.addEventListener("pagehide", closing);
  documentTarget.addEventListener("visibilitychange", visibility);
  documentTarget.addEventListener("freeze", freeze);
  documentTarget.addEventListener("resume", resume);
  return () => {
    windowTarget.removeEventListener("online", online);
    windowTarget.removeEventListener("offline", offline);
    windowTarget.removeEventListener("pagehide", closing);
    documentTarget.removeEventListener("visibilitychange", visibility);
    documentTarget.removeEventListener("freeze", freeze);
    documentTarget.removeEventListener("resume", resume);
  };
}
