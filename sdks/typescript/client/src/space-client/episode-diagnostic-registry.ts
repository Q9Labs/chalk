import type { ConnectionLifecycleCapability } from "../connection/lifecycle";
import type { ConnectionDependencies, ConnectionSyncClient } from "../connection/dependencies";
import type { EpisodeDiagnosticRuntime } from "./episode-diagnostic-runtime";

const connectionDiagnostics = new WeakMap<object, EpisodeDiagnosticRuntime>();
const dependencyDiagnostics = new WeakMap<object, EpisodeDiagnosticRuntime>();
const syncDiagnostics = new WeakMap<object, EpisodeDiagnosticRuntime>();

export function registerEpisodeDiagnosticConnection(connection: ConnectionLifecycleCapability, diagnostics: EpisodeDiagnosticRuntime): void {
  connectionDiagnostics.set(connection, diagnostics);
}

export function episodeDiagnosticsForConnection(connection: ConnectionLifecycleCapability): EpisodeDiagnosticRuntime | undefined {
  return connectionDiagnostics.get(connection);
}

export function unregisterEpisodeDiagnosticConnection(connection: ConnectionLifecycleCapability, diagnostics?: EpisodeDiagnosticRuntime): void {
  if (diagnostics === undefined || connectionDiagnostics.get(connection) === diagnostics) connectionDiagnostics.delete(connection);
}

export function registerEpisodeDiagnosticDependencies(dependencies: ConnectionDependencies, diagnostics: EpisodeDiagnosticRuntime): void {
  dependencyDiagnostics.set(dependencies, diagnostics);
}

export function episodeDiagnosticsForDependencies(dependencies: ConnectionDependencies): EpisodeDiagnosticRuntime | undefined {
  return dependencyDiagnostics.get(dependencies);
}

export function unregisterEpisodeDiagnosticDependencies(dependencies: ConnectionDependencies, diagnostics?: EpisodeDiagnosticRuntime): void {
  if (diagnostics === undefined || dependencyDiagnostics.get(dependencies) === diagnostics) dependencyDiagnostics.delete(dependencies);
}

export function registerEpisodeDiagnosticSyncClient<T extends ConnectionSyncClient>(client: T, diagnostics: EpisodeDiagnosticRuntime): T {
  syncDiagnostics.set(client, diagnostics);
  return client;
}

export function episodeDiagnosticsForSyncClient(client: object): EpisodeDiagnosticRuntime | undefined {
  return syncDiagnostics.get(client);
}

export function unregisterEpisodeDiagnosticSyncClient(client: object, diagnostics?: EpisodeDiagnosticRuntime): void {
  if (diagnostics === undefined || syncDiagnostics.get(client) === diagnostics) syncDiagnostics.delete(client);
}
