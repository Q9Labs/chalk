import { describe, expect, it } from "vitest";
import {
  episodeDiagnosticsForConnection,
  episodeDiagnosticsForDependencies,
  episodeDiagnosticsForSyncClient,
  registerEpisodeDiagnosticConnection,
  registerEpisodeDiagnosticDependencies,
  registerEpisodeDiagnosticSyncClient,
  unregisterEpisodeDiagnosticConnection,
  unregisterEpisodeDiagnosticDependencies,
  unregisterEpisodeDiagnosticSyncClient,
} from "./episode-diagnostic-registry";

type Connection = Parameters<typeof registerEpisodeDiagnosticConnection>[0];
type Dependencies = Parameters<typeof registerEpisodeDiagnosticDependencies>[0];
type SyncClient = Parameters<typeof registerEpisodeDiagnosticSyncClient>[0];
type Diagnostics = Parameters<typeof registerEpisodeDiagnosticConnection>[1];

describe("episode diagnostic registry", () => {
  it("keeps connection, dependency, and sync registrations independent", () => {
    const connection = objectAs<Connection>();
    const dependencies = objectAs<Dependencies>();
    const syncClient = objectAs<SyncClient>();
    const diagnostics = objectAs<Diagnostics>();

    registerEpisodeDiagnosticConnection(connection, diagnostics);
    registerEpisodeDiagnosticDependencies(dependencies, diagnostics);
    expect(registerEpisodeDiagnosticSyncClient(syncClient, diagnostics)).toBe(syncClient);

    expect(episodeDiagnosticsForConnection(connection)).toBe(diagnostics);
    expect(episodeDiagnosticsForDependencies(dependencies)).toBe(diagnostics);
    expect(episodeDiagnosticsForSyncClient(syncClient)).toBe(diagnostics);
  });

  it("replaces a matching registration without exposing it to another object", () => {
    const connection = objectAs<Connection>();
    const otherConnection = objectAs<Connection>();
    const first = objectAs<Diagnostics>();
    const second = objectAs<Diagnostics>();

    registerEpisodeDiagnosticConnection(connection, first);
    registerEpisodeDiagnosticConnection(connection, second);

    expect(episodeDiagnosticsForConnection(connection)).toBe(second);
    expect(episodeDiagnosticsForConnection(otherConnection)).toBeUndefined();
  });

  it("removes only the owner registration during scope teardown", () => {
    const connection = objectAs<Connection>();
    const dependencies = objectAs<Dependencies>();
    const syncClient = objectAs<SyncClient>();
    const first = objectAs<Diagnostics>();
    const second = objectAs<Diagnostics>();

    registerEpisodeDiagnosticConnection(connection, first);
    registerEpisodeDiagnosticConnection(connection, second);
    registerEpisodeDiagnosticDependencies(dependencies, first);
    registerEpisodeDiagnosticSyncClient(syncClient, first);

    unregisterEpisodeDiagnosticConnection(connection, first);
    expect(episodeDiagnosticsForConnection(connection)).toBe(second);
    unregisterEpisodeDiagnosticConnection(connection, second);
    unregisterEpisodeDiagnosticDependencies(dependencies, first);
    unregisterEpisodeDiagnosticSyncClient(syncClient, first);

    expect(episodeDiagnosticsForConnection(connection)).toBeUndefined();
    expect(episodeDiagnosticsForDependencies(dependencies)).toBeUndefined();
    expect(episodeDiagnosticsForSyncClient(syncClient)).toBeUndefined();
  });
});

function objectAs<T>(): T {
  return {} as T;
}
