import type { ConnectionSlice } from "@q9labsai/chalk-client";
import type { DeviceInfo } from "./runtime";

export type ConnectionDiagnosticsSnapshot = Pick<ConnectionSlice, "status" | "lastError">;

export type DevDiagnosticsOutcome = "error" | "observed" | "success";

export interface DevDiagnosticsTimelineEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly eventType: string;
  readonly outcome: DevDiagnosticsOutcome;
  readonly title: string;
  readonly detail?: string;
}

export interface DevDiagnosticsState {
  readonly enabled: boolean;
  readonly environment: {
    readonly apiBaseURL: string | null;
    readonly buildProfile: string | null;
    readonly target: "custom" | "local" | "production" | "unknown";
    readonly routeKind: string | null;
    readonly routeSpaceId: string | null;
    readonly routeSource: string | null;
  };
  readonly device: DeviceInfo | null;
  readonly connection: ConnectionDiagnosticsSnapshot | null;
  readonly lastFailure: {
    readonly source: string;
    readonly message: string;
    readonly occurredAt: string;
  } | null;
  readonly timeline: readonly DevDiagnosticsTimelineEntry[];
}

const runtimeEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const isDevelopmentRuntime = typeof __DEV__ !== "undefined" ? __DEV__ : runtimeEnv?.VITEST === "true" || runtimeEnv?.NODE_ENV !== "production";
const maximumTimelineItems = 120;
const listeners = new Set<() => void>();
let state = initialState();

export function classifyTarget(apiBaseURL: string | null | undefined): DevDiagnosticsState["environment"]["target"] {
  if (!apiBaseURL) return "unknown";
  try {
    const hostname = new URL(apiBaseURL).hostname;
    if (["localhost", "127.0.0.1", "0.0.0.0"].includes(hostname)) return "local";
    if (hostname === "chalkmeet.com" || hostname.endsWith(".chalkmeet.com")) return "production";
    return "custom";
  } catch {
    return "unknown";
  }
}

export function resolveDevDiagnosticsMode({ isDevRuntime, apiBaseURL }: { readonly isDevRuntime: boolean; readonly apiBaseURL: string | null | undefined }): {
  readonly enabled: boolean;
  readonly buildProfile: "development" | "production";
} {
  return {
    enabled: isDevRuntime,
    buildProfile: isDevRuntime || classifyTarget(apiBaseURL) === "local" ? "development" : "production",
  };
}

export function subscribeDevDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDevDiagnosticsState(): DevDiagnosticsState {
  return state;
}

export function setDevDiagnosticsEnvironment(next: Partial<DevDiagnosticsState["environment"]>): void {
  update((current) => ({
    ...current,
    environment: {
      ...current.environment,
      ...next,
      target: next.apiBaseURL ? classifyTarget(next.apiBaseURL) : current.environment.target,
    },
  }));
}

export function setDevDiagnosticsDevice(device: DeviceInfo | null): void {
  update((current) => ({
    ...current,
    device,
  }));
}

export function setDevDiagnosticsConnection(snapshot: ConnectionDiagnosticsSnapshot | null): void {
  const previous = state.connection;
  update((current) => ({ ...current, connection: snapshot }));
  if (snapshot && snapshot.status !== previous?.status) {
    appendTimeline({
      eventType: "connection.state",
      outcome: snapshot.lastError ? "error" : "observed",
      title: snapshot.status,
      ...(snapshot.lastError?.message ? { detail: snapshot.lastError.message } : {}),
    });
  }
}

export function recordDevDiagnosticsLifecycleEvent(eventType: string, title: string, detail?: string): void {
  appendTimeline({ eventType, title, outcome: "observed", ...(detail ? { detail } : {}) });
}

export function recordDiagnosticsFailure(source: string, message: string): void {
  const occurredAt = new Date().toISOString();
  update((current) => ({
    ...current,
    lastFailure: { source, message, occurredAt },
  }));
  appendTimeline({
    eventType: source,
    outcome: "error",
    title: source.replaceAll("-", " "),
    detail: message,
    timestamp: occurredAt,
  });
}

export function clearDevDiagnosticsLogs(): void {
  update((current) => ({ ...current, lastFailure: null, timeline: [] }));
}

export function resetDevDiagnosticsState(): void {
  state = initialState();
  emit();
}

export function buildDevDiagnosticsCopyText(): string {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      ...state,
    },
    null,
    2,
  );
}

function initialState(): DevDiagnosticsState {
  return {
    enabled: isDevelopmentRuntime,
    environment: {
      apiBaseURL: null,
      buildProfile: null,
      target: "unknown",
      routeKind: null,
      routeSpaceId: null,
      routeSource: null,
    },
    device: null,
    connection: null,
    lastFailure: null,
    timeline: [],
  };
}

function appendTimeline(
  input: Omit<DevDiagnosticsTimelineEntry, "id" | "timestamp"> & {
    readonly timestamp?: string;
  },
): void {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const entry: DevDiagnosticsTimelineEntry = {
    ...input,
    id: `${input.eventType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp,
  };
  update((current) => ({
    ...current,
    timeline: [entry, ...current.timeline].slice(0, maximumTimelineItems),
  }));
}

function update(updater: (current: DevDiagnosticsState) => DevDiagnosticsState): void {
  if (!isDevelopmentRuntime) return;
  state = updater(state);
  emit();
}

function emit(): void {
  for (const listener of listeners) listener();
}
