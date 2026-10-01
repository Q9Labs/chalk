import type { DiagnosticObservation } from "./journey";
import type { TelemetryAttributes } from "./types";

export type ReconnectRecorder = (observation: DiagnosticObservation) => void;

/** Observations must never change transport or recovery outcomes. */
function recordObservation(recorder: ReconnectRecorder | undefined, observation: DiagnosticObservation): void {
  if (!recorder) return;
  try {
    recorder(observation);
  } catch {
    // A telemetry consumer failure cannot interrupt collaboration.
  }
}

export function recordReconnect(recorder: ReconnectRecorder | undefined, step: string, attributes?: TelemetryAttributes, state: "observed" | "succeeded" | "failed" = "observed"): void {
  recordObservation(recorder, { category: "recovery", code: `reconnect.${step}`, phase: "recovery", state, attributes });
}

export function recordInitialConnection(recorder: ReconnectRecorder | undefined, step: string, attributes?: TelemetryAttributes, state: "observed" | "succeeded" | "failed" = "observed"): void {
  recordObservation(recorder, { category: "connection", code: `connection.initial.${step}`, phase: "signaling", state, attributes });
}

export async function traceReconnect<A>(recorder: ReconnectRecorder | undefined, step: string, operation: () => Promise<A>): Promise<A> {
  if (!recorder) return operation();
  const start = performance.now();
  recordReconnect(recorder, step, { boundary: "start" });
  try {
    const result = await operation();
    recordReconnect(recorder, step, { boundary: "end", duration_ms: performance.now() - start }, "succeeded");
    return result;
  } catch (error) {
    recordReconnect(recorder, step, { boundary: "end", duration_ms: performance.now() - start }, "failed");
    throw error;
  }
}
