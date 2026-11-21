import type { TelemetryOutbox } from "@q9labsai/chalk-client/telemetry/outbox";

/** The native module's surface, injected so tests drive the scan without react-native. */
export type NativeAppHealth = {
  markReady(cs: string): void;
  markFatal(errorName: string): void;
  markCallEnded(): void;
  setAppState(state: string): void;
  readMarker(): Promise<Record<string, unknown> | null>;
  readExitInfo(pid: number): Promise<{ reason: string; launched_at_ms?: number } | null>;
  lowMemory(): Promise<boolean>;
  thermalState(): Promise<string>;
};

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
const EXIT_REASONS = new Set(["REASON_USER_REQUESTED", "REASON_USER_STOPPED", "REASON_CRASH", "REASON_CRASH_NATIVE", "REASON_ANR", "REASON_LOW_MEMORY", "REASON_SIGNALED", "REASON_EXCESSIVE_RESOURCE_USAGE", "REASON_FREEZER", "REASON_OTHER", "REASON_INITIALIZATION_FAILURE", "REASON_PERMISSION_CHANGE", "REASON_DEPENDENCY_DIED", "REASON_EXIT_SELF", "REASON_STATE_CHANGE", "REASON_SYSTEM_STATE_CHANGE", "REASON_UNKNOWN", "MX_CRASH", "no_record", "no_exit_reason", "unsupported"]);

/**
 * The once-per-launch native scan: reads the marker the previous process left, asks the OS why it exited, records
 * previous_run.read and emits client.previous_run and client.app_exit_info under the new run's credential.
 */
export async function scanNativePreviousRun(outbox: TelemetryOutbox, health: NativeAppHealth | null): Promise<void> {
  await outbox.obs
    .op("previous_run.read", {}, async (scope) => {
      if (health === null) {
        scope.expected("app.storage_unreadable");
        return;
      }
      const marker = (await health.readMarker().catch(() => null)) as NativeRunMarker | null;
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
      const exit = typeof marker.pid === "number" ? await health.readExitInfo(marker.pid).catch(() => null) : null;
      const reason = typeof exit?.reason === "string" && EXIT_REASONS.has(exit.reason) ? exit.reason : "no_exit_reason";
      outbox.obs.fact("client.app_exit_info", {
        exit_reason: reason as never,
        ...(typeof marker.pid === "number" ? { pid: marker.pid } : {}),
        ...(typeof marker.launch_id === "string" ? { launch_id: marker.launch_id } : {}),
        ...(typeof exit?.launched_at_ms === "number" ? { launched_at_ms: exit.launched_at_ms } : {}),
      });
    })
    .catch(() => undefined);
}
