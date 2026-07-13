import { describe, expect, it } from "vitest";
import { SyncBrowserCapabilityError, SyncReactNativeCapabilityError } from "./errors";

describe("sync errors", () => {
  it("exposes stable names and public messages", () => {
    const errors = [new SyncBrowserCapabilityError("WebSocket"), new SyncReactNativeCapabilityError("WebSocket")];

    expect(errors.map((error) => error.name)).toEqual(["SyncBrowserCapabilityError", "SyncReactNativeCapabilityError"]);
    expect(errors.map((error) => error.message)).toEqual(["WebSocket is unavailable in this runtime", "React Native WebSocket is unavailable in this runtime"]);
  });
});
