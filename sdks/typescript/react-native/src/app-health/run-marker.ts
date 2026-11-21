import { NativeModules } from "react-native";
import type { TelemetryOutbox } from "@q9labsai/chalk-client/telemetry/outbox";

type NativeAppHealth = {
  markReady(cs: string): void;
  markFatal(errorName: string): void;
  markCallEnded(): void;
  setAppState(state: string): void;
  readMarker(): Promise<Record<string, unknown> | null>;
  readExitInfo(pid: number): Promise<{ reason: string; launched_at_ms?: number } | null>;
  lowMemory(): Promise<boolean>;
  thermalState(): Promise<string>;
};

/** The native module that owns the launch marker file and the OS exit/thermal readers. Absent where the bridge is not linked. */
const native = (): NativeAppHealth | null => (NativeModules.ChalkAppHealth as NativeAppHealth | undefined) ?? null;

export type NativeRunMarker = {
  readonly launch_id?: string;
  readonly pid?: number;
  readonly launched_at_ms?: number;
  readonly phase?: string;
  readonly js_ready?: boolean;
  readonly app_state?: string;
  readonly clean_exit?: string;
  readonly will_terminate?: boolean;
  readonly last_elapsed_ms?: number;
};

const PHASES = new Set(["launch", "boot", "joining", "live", "reconnecting"]);
const APP_STATES = new Set(["active", "inactive", "background"]);

/**
 * The once-per-launch native scan: reads the marker the previous process left, asks the OS why it exited, records
 * previous_run.read and emits client.previous_run and client.app_exit_info under the new run's credential.
 */
export async function scanNativePreviousRun(outbox: TelemetryOutbox): Promise<void> {
  const module = native();
  await outbox.obs
    .op("previous_run.read", {}, async (scope) => {
      if (module === null) {
        scope.expected("app.storage_unreadable");
        return;
      }
      const marker = (await module.readMarker().catch(() => null)) as NativeRunMarker | null;
      if (marker === null || (marker.phase === undefined && marker.launch_id === undefined)) {
        scope.expected("app.no_marker");
        return;
      }
      const phase = PHASES.has(String(marker.phase)) ? (marker.phase as "launch" | "boot" | "joining" | "live" | "reconnecting") : "boot";
      scope.set({ dead_markers: 1 });
      outbox.obs.fact("client.previous_run", {
        phase,
        js_ready: marker.js_ready === true,
        ...(marker.app_state !== undefined && APP_STATES.has(String(marker.app_state)) ? { app_state: marker.app_state as "active" | "inactive" | "background" } : {}),
        ...(typeof marker.clean_exit === "string" && (marker.clean_exit === "call_ended" || marker.clean_exit === "pagehide") ? { clean_exit: marker.clean_exit } : {}),
        ...(typeof marker.last_elapsed_ms === "number" ? { last_elapsed_ms: marker.last_elapsed_ms } : {}),
        ...(typeof marker.pid === "number" ? { pid: marker.pid } : {}),
        ...(typeof marker.launch_id === "string" ? { launch_id: marker.launch_id } : {}),
        ...(typeof marker.launched_at_ms === "number" ? { launched_at_ms: marker.launched_at_ms } : {}),
        ...(typeof marker.will_terminate === "boolean" ? { will_terminate: marker.will_terminate } : {}),
      });
      const exit = typeof marker.pid === "number" ? await module.readExitInfo(marker.pid).catch(() => null) : null;
      const reason = exit?.reason ?? "no_exit_reason";
      outbox.obs.fact("client.app_exit_info", {
        exit_reason: reason as never,
        ...(typeof marker.pid === "number" ? { pid: marker.pid } : {}),
        ...(typeof marker.launch_id === "string" ? { launch_id: marker.launch_id } : {}),
        ...(typeof exit?.launched_at_ms === "number" ? { launched_at_ms: exit.launched_at_ms } : {}),
      });
    })
    .catch(() => undefined);
}

/** Tells the marker JS is alive: marks it js_ready and stamps this run's cs. Call once when the SDK boots. */
export function markJsReady(outbox: TelemetryOutbox): void {
  native()?.markReady(outbox.clientSessionId);
}

/** What the dying JS writes last: the native marker's fatal flag, before the fatal record and flush. */
export function markFatal(errorName: string): void {
  native()?.markFatal(errorName);
}

/** The run ended cleanly by the person's hand: the marker's clean_exit, never a crash. */
export function markCallEnded(): void {
  native()?.markCallEnded();
}

/** Keeps the marker's app_state current so a background kill reads the truth. */
export function markAppState(state: string): void {
  native()?.setAppState(state);
}

/** Whether the OS says memory is low (Android lowMemory; iOS reports via memoryWarning). */
export function readLowMemory(): Promise<boolean | null> {
  return native()?.lowMemory().catch(() => null) ?? Promise.resolve(null);
}

/** The OS thermal state, or "unsupported" where the platform has no probe. */
export function readThermalState(): Promise<string> {
  return native()?.thermalState().catch(() => "unsupported") ?? Promise.resolve("unsupported");
}
