import type { AccessSubject } from "../access/grant";
import type { ConnectionDiagnostic } from "./diagnostics";
import type { ConnectionAccessProvider, ConnectionDependencies, ConnectionMediaClient, ConnectionSyncClient } from "./dependencies";
import type { ConnectionConnectionPhase, ConnectionFailure, ConnectionState } from "./types";
import type { JourneyTelemetryContext } from "../telemetry/types";

/** Public lifecycle data contracts. Runtime ownership lives in ConnectionLifecycleService. */
export type ConnectionLifecycleSnapshot = {
  readonly state: ConnectionState;
  readonly subject: AccessSubject | null;
  readonly episode: { readonly id: string; readonly startedAt: string | null; readonly deadline: string | null } | null;
  readonly connection: { readonly sync: ConnectionConnectionPhase; readonly media: ConnectionConnectionPhase };
  readonly failure: ConnectionFailure | null;
};

export type ConnectionPorts = { readonly sync: ConnectionSyncClient; readonly media: ConnectionMediaClient };

export type ConnectionOptions = {
  readonly access: ConnectionAccessProvider;
  readonly syncURL: string;
  readonly apiBaseURL: string;
  readonly syncStartupTimeoutMs?: number;
  readonly initialMicrophoneEnabled?: boolean;
  readonly initialCameraEnabled?: boolean;
  readonly telemetry?: JourneyTelemetryContext;
  readonly accessRefreshWindowMs?: number;
  readonly recovery?: { readonly maxAttempts?: number; readonly budgetMs?: number; readonly backoffMs?: readonly number[] };
  readonly diagnostics?: { readonly limit?: number; readonly onEvent?: (event: ConnectionDiagnostic) => void };
  readonly dependencies?: Partial<ConnectionDependencies>;
};

export { ConnectionLifecycleFailure, ConnectionLifecycleService, makeConnectionLifecycleLayer, makeFakeConnectionLifecycleLayer } from "./lifecycle";
export type { ConnectionLifecycleCapability } from "./lifecycle";
