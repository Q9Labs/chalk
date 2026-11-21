import type { TelemetryOutbox } from "./outbox";

type PressureObserverLike = { observe(source: string): Promise<void>; disconnect(): void };

type PressureRecord = { readonly state: string };

/** The OS or browser pressure probe's reported states, mapped onto the registry enum. */
const CPU_PRESSURE_STATES = new Set(["nominal", "fair", "serious", "critical"]);

/**
 * The web CPU-pressure probe: PressureObserver("cpu") where the browser has one, emitting its current state once at start
 * and on every change. Without the probe it emits probe_state=unsupported once, which is itself evidence — never absence.
 */
export function startCpuPressureProbe(outbox: TelemetryOutbox, options: { visibility?: () => "visible" | "hidden" } = {}): () => void {
  const Observer = (globalThis as { PressureObserver?: new (callback: (records: PressureRecord[]) => void) => PressureObserverLike }).PressureObserver;
  const visibility = () => options.visibility?.();
  if (Observer === undefined) {
    outbox.obs.fact("client.thermal_changed", { probe_state: "unsupported", cpu_pressure: "unsupported", ...(visibility() === undefined ? {} : { visibility: visibility() }) });
    return () => undefined;
  }
  let last: string | undefined;
  const observer = new Observer((records) => {
    const state = records.at(-1)?.state;
    const pressure = state !== undefined && CPU_PRESSURE_STATES.has(state) ? (state as "nominal" | "fair" | "serious" | "critical") : undefined;
    if (pressure === undefined || pressure === last) return;
    last = pressure;
    outbox.obs.fact("client.thermal_changed", { probe_state: "measured", cpu_pressure: pressure, ...(visibility() === undefined ? {} : { visibility: visibility() }) });
  });
  void observer.observe("cpu").catch(() => {
    if (last === undefined) {
      last = "unsupported";
      outbox.obs.fact("client.thermal_changed", { probe_state: "unsupported", cpu_pressure: "unsupported", ...(visibility() === undefined ? {} : { visibility: visibility() }) });
    }
  });
  return () => observer.disconnect();
}
