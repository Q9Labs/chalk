import { describe, expect, it } from "vitest";
import { ConnectionLifecycleFailure as LifecycleFailureImplementation, ConnectionLifecycleService as LifecycleServiceImplementation, makeConnectionLifecycleLayer as makeLifecycleLayerImplementation, makeFakeConnectionLifecycleLayer as makeFakeLifecycleLayerImplementation } from "./lifecycle";
import { ConnectionLifecycleFailure, ConnectionLifecycleService, makeConnectionLifecycleLayer, makeFakeConnectionLifecycleLayer } from ".";

describe("Connection lifecycle contract", () => {
  it("re-exports the single lifecycle service and layer implementations", () => {
    expect(ConnectionLifecycleService).toBe(LifecycleServiceImplementation);
    expect(makeConnectionLifecycleLayer).toBe(makeLifecycleLayerImplementation);
    expect(makeFakeConnectionLifecycleLayer).toBe(makeFakeLifecycleLayerImplementation);

    const failure = new ConnectionLifecycleFailure({ code: "command_rejected", recoverable: false, message: "rejected" });
    expect(failure).toBeInstanceOf(LifecycleFailureImplementation);
    expect(failure.code).toBe("command_rejected");
  });
});
