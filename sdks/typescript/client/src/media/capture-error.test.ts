import { describe, expect, it } from "vitest";
import { deviceFailedEvent } from "./capture-error";

describe("deviceFailedEvent", () => {
  it.each([
    { name: "a standard name", cause: new DOMException("m", "NotFoundError"), errorName: "NotFoundError", permission: "unknown" },
    { name: "an old browser name", cause: { name: "PermissionDeniedError" }, errorName: "NotAllowedError", permission: "denied" },
    { name: "a wrapped cause", cause: Object.assign(new Error("outer"), { cause: { name: "TrackStartError" } }), errorName: "NotReadableError", permission: "unknown" },
    { name: "a name no enum holds", cause: { name: "WeirdError" }, errorName: "unknown", permission: "unknown" },
    { name: "a value with no name", cause: "boom", errorName: "unknown", permission: "unknown" },
  ])("names the error from $name and carries nothing else", ({ cause, errorName, permission }) => {
    expect(deviceFailedEvent(cause, "camera")).toEqual({ type: "device_failed", error_name: errorName, device_kind: "camera", permission_state: permission });
  });
});
