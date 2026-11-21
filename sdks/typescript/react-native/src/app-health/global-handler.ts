import type { TelemetryOutbox } from "@q9labsai/chalk-client/telemetry/outbox";
import { errorClass, errorFingerprint, errorName } from "@q9labsai/chalk-client/telemetry/app";
import type { NativeAppHealth } from "./run-marker";

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;

type ErrorUtilsLike = { getGlobalHandler?: () => GlobalHandler; setGlobalHandler?: (handler: GlobalHandler) => void };

/**
 * React Native's global error handler, wrapped once: on a fatal JS error it writes the native marker FIRST (synchronous,
 * so an immediate death keeps it), then records client.app_js_fatal and flushes, then runs the previous handler.
 */
export function installGlobalHandler(outbox: TelemetryOutbox, health: NativeAppHealth | null, appState: () => "active" | "inactive" | "background", utils?: ErrorUtilsLike): void {
  const errorUtils = utils ?? (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  const previous = errorUtils?.getGlobalHandler?.() ?? (() => undefined);
  errorUtils?.setGlobalHandler?.((error: unknown, isFatal?: boolean) => {
    if (isFatal !== false) {
      const name = errorName(error);
      health?.markFatal(name === "none" ? "other" : name);
      const send = (fingerprint?: string) => {
        outbox.obs.fact("client.app_js_fatal", {
          error_name: name,
          error_class: errorClass(error),
          ...(fingerprint === undefined ? {} : { error_fingerprint: fingerprint }),
          app_state: appState(),
        });
        void outbox.flush();
      };
      // The marker is already safe, so the fingerprint may take a microtask; a process that dies before it keeps the marker.
      void errorFingerprint(error).then(send, () => send());
    }
    previous(error, isFatal);
  });
}
