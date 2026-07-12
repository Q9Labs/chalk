import { describe, expect, it } from "vitest";
import { SyncBrowserCapabilityError, SyncCapacityError, SyncCommandValidationError, SyncPendingExpiredError, SyncPersistenceError, SyncReactNativeCapabilityError } from "./errors";

describe("sync errors", () => {
  it("exposes stable names and public messages", () => {
    const errors = [new SyncCapacityError("bytes"), new SyncPendingExpiredError(), new SyncCommandValidationError("unsupported command"), new SyncPersistenceError("storage failed"), new SyncBrowserCapabilityError("IndexedDB"), new SyncReactNativeCapabilityError("WebSocket")];

    expect(errors.map((error) => error.name)).toEqual(["SyncCapacityError", "SyncPendingExpiredError", "SyncCommandValidationError", "SyncPersistenceError", "SyncBrowserCapabilityError", "SyncReactNativeCapabilityError"]);
    expect(errors.map((error) => error.message)).toEqual(["pending command bytes limit reached", "pending command has exceeded its maximum age", "unsupported command", "storage failed", "IndexedDB is unavailable in this runtime", "React Native WebSocket is unavailable in this runtime"]);
  });
});
