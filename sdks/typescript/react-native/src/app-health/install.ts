import { AppState } from "react-native";
import type { TelemetryOutbox } from "@q9labsai/chalk-client/telemetry/outbox";
import { installGlobalHandler } from "./global-handler";
import { startNativeProbes } from "./probes";
import { markJsReady, scanNativePreviousRun } from "./run-marker";

/**
 * The native app's health wiring, installed once when the SDK's telemetry is created: marks the launch marker js_ready,
 * reports the dead previous run and its OS exit reason, wraps the global JS handler, and keeps the heartbeat and probes.
 */
export function installAppHealth(outbox: TelemetryOutbox): () => void {
  markJsReady(outbox);
  void scanNativePreviousRun(outbox);
  installGlobalHandler(outbox, () => (AppState.currentState === "active" ? "active" : AppState.currentState === "inactive" ? "inactive" : "background"));
  return startNativeProbes(outbox);
}
