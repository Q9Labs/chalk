import type { NativeVideoConferenceDiagnosticsSnapshot } from "./components/NativeVideoConference";
import type { NativeDeviceInfo } from "./runtime";

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
    readonly buildProfile: string | null;
    readonly brokerUrl: string | null;
    readonly target: "custom" | "local" | "production" | "unknown";
    readonly routeKind: string | null;
    readonly routeRoomId: string | null;
    readonly routeSource: string | null;
  };
  readonly clientSession: {
    readonly inviteTokenPreview: string | null;
  };
  readonly device: NativeDeviceInfo | null;
  readonly session: NativeVideoConferenceDiagnosticsSnapshot | null;
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

export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 10) return `${value.slice(0, 2)}…${value.slice(-2)}`;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function classifyTarget(brokerUrl: string | null | undefined): DevDiagnosticsState["environment"]["target"] {
  if (!brokerUrl) return "unknown";
  try {
    const hostname = new URL(brokerUrl).hostname;
    if (["localhost", "127.0.0.1", "0.0.0.0"].includes(hostname)) return "local";
    if (hostname === "chalkmeet.com" || hostname.endsWith(".chalkmeet.com")) return "production";
    return "custom";
  } catch {
    return "unknown";
  }
}

export function resolveDevDiagnosticsMode({ isDevRuntime, brokerUrl }: { readonly isDevRuntime: boolean; readonly brokerUrl: string | null | undefined }): {
  readonly enabled: boolean;
  readonly buildProfile: "development" | "production";
} {
  return {
    enabled: isDevRuntime,
    buildProfile: isDevRuntime || classifyTarget(brokerUrl) === "local" ? "development" : "production",
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
      target: next.brokerUrl ? classifyTarget(next.brokerUrl) : current.environment.target,
    },
  }));
}

export function setDevDiagnosticsClientSession(next: { readonly inviteTokenPreview?: string | null; readonly device?: NativeDeviceInfo | null }): void {
  update((current) => ({
    ...current,
    clientSession: {
      inviteTokenPreview: next.inviteTokenPreview === undefined ? current.clientSession.inviteTokenPreview : next.inviteTokenPreview,
    },
    device: next.device === undefined ? current.device : next.device,
  }));
}

export function setDevDiagnosticsSession(snapshot: NativeVideoConferenceDiagnosticsSnapshot | null): void {
  const previous = state.session;
  update((current) => ({ ...current, session: snapshot }));
  if (snapshot && (snapshot.phase !== previous?.phase || snapshot.connectionStatus !== previous?.connectionStatus)) {
    appendTimeline({
      eventType: "session.state",
      outcome: snapshot.session.failure ? "error" : "observed",
      title: `${snapshot.phase} · ${snapshot.connectionStatus}`,
      ...(snapshot.session.failure?.message ? { detail: snapshot.session.failure.message } : {}),
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
      buildProfile: null,
      brokerUrl: null,
      target: "unknown",
      routeKind: null,
      routeRoomId: null,
      routeSource: null,
    },
    clientSession: { inviteTokenPreview: null },
    device: null,
    session: null,
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
