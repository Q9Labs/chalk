import { AppState, NativeModules } from "react-native";
import type { TelemetryOutbox } from "@q9labsai/chalk-client/telemetry/outbox";
import { installGlobalHandler } from "./global-handler";
import { startNativeProbes } from "./probes";
import { scanNativePreviousRun, type NativeAppHealth } from "./run-marker";

const appStateNow = (): "active" | "inactive" | "background" => (AppState.currentState === "active" ? "active" : AppState.currentState === "inactive" ? "inactive" : "background");

/**
 * The native app's health wiring, installed once when the SDK's telemetry is created: marks the launch marker js_ready,
 * reports the dead previous run and its OS exit reason, wraps the global JS handler, and keeps the heartbeat and probes.
 */
export function installAppHealth(outbox: TelemetryOutbox): () => void {
  const health = (NativeModules.ChalkAppHealth as NativeAppHealth | undefined) ?? null;
  health?.markReady(outbox.clientSessionId);
  void scanNativePreviousRun(outbox, health);
  installGlobalHandler(outbox, health, appStateNow);
  return startNativeProbes(outbox, health, AppState, appStateNow);
}
